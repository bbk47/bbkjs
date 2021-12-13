const Client = require('./lib/Client');
const Server = require('./lib/Server');
const deploy = require('./deploy');

console.log(deploy);

exports.Client = Client;
exports.Server = Server;
