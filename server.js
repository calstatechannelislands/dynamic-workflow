/*
Copyright 2019 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

// Express, Async, Fetch, & Body Parser
const express = require('express');
const async = require('express-async-await');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');

// Form Data, Multer, & Uploads
const FormData = require('form-data');
const fs = require('fs');
const multer  = require('multer');
const upload = multer({ dest: 'uploads/' });

// HTTPS & Path
const path = require('path');

// js-yaml
const yaml = require('js-yaml');
const config = yaml.safeLoad(fs.readFileSync(path.join(__dirname, 'config', 'config.yaml'), 'utf-8'));

// Main App
const app = express();

// Configuration
var host = config.server.host.replace(/\/$/, '');
var endpoint = config.server.endpoint;
var url = host + endpoint;
var port = process.env.PORT || config.port || 80;

var integration_key = null;
// Configuration
if ('enterprise' in config && config.enterprise && 'integration' in config.enterprise && config.enterprise.integration) {
  integration_key = config.enterprise.integration;
} else {
  integration_key = process.env.INTEGRATION_KEY;
}

function checkMultiKeys(obj) {
   return Object.keys(obj).includes("esignadmin");
}

function getIntegrationKey(req) {
	var integrationKey = null;
	if(checkMultiKeys(integration_key)){
		integrationKey = integration_key[req.header("workflow-service-user")];
	} else{
		integrationKey = integration_key;
	}
    return integrationKey;
}

function getHeader(req){
  //'Authorization': 'Bearer '+ integration_key,
  var headers = {
	  'Authorization': 'Bearer '+ getIntegrationKey(req),
	  'Accept': 'application/json',
	  'Content-Type': 'application/json'
  }
   if (config['features']['x-api-user']) {
	  headers['x-api-user'] = config['features']['x-api-user'];
   }
   return headers;
}


let emailRegex = config['features']['email_regex'];
let emailErrorMessage = config['features']['email_error_message'];

app.use(express.static(__dirname + '/static'));
app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(bodyParser.json());

// Get features from config files
app.get('/features', function (req, res) {
  res.json(config['features']);
});

// Get index.html page from server
app.get('/', function (req, res) {
	if(checkMultiKeys(integration_key)){
		res.sendFile(__dirname + '/static/router.html');
	} else {
		res.sendFile(__dirname + '/static/views/index.html');
	}
});


// GET /workflows
app.get('/api/getWorkflows', async function (req, res, next) {

    console.log("Route matches '/api/getWorkflows'");
    //console.log(req);
    //console.log(req.header);
    //console.log(JSON.stringify(req.headers));
    console.log(req.header("workflow-service-user"));

    var workflow_service_user = req.header("workflow-service-user");
  
  function getWorkflows() {
    /***
     * This function makes a request to get workflows
     */
    const endpoint = '/workflows';
	return fetch(url + endpoint, {
      method: 'GET',
      headers: getHeader(req)
    });
  }

  const workflow_list = await getWorkflows();
  const data = await workflow_list.json();
  
  res.json(data['userWorkflowList']);
});

// GET /workflows/{workflowId}
app.get('/api/getWorkflowById/:id', async function (req, res,next) {

  function getWorkflowById() {
    /***
     * This function makes a request to get workflow by ID
     */
    const endpoint = '/workflows/' + req.params.id;

    return fetch(url + endpoint, {
      method: 'GET',
      headers: getHeader(req)
    });
  }

  const workflow_by_id = await getWorkflowById();
  const data = await workflow_by_id.json();

  res.json(data);
});

// POST /workflows/{workflowId}/agreements
app.post('/api/postAgreement/:id', async function (req, res, next) {

  function postAgreement() {
    /***
     * This function post agreements
     */
    const endpoint = '/agreements/';

    var myHeaders = getHeader(req);

    // find WFSetting_SendingAccount if exists
    var sendingAccount = '';
    for (let i = 0; req.body.mergeFieldInfo.length > i; i++) {
      if (req.body.mergeFieldInfo[i].fieldName.toString() === 'WFSetting_SendingAccount') {
        sendingAccount = req.body.mergeFieldInfo[i].defaultValue.toString();
        // set x-api-user to the email
        myHeaders['x-api-user'] = 'email:' + sendingAccount;

        //var sender_str = '{"label":"ESports User","memberInfos":[ {"email": "' + sendingAccount + '"} ],"order":2,"role":"SENDER"}';

        //req.body.participantSetsInfo.push(JSON.parse(sender_str));
      }
    }

    return fetch(url + endpoint, {
      method: 'POST',
      headers: myHeaders,
      body: JSON.stringify(req.body)
    });
  }


  let okToSubmit = true;

  for (let o = 0; req.body.participantSetsInfo.length > o; o++) {
    //console.log(req.body.participantSetsInfo[o].memberInfos);
    for (let i = 0; req.body.participantSetsInfo[o].memberInfos.length > i; i++) {
      if (!req.body.participantSetsInfo[o].memberInfos[i].email.match(emailRegex)) {
        okToSubmit = false;
      }
    }
  }

  let data;

  if (okToSubmit) {
    const api_response = await postAgreement();
    data = await api_response.json();
    console.log('response ' + JSON.stringify(data));
  } else {
    data = { code: 'MISC_ERROR', message: emailErrorMessage };
  }
  res.json(data);
});


// GET /agreements/{agreementId}/signingUrls

app.get('/api/getSigningUrls/:id', async function (req, res, next) {

  async function getSigningUrls(count = 0) {
    /***
     * This function gets URL for the e-sign page for the current signer(s) of an agreement.
     */
    const endpoint = '/agreements/' + req.params.id + '/signingUrls';

    const sign_in_response = await fetch(url + endpoint, {
      method: 'GET',
      headers: getHeader(req)
    });

    const sign_in_data = await sign_in_response.json();

    // Look for times to retry and default to 15, if not found
    const retries = 'sign_now_retries' in config['features'] ? config['features']['sign_now_retries'] : 600;

    if (sign_in_data.code === 'AGREEMENT_NOT_EXPOSED' || sign_in_data.code === 'BAD_REQUEST') {
      // retry for n times with 1s delay
      if (count >= retries) {
        return sign_in_data;
      } else {
        await new Promise(done => setTimeout(() => done(), 1000));
        count++;
        return await getSigningUrls(count);
      }
    }
    return sign_in_data;
  }

  const data = await getSigningUrls();

  res.json(data);
});

// POST /transientDocuments
app.post('/api/postTransient', upload.single('myfile'), async function (req, res, next) {

  function postTransient() {
    /***
     * This functions post transient
     */
    const endpoint = '/transientDocuments';
    let newHeader = { ...getHeader(req) };
    delete newHeader['Accept'];
    delete newHeader['Content-Type'];

    return fetch(url + endpoint, {
      method: 'POST',
      headers: newHeader,
      body: form
    });
  }

  // Create FormData
  var form = new FormData();
  form.append('File-Name', req.file.originalname);
  form.append('Mime-Type', req.file.mimetype);
  form.append('File', fs.createReadStream(req.file.path));

  const api_response = await postTransient();
  const data = await api_response.json();


  // Delete uploaded doc after transient call
  fs.unlink(req.file.path, function (err) {
    if (err) return console.log(err);
  });

  res.json(data);
});

  // Get index.html page from server
app.get('/:area', function (req, res) {
    console.log("Route matches '/:area' (" + req.params.area + ")");
    res.render('index', {area: req.params.area});
    //res.sendFile(__dirname + '/static/' + req.params.area + '.html');
});

app.get('/testing/:area', function (req, res) {
    console.log("Route matches '/testing/:area' (" + req.params.area + ")");
    res.render('index', {area: req.params.area});
//    res.sendFile(__dirname + '/static/' + req.params.area + '.html');
});


app.disable('etag');
app.set('view engine', 'ejs');
app.listen(port, () => console.log(`Server started on port ${port}`));
