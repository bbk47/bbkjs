const net = require('net');
const WebSocket = require('ws');

const MAX_CONNECTIONS = 50000;

function Client(config) {
    const uri = `${config.serverAddress}:${config.serverPort}${config.websocketUri}`;
    this.websocketUrl = config.tls ? `wss://${uri}` : `ws://${uri}`;
    this.localAddress = config.localAddress;
    this.localPort = config.localPort;
    this.logLevel = config.logLevel || 'error';
    this.logFile = null;
}

Client.prototype.initServer = function () {
    const self = this;
    let server = net.createServer({ allowHalfOpen: true });
    self.server = server;

    server.maxConnections = MAX_CONNECTIONS;
    server.on('connection', self.handleConnection.bind(self));
    server.on('listening', function () {
        console.log('client is listening on sockss://', self.localAddress + ':' + self.localPort);
    });
    server.on('close', function () {
        console.log('server is closed');
    });
    server.listen(this.localPort, this.localAddress);
};

Client.prototype.handleConnection = function (socket) {
    let stage = 'INIT';
    let dataCache = [];
    let wsConnection = null;
    let websocketUrl = this.websocketUrl;
    socket.on('data', (data) => {
        switch (stage) {
            case 'INIT':
                socket.write('\x05\x00');
                stage = 'ADDR';
                break;
            case 'ADDR':
                const socksAddrInfo = data.slice(3);

                stage = 'CONNECTING';
                wsConnection = new WebSocket(websocketUrl, { perMessageDeflate: false });

                wsConnection.on('open', function () {
                    console.log('open websocket success. url:' + websocketUrl);
                    socket.write('\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00');
                    stage = 'STREAM';
                    dataCache = Buffer.concat([Buffer.from([socksAddrInfo.length]), socksAddrInfo, ...dataCache]);
                    wsConnection.send(dataCache, { binary: true }, function (err) {
                        dataCache = null;
                    });
                });
                wsConnection.on('message', function (data) {
                    socket.write(data);
                });
                wsConnection.on('close', function (hasError) {
                    console.log(`close event of server connection has been triggered!hasError(${hasError})`);
                    stage = 'DESTORYED';
                    socket.end();
                });
                wsConnection.on('error', function (err) {
                    console.log(`error event of server connection has been triggered!message:${err.message}`);
                });
                break;
            case 'CONNECTING':
                dataCache.push(data);
                break;
            case 'STREAM':
                wsConnection && wsConnection.send(data, { binary: true });
                break;
        }
    });

    socket.on('end', function () {
        console.info(`end event of client connection has been triggered`);
        stage = 'DESTORYED';
    });
    socket.on('close', function (hadError) {
        console.info(`close event of client connection has been triggered!hadError:${hadError}` + hadError);
        stage = 'DESTORYED';
        socket.destroy();
        wsConnection && wsConnection.close();
    });
    socket.on('error', function (error) {
        console.info(`error event of client connection has been triggered!message:${error.message}`);
        stage = 'DESTORYED';
        socket.destroy();
        wsConnection && wsConnection.close();
    });
};

Client.prototype.bootstrap = function () {
    this.initServer();
};
module.exports = Client;
