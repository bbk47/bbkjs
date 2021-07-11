const BBK = require('../');
const options = require('../lib/option');
// const options = {
//     serverAddress: '127.0.0.1',
//     serverPort: 5900,
//     websocketUri: '/websocket',
//     password: 'p@ssword',
//     method: 'aes-256-cfb',
// };

var server = new BBK.Server(options);

server.bootstrap();
