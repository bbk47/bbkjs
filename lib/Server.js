const WebSocket = require('ws');
const net = require('net');

const MAX_CONNECTIONS = 50000;

function Server(config) {
    const uri = `${config.serverAddress}:${config.serverPort}${config.websocketUri}`;
    this.websocketUrl = config.tls ? `wss://${uri}` : `ws://${uri}`;
    this.serverAddress = config.serverAddress;
    this.serverPort = config.serverPort;
    this.websocketUri = config.websocketUri;
    this.logLevel = config.logLevel || 'error';
    this.logFile = null;
}

Server.prototype.initServer = function () {
    const self = this;
    const server = new WebSocket.Server({
        host: self.serverAddress,
        port: self.serverPort,
        path: self.websocketUri,
        perMessageDeflate: false,
        backlog: MAX_CONNECTIONS,
    });
    self.server = server;
    server.on('connection', self.handleConnection.bind(self));
    server.on('listening', function () {
        console.log('websocket server listening on', self.websocketUrl);
    });
};

Server.prototype.parseSocks5Header = function (data) {
    const headerLen = data.readUInt8(0);
    const type = data.readUInt8(1);
    const addrData = data.slice(2);
    let dstAddr = '';
    let dstPort = null;
    if (type === 0x1) {
        // IP
        const IP = addrData.slice(0, -2);
        const PORT = addrData.slice(-2);
        dstAddr = IP.map((temp) => {
            return Number(temp).toString(10);
        }).join('.');
        dstPort = PORT[0] * 256 + PORT[1];
    } else if (type === 0x3) {
        const addrLen = addrData.readUInt8(0);
        const domain = addrData.slice(1, addrLen + 1);
        const port = addrData.slice(addrLen + 1);
        dstAddr = domain.toString();
        dstAddr = domain.toString();
        dstPort = port[0] * 256 + port[1];
    }

    return { headerLen, dstAddr, dstPort };
};

Server.prototype.handleConnection = function (connection) {
    let stage = 'INIT';
    let dataCache = [];
    let targetConn = null;
    let self = this;
    connection.on('message', (data) => {
        switch (stage) {
            case 'INIT':
                if (data.length < 3) {
                    connection.destroy();
                    return;
                }
                const addrInfo = self.parseSocks5Header(data);
                const headerLen = addrInfo.headerLen;
                const dstAddr = addrInfo.dstAddr;
                const dstPort = addrInfo.dstPort;
                const dataBuf = data.slice(headerLen + 1);
                stage = 'CONNECTING';
                targetConn = net.Socket();
                targetConn.connect(dstPort, dstAddr, function () {
                    console.log(`connect success. ${dstAddr}:${dstPort}`);
                    stage = 'STREAM';
                    dataCache = Buffer.concat([dataBuf, ...dataCache]);
                    targetConn.write(dataCache, function (err) {
                        dataCache = null;
                    });
                });
                targetConn.on('data', function (data) {
                    if (connection.readyState === WebSocket.OPEN) {
                        connection.send(data, { binary: true });
                    }
                });
                targetConn.on('close', function (hasError) {
                    console.log(`close event of target connection has been triggered!hasError(${hasError})`);
                    stage = 'DESTORYED';
                    connection.close();
                });
                targetConn.on('error', function (err) {
                    console.log(`error event of target connection has been triggered!message:${err.message}`);
                    console.log(err);
                });
                break;
            case 'CONNECTING':
                dataCache.push(data);
                break;
            case 'STREAM':
                targetConn && targetConn.write(data);
                break;
        }
    });

    connection.on('end', function () {
        console.info(`end event of client connection has been triggered`);
        stage = 'DESTORYED';
        targetConn && targetConn.destroy();
    });
    connection.on('close', function (hadError, reason) {
        console.info(`close event of client connection has been triggered! hadError:${hadError}`);
        stage = 'DESTORYED';
        connection.close();
        targetConn && targetConn.destroy();
    });
    connection.on('error', function (error) {
        console.info(`error event of client connection has been triggered!message:${error.message}`);
        stage = 'DESTORYED';
        connection.close();
        targetConn && targetConn.destroy();
    });
};

Server.prototype.bootstrap = function () {
    this.initServer();
};
module.exports = Server;
