const serverless = require('serverless-http');
const app = require('../../index.js');

exports.handler = serverless(app);
