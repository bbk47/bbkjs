const WebSocket = require('ws');
const net = require('net');
const log4js = require('log4js');
const meta = require('./meta');
const Encryptor = require('./encrypt').Encryptor;

const MAX_CONNECTIONS = 50000;
const DATA_MAX_SIZE = 1024 * 8;
const DELAY_MAX_TIME = 1000 * 60 * 5;

function Server(config) {
    const uri = `${config.serverAddress}:${config.serverPort}${config.websocketUri}`;
    this.websocketUrl = config.tls ? `wss://${uri}` : `ws://${uri}`;
    this.serverAddress = config.serverAddress;
    this.serverPort = config.serverPort;
    this.websocketUri = config.websocketUri;
    this.logLevel = config.logLevel || 'error';
    this.logFile = config.logFile;
    this._targetConnection = {};
    this._clients = [];
    this.$encryptWorker = new Encryptor(config.password, config.method);
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
        self.logger.log('websocket server listening on', self.websocketUrl);
    });
};

Server.prototype.checkSocketHealth = function () {
    // console.log('checkSocketHealth...');
    let client;
    let self = this;
    let now = Date.now();
    for (let i = 0; i < this._clients.length; i++) {
        client = this._clients[i];
        if (now - client.lastPing > DELAY_MAX_TIME) {
            self.logger.debug('clean timeout connection');
            this._clients.splice(i, 1);
            client.connection.terminate(); // 强制结束
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
        dstPort = port[0] * 256 + port[1];
    }
    return { dstAddr, dstPort };
};

Server.prototype.handleConnection = function (connection, req) {
    const self = this;
    const conObj = { connection };

    self._clients.push(conObj);
    connection.on('message', (data) => {
        try {
            const decryptData = self.$encryptWorker.decrypt(data);
            const frame = meta.derialize(decryptData);
            if (frame.type === meta.PING_FRAME) {
                const now = Date.now();
                conObj.lastPing = now;
                const buff = Buffer.concat([frame.data, Buffer.from(now + '')]);
                const respFrame = { cid: frame.cid, type: meta.PONG_FRAME, data: buff };
                self.flusResponseFrame(connection, respFrame);
            } else {
                self.logger.debug('websocket client message come! cid:' + frame.cid);
                self.dispatchRequestFrame(connection, frame);
            }
        } catch (error) {
            const ip = req.socket.remoteAddress;
            self.logger.fatal(`client:[${ip}] decrypt or derialize message falied!`);
        }
    });
    connection.on('close', function (hadError) {
        self.logger.debug(`close event of client connection has been triggered!hadError:${hadError}`);
    });
    connection.on('error', function (error) {
        self.logger.error(`error event of client connection has been triggered!message:${error.message}`);
        connection.close();
    });
};
Server.prototype.cleanTargetCache = function (targetInfo, frame) {
    if (targetInfo.socket) {
        targetInfo.socket.destroy();
        targetInfo.socket = null;
        targetInfo.dataCache = [];
        delete this._targetConnection[frame.cid]; // 清楚由于target关闭的缓存数据
    }
};
Server.prototype.sendResponseFrame = function (client, frame) {
    const binaryData1 = this.$encryptWorker.encrypt(meta.serialize(frame));
    client.send(binaryData1, { binary: true });
};

Server.prototype.flusResponseFrame = function (client, frame) {
    if (client.readyState !== WebSocket.OPEN) {
        return; // missing client connection
    }
    if (frame.data.length < DATA_MAX_SIZE) {
        this.sendResponseFrame(client, frame);
    } else {
        // 大帧拆分，最大为65535-39(2+1+36)
        let offset = 0;
        let frame2;
        while (offset < frame.data.length) {
            frame2 = Object.assign({}, frame);
            frame2.data = frame.data.slice(offset, offset + DATA_MAX_SIZE);
            offset += DATA_MAX_SIZE;
            this.sendResponseFrame(client, frame2);
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
            self.logger.info(`connect success. ${addrInfo.dstAddr}:${addrInfo.dstPort}`);
            targetObj.status = 'connected';
            targetObj.socket = targetSocket;
            let firstData = Buffer.concat(targetObj.dataCache);
            targetSocket.write(firstData, function (err) {
                targetObj.dataCache = null;
            });
        });
        targetSocket.on('data', function (data) {
            // console.log('target server data come! for cid:' + frame.cid);
            const respFrame = { cid: frame.cid, type: meta.STREAM_FRAME, data: data };
            self.flusResponseFrame(connection, respFrame);
        });
        targetSocket.on('close', function (hashError) {
            self.logger.debug(`close event of target connection has been triggered!hasError:${hashError}`);
            self.cleanTargetCache(targetObj, frame);
            const respFrame = { cid: frame.cid, type: meta.FIN_FRAME, data: Buffer.from([0, 1]) };
            self.flusResponseFrame(connection, respFrame);
        });
        targetSocket.on('error', function (err) {
            self.logger.error(`error event of target connection has been triggered!message:${err.message}`);
            self.cleanTargetCache(targetObj, frame);
            const respFrame = { cid: frame.cid, type: meta.RST_FRAME, data: Buffer.from([0, 2]) };
            self.flusResponseFrame(connection, respFrame);
        });
    } else if (frame.type === meta.STREAM_FRAME) {
        let targetObj = self._targetConnection[frame.cid];
        if (targetObj) {
            if (targetObj.status === 'connecting') {
                targetObj.dataCache.push(frame.data);
            } else if (targetObj.status === 'connected') {
                targetObj.socket.write(frame.data);
            }
        } else {
            self.logger.debug('====STREAM_FRAME missing target connection!!');
        }
    } else if (frame.type === meta.FIN_FRAME) {
        let targetObj = self._targetConnection[frame.cid];
        if (targetObj && targetObj.socket) {
            self.logger.debug('====FIN_FRAME from client, end target connection!');
            targetObj.socket.end();
            targetObj.socket = null;
        } else {
            // ignore multiple event(end|close|error) emit FIN_FRAME
        }
    }
};

Server.prototype.initLogger = function () {
    if (this.logFile) {
        log4js.loadAppender('file');
        log4js.addAppender(log4js.appenders.file(this.logFile), 'server');
    }
    this.logger = log4js.getLogger('server');
    this.logger.level = this.logLevel;
};

Server.prototype.bootstrap = function () {
    this.initLogger();
    this.initServer();
    setInterval(this.checkSocketHealth.bind(this), 5000);
};
module.exports = Server;
