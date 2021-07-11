const BBK = require('../');
const options = require('../lib/option');

// const options = {
//     localAddress: '127.0.0.1',
//     localPort: 1080,
//     serverAddress: '127.0.0.1',
//     serverPort: 5900,
//     websocketUri: '/websocket',
//     password: 'p@ssword',
//     method: 'aes-256-cfb',
// };

var client = new BBK.Client(options);

client.bootstrap();
