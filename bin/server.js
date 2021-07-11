const BBK = require('../');
// const options = require('../lib/option');
const options = {
    serverAddress: '127.0.0.1',
    serverPort: 5900,
    websocketUri: '/wss',
    password: 'p@ssword',
    method: 'aes-256-cbc',
};

var server = new BBK.Server(options);

server.bootstrap();
