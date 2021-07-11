const WebSocket = require('ws');
const net = require('net');
const meta = require('./meta');

const MAX_CONNECTIONS = 50000;
const DATA_MAX_SIZE = 1024;
const DELAY_MAX_TIME = 1000 * 60 * 5;

function Server(config) {
    const uri = `${config.serverAddress}:${config.serverPort}${config.websocketUri}`;
    this.websocketUrl = config.tls ? `wss://${uri}` : `ws://${uri}`;
    this.serverAddress = config.serverAddress;
    this.serverPort = config.serverPort;
    this.websocketUri = config.websocketUri;
    this.logLevel = config.logLevel || 'error';
    this.logFile = null;
    this._targetConnection = {};
    this._clients = [];
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

Server.prototype.checkSocketHealth = function () {
    // console.log('checkSocketHealth...');
    let client;
    let now = Date.now();
    for (let i = 0; i < this._clients.length; i++) {
        client = this._clients[i];
        if (now - client.lastPing > DELAY_MAX_TIME) {
            console.log('clean timeout connection');
            this._clients.splice(i, 1);
            client.connection.close();
        }
    }
};

Server.prototype.parseSocksAddrInfo = function parseSocksAddrInfo(buf) {
    const type = buf.readUInt8(0);
    const addrData = buf.slice(1);
    let dstAddr;
    let dstPort;
    if (type === 0x1) {
        // IP
        const IP = addrData.slice(0, -2);
        const PORT = addrData.slice(-2);
        dstAddr = IP.map((temp) => Number(temp).toString(10)).join('.');
        dstPort = PORT[0] * 256 + PORT[1];
    } else if (type === 0x3) {
        const addrLen = addrData.readUInt8(0);
        const domain = addrData.slice(1, addrLen + 1);
        const port = addrData.slice(addrLen + 1);
        dstAddr = domain.toString();
        dstAddr = domain.toString();
        dstPort = port[0] * 256 + port[1];
    }
    return { dstAddr, dstPort, addrInfoLen: buf.length };
};

Server.prototype.handleConnection = function (connection) {
    const self = this;
    const conObj = { connection, delayms: 0 };
    self._clients.push(conObj);
    connection.on('message', (data) => {
        const frame = meta.derialize(data);
        if (frame.type === meta.PING_FRAME) {
            const start = parseInt(frame.data.toString('ascii'));
            const now = Date.now();
            conObj.delayms = now - start;
            conObj.lastPing = now;
            const buff = Buffer.concat([frame.data, Buffer.from(now + '')]);
            const respFrame = { cid: frame.cid, type: meta.PONG_FRAME, data: buff };
            // console.log(`ping:${conObj.delayms}ms`);
            self.sendResponseFrame(connection, respFrame);
        } else {
            // console.log('websocket client message come! cid:' + frame.cid);
            self.dispatchRequestFrame(connection, frame);
        }
    });

    connection.on('end', function () {
        console.info(`end event of client connection has been triggered`);
        stage = 'DESTORYED';
        connection.close();
    });
    connection.on('close', function (hadError) {
        console.info(`close event of client connection has been triggered!hadError:${hadError}`);
        stage = 'DESTORYED';
        connection.close();
    });
    connection.on('error', function (error) {
        console.info(`error event of client connection has been triggered!message:${error.message}`);
        stage = 'DESTORYED';
        connection.close();
    });
};

Server.prototype.sendResponseFrame = function (client, frame) {
    if (client.readyState !== WebSocket.OPEN) {
        return; // missing client connection
    }
    if (frame.data.length < DATA_MAX_SIZE) {
        client.send(meta.serialize(frame), { binary: true });
    } else {
        let offset = 0;
        let frame2;
        while (offset < frame.data.length) {
            frame2 = Object.assign({}, frame);
            frame2.data = frame.data.slice(offset, offset + DATA_MAX_SIZE);
            offset += DATA_MAX_SIZE;
            client.send(meta.serialize(frame2), { binary: true });
        }
    }
};

Server.prototype.dispatchRequestFrame = function (connection, frame) {
    const self = this;
    if (frame.type === meta.INIT_FRAME) {
        let targetObj = { dataCache: [] };
        let targetSocket = net.Socket();
        self._targetConnection[frame.cid] = targetObj;
        targetObj.status = 'connecting';
        const addrInfo = self.parseSocksAddrInfo(frame.data);
        targetSocket.connect(addrInfo.dstPort, addrInfo.dstAddr, function () {
            console.log(`connect success. ${addrInfo.dstAddr}:${addrInfo.dstPort}`);
            targetObj.status = 'connected';
            targetObj.socket = targetSocket;
            let startFrameData = frame.data.slice(addrInfo.addrInfoLen);
            let firstData = Buffer.concat([startFrameData, ...targetObj.dataCache]);
            targetSocket.write(firstData, function (err) {
                targetObj.dataCache = null;
            });
        });
        targetSocket.on('data', function (data) {
            // console.log('target server data come! for cid:' + frame.cid);
            const respFrame = { cid: frame.cid, type: meta.STREAM_FRAME, data: data };
            self.sendResponseFrame(connection, respFrame);
        });
        targetSocket.on('close', function (hashError) {
            console.log(`close event of target connection has been triggered!hasError:${hashError}`);
            const respFrame = { cid: frame.cid, type: meta.FIN_FRAME, data: Buffer.from([0, 1]) };
            targetSocket.socket = null;
            targetObj.status = 'destroyed';
            targetSocket.destroy();
            self.sendResponseFrame(connection, respFrame);
        });
        targetSocket.on('error', function (err) {
            console.log(`error event of target connection has been triggered!message:${err.message}`);
            const respFrame = { cid: frame.cid, type: meta.RST_FRAME, data: Buffer.from([0, 2]) };
            targetSocket.socket = null;
            targetObj.status = 'destroyed';
            targetSocket.destroy();
            self.sendResponseFrame(connection, respFrame);
        });
    } else if (frame.type === meta.STREAM_FRAME) {
        let targetObj = self._targetConnection[frame.cid];
        if (targetObj) {
            if (targetObj.status === 'connecting') {
                targetObj.dataCache.push(frame.data);
            } else {
                targetObj.socket.write(frame.data);
            }
        } else {
            console.log('----------------missing connection----------');
        }
    } else if (frame.type === meta.FIN_FRAME) {
        let targetObj = self._targetConnection[frame.cid];
        if (targetObj && targetObj.socket) {
            targetObj.socket.end();
            targetObj.socket = null;
        } else {
            console.log('----------------close by client---------------');
        }
    }
};

Server.prototype.bootstrap = function () {
    this.initServer();
    setInterval(this.checkSocketHealth.bind(this), 5000);
};
module.exports = Server;
