const net = require('net');
const uuid = require('uuid').v4;
const WebSocket = require('ws');
const meta = require('./meta');
const socks5 = require('./utils/socks5');
const loggerFn = require('./utils/logger');
const Encryptor = require('./utils/encrypt').Encryptor;

const MAX_CONNECTIONS = 50000;
const DATA_MAX_SIZE = 1024 * 8;

const WEBSOCKET_INIT = 0;
const WEBSOCKET_CONNECTING = 1;
const WEBSOCKET_READY = 2;
const WEBSOCKET_DESTORYED = 3;
const MAX_RETRY_COUNT = 10;
let wsRetryCount = 0;

function Client(config) {
    const uri = `${config.serverAddress}:${config.serverPort}${config.websocketUri}`;
    this.websocketUrl = config.tls ? `wss://${uri}` : `ws://${uri}`;
    this.localAddress = config.localAddress;
    this.localPort = config.localPort;
    // 内部属性
    this._remoteFrameQueue = [];
    this._wsStatus = WEBSOCKET_INIT;
    this._wsConnection = null;
    this._browserSockets = {};
    this._lastPong = Date.now();
    this.$encryptWorker = new Encryptor(config.password, config.method, config.fillByte);
    this.logger = loggerFn('client', config.logLevel || 'error', config.logFile);
}

Client.prototype.initServer = function () {
    const self = this;
    let server = net.createServer({ allowHalfOpen: true });
    self.server = server;

    server.maxConnections = MAX_CONNECTIONS;
    server.on('connection', self.handleConnection.bind(self));
    server.on('listening', function () {
        self.logger.log('client is listening on sockss://', self.localAddress + ':' + self.localPort);
    });
    server.on('close', function () {
        self.logger.log('server is closed');
    });
    server.listen(this.localPort, this.localAddress);
};

Client.prototype.handleConnection = function (socket) {
    let stage = 'INIT';
    let self = this;
    const connectionId = uuid();
    self._browserSockets[connectionId] = socket;

    socket.on('data', (data) => {
        switch (stage) {
            case 'INIT':
                socket.write('\x05\x00');
                stage = 'ADDR';
                break;
            case 'ADDR':
                const socksAddrInfo = data.slice(3);
                socket.write('\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00');
                stage = 'STREAM';
                self.flushRemoteFrame({ cid: connectionId, type: meta.INIT_FRAME, data: socksAddrInfo });
                break;
            case 'STREAM':
                self.flushRemoteFrame({ cid: connectionId, type: meta.STREAM_FRAME, data: data });
                break;
        }
    });

    socket.on('end', function () {
        self.logger.debug(`fire event[end] on local connection`);
        stage = 'DESTORYED';
        self.flushRemoteFrame({ cid: connectionId, type: meta.FIN_FRAME, data: Buffer.from([0, 1]) });
    });
    socket.on('close', function (hadError) {
        self.logger.debug(`fire event[close] on local connection!hadError:${hadError}`);
        stage = 'DESTORYED';
        socket.destroy();
        self.flushRemoteFrame({ cid: connectionId, type: meta.FIN_FRAME, data: Buffer.from([0, 2]) });
    });
    socket.on('error', function (error) {
        self.logger.error(`fire event[error] on local connection!message:${error.message}`);
        stage = 'DESTORYED';
        socket.destroy();
        self.flushRemoteFrame({ cid: connectionId, type: meta.FIN_FRAME, data: Buffer.from([0, 3]) });
    });
};

Client.prototype.setupWsConnection = function () {
    const self = this;
    self.logger.info(`websocket retry count:[${wsRetryCount}]`);
    self.logger.info(`connecting websocket url:  [${self.websocketUrl}]`);
    const ws = new WebSocket(self.websocketUrl, { perMessageDeflate: false });
    wsRetryCount++;
    self._wsStatus = WEBSOCKET_CONNECTING;
    ws.on('open', function () {
        self._wsStatus = WEBSOCKET_READY;
        self.logger.info('open websocket success url:' + self.websocketUrl);
        self._wsConnection = ws;
        wsRetryCount = 0;
        self.flushRemoteFrame();
    });
    ws.on('message', function (data) {
        try {
            const decryptedData = self.$encryptWorker.decrypt(data);
            const frame = meta.derialize(decryptedData);
            self.logger.debug('websocket server message come! for cid:' + frame.cid);
            if (frame.type === meta.PONG_FRAME) {
                let stTimeBuf = frame.data.slice(0, 13);
                let serverTimeBuf = frame.data.slice(13, 26);
                let start = parseInt(stTimeBuf.toString('ascii'));
                let serverTime = parseInt(serverTimeBuf.toString('ascii'));
                const now = Date.now();
                const upUst = serverTime - start;
                const downUst = now - serverTime;
                self._lastPong = now;
                self.logger.info(`ws connection health！ up:${upUst}ms, down:${downUst}ms`);
                return;
            } else if (frame.type === meta.EST_FRAME) {
                // 通知建立连接成功
                const addrInfo = socks5.parseAddrInfo(frame.data);
                self.logger.debug(`EST_FRAME: connect ${addrInfo.dstAddr}:${addrInfo.dstPort} success!`);
                return;
            }
            self.flushLocalFrame(frame);
        } catch (error) {
            self.logger.fatal(`decrypt or derialize ws message  falied from server!`);
        }
    });
    ws.on('close', function (code) {
        self.logger.info(`fire event[close] on websocket connection!code(${code})`);
        self._wsStatus = WEBSOCKET_DESTORYED;
        self._wsConnection = null;
        ws.close();
    });
    ws.on('error', function (err) {
        self._wsStatus = WEBSOCKET_DESTORYED;
        self.logger.error(`fire event[close] on websocket connection!${err.message}`);
        self._wsConnection = null;
        ws.close();
        if (wsRetryCount >= MAX_RETRY_COUNT) {
            self.logger.warn(`websocket retry reach max retry count[${MAX_RETRY_COUNT}], process exit! `);
        }
    });
};

Client.prototype.keepConnection = function () {
    const now = Date.now();
    const frame = { type: meta.PING_FRAME, data: Buffer.from(now + '') };
    this.sendRemoteFrame(frame);
    let seconds = (Date.now() - this._lastPong) / 1000;
    const minute = ~~(seconds / 60);
    const sec = Number(seconds % 60).toFixed(3);
    if (seconds > 30) {
        const msg = `websocket connection last pong:  ${minute}M ${sec}s ago`;
        this.logger.warn(msg);
    }
};

Client.prototype.flushLocalFrame = function (frame) {
    const self = this;
    const socket = this._browserSockets[frame.cid];
    if (socket && socket.readyState === 'open') {
        if (frame.type === meta.STREAM_FRAME) {
            socket.write(frame.data);
        } else if (frame.type === meta.FIN_FRAME) {
            socket.end();
            self.logger.debug('socket.end browser socket!');
        } else if (frame.type === meta.RST_FRAME) {
            socket.destroy();
            self.logger.warn('RST_FRAME: remote service connect target host error!');
        }
    }
};

Client.prototype.sendRemoteFrame = function (frame) {
    const websocketConn = this._wsConnection;
    if (websocketConn && websocketConn.readyState === WebSocket.OPEN) {
        const binaryData = this.$encryptWorker.encrypt(meta.serialize(frame));
        websocketConn.send(binaryData, { binary: true });
    }
};

Client.prototype.flushRemoteFrame = function (frame) {
    if (frame) {
        this._remoteFrameQueue.push(frame);
    }
    if (this._wsStatus === WEBSOCKET_CONNECTING) {
        // websocket connecting
        return;
    }
    if (this._wsStatus === WEBSOCKET_INIT || this._wsStatus === WEBSOCKET_DESTORYED) {
        this.setupWsConnection();
        return;
    }
    while (this._remoteFrameQueue.length > 0) {
        const frame = this._remoteFrameQueue.shift();
        if (frame.data.length < DATA_MAX_SIZE) {
            this.sendRemoteFrame(frame);
        } else {
            let offset = 0;
            while (offset < frame.data.length) {
                let frame2 = Object.assign({}, frame);
                frame2.data = frame.data.slice(offset, offset + DATA_MAX_SIZE);
                offset += DATA_MAX_SIZE;
                this.sendRemoteFrame(frame2);
            }
        }
    }
};

Client.prototype.bootstrap = function () {
    this.initServer();
    setInterval(this.keepConnection.bind(this), 10000);
};
module.exports = Client;
