const net = require('net');
const http = require('http');
const WebSocket = require('ws');
const protocol = require('./protocol');
const getRandomId = require('./utils/uuid');
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
const PING_CID = '0'.repeat(32);
let wsRetryCount = 0;
let pingCount = 0;

function Client(config) {
    this.websocketUrl = config.websocketUrl;
    this.listenAddr = config.listenAddr;
    this.listenPort = config.listenPort;
    this.listenHttpPort = config.listenHttpPort;
    this.rnglen = config.rnglen;
    this.ping = config.ping;
    // 内部属性
    this._remoteFrameQueue = [];
    this._wsStatus = WEBSOCKET_INIT;
    this._wsConnection = null;
    this._browserSockets = {};
    this._lastPong = Date.now();
    this.logger = loggerFn('c>', config.logLevel || 'error', config.logFile);
    this.$encryptor = new Encryptor(config.password, config.method);
}

Client.prototype.initSocks5Server = function () {
    const self = this;
    let server = net.createServer({ allowHalfOpen: true });
    self.server = server;

    server.maxConnections = MAX_CONNECTIONS;
    server.on('connection', self.handleSocks5Conn.bind(self));
    server.on('listening', function () {
        self.logger.log('client is listening on sockss://' + self.listenAddr + ':' + self.listenPort);
    });
    server.on('close', function () {
        self.logger.log('server is closed');
    });
    server.listen(this.listenPort, this.listenAddr);
};
Client.prototype.initHttpServer = function () {
    const self = this;
    const httpserver = http.createServer();
    httpserver.on('listening', function () {
        self.logger.log('client is listening on https://' + self.listenAddr + ':' + self.listenHttpPort);
    });
    httpserver.on('connect', self.handleHttpServer.bind(this)).listen(self.listenHttpPort, self.listenAddr);
};

Client.prototype.handleSocks5Conn = function (socket) {
    let stage = 'INIT';
    let self = this;
    const connectionId = getRandomId();
    self._browserSockets[connectionId] = { type: 'socks5', socket };

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
                self.flushRemoteFrame({ cid: connectionId, type: protocol.INIT_FRAME, data: socksAddrInfo });
                break;
            case 'STREAM':
                self.flushRemoteFrame({ cid: connectionId, type: protocol.STREAM_FRAME, data: data });
                break;
        }
    });

    socket.on('end', function () {
        self.logger.debug(`fire event[end] on local connection`);
        stage = 'DESTORYED';
        self.flushRemoteFrame({ cid: connectionId, type: protocol.FIN_FRAME, data: Buffer.from([0, 1]) });
    });
    socket.on('close', function (hadError) {
        self.logger.debug(`fire event[close] on local connection!hadError:${hadError}`);
        stage = 'DESTORYED';
        socket.destroy();
        self.flushRemoteFrame({ cid: connectionId, type: protocol.FIN_FRAME, data: Buffer.from([0, 2]) });
    });
    socket.on('error', function (error) {
        self.logger.error(`fire event[error] on local connection!message:${error.message}`);
        stage = 'DESTORYED';
        socket.destroy();
        self.flushRemoteFrame({ cid: connectionId, type: protocol.FIN_FRAME, data: Buffer.from([0, 3]) });
    });
};
Client.prototype.handleHttpServer = function (cReq, cSock) {
    let self = this;
    const connectionId = getRandomId();
    self._browserSockets[connectionId] = { type: 'http', socket: cSock };

    let socksAddrInfo;

    const hostport = cReq.url.split(':');
    const hostname = hostport[0];
    const port = Number(hostport[1]);
    if (/^(\d+\.){3}\d+$/.test(hostname)) {
        const parts = hostname.split('.').map((p) => Number(p));
        const portBuf = Buffer.from([parseInt(port / 256), port % 256]);
        const preBuf = Buffer.from([0x01, parts[0], parts[1], parts[2], parts[3]]);
        socksAddrInfo = Buffer.concat([preBuf, portBuf]);
    } else {
        const domain = hostname;
        const preBuf = Buffer.from([0x03, domain.length]);
        const domainBuf = Buffer.from(domain);
        const portBuf = Buffer.from([parseInt(port / 256), port % 256]);
        socksAddrInfo = Buffer.concat([preBuf, domainBuf, portBuf]);
    }
    // const socksAddrInfo = data.slice(3);
    // socket.write('\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00');
    stage = 'STREAM';
    cReq.socket.on('data', (data) => {
        self.flushRemoteFrame({ cid: connectionId, type: protocol.STREAM_FRAME, data: data });
    });
    cReq.socket.on('error', function (err) {
        self.logger.error(`fire event[error] on local connection!hadError:${err.message}`);
        stage = 'DESTORYED';
        cSock.end();
        self.flushRemoteFrame({ cid: connectionId, type: protocol.FIN_FRAME, data: Buffer.from([0, 2]) });
    });
    cReq.socket.on('close', function (hadError) {
        self.logger.debug(`fire event[close] on local connection!hadError:${hadError}`);
        stage = 'DESTORYED';
        cSock.end();
        self.flushRemoteFrame({ cid: connectionId, type: protocol.FIN_FRAME, data: Buffer.from([0, 2]) });
    });
    self.flushRemoteFrame({ cid: connectionId, type: protocol.INIT_FRAME, data: socksAddrInfo });
    cSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
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
            const decData = self.$encryptor.decrypt(data);
            const frame = protocol.derialize(decData);
            self.logger.debug('websocket server message come! for cid:' + frame.cid);
            if (frame.type === protocol.PONG_FRAME) {
                let stTimeBuf = frame.data.slice(0, 13);
                let serverTimeBuf = frame.data.slice(13, 26);
                let start = parseInt(stTimeBuf.toString('ascii'));
                let serverTime = parseInt(serverTimeBuf.toString('ascii'));
                const now = Date.now();
                const upUst = serverTime - start;
                const downUst = now - serverTime;
                self._lastPong = now;
                self.logger.info(`ws tunnel health！ up:${upUst}ms, down:${downUst}ms, rtt:${now - start}ms`);
                return;
            } else if (frame.type === protocol.EST_FRAME) {
                // 通知建立连接成功
                const addrInfo = socks5.parseAddrInfo(frame.data);
                self.logger.info(`EST_FRAME: connect ${addrInfo.dstAddr}:${addrInfo.dstPort} success!`);
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
            process.exit(-1);
        }
    });
};

Client.prototype.keepConnection = function () {
    pingCount++;
    const now = Date.now();
    const frame = { cid: PING_CID, type: protocol.PING_FRAME, data: Buffer.from(now + '') };
    this.sendRemoteFrame(frame);
    let seconds = (Date.now() - this._lastPong) / 1000;
    const minute = ~~(seconds / 60);
    const sec = Number(seconds % 60).toFixed(3);
    if (pingCount % 5 === 0) {
        const msg = `websocket connection last pong:  ${minute}M ${sec}s ago`;
        this.logger.info(msg);
    }
};

Client.prototype.flushLocalFrame = function (frame) {
    const self = this;
    const socketObj = this._browserSockets[frame.cid];
    const socket = socketObj.socket;
    if (socket && socket.readyState === 'open') {
        if (frame.type === protocol.STREAM_FRAME) {
            socket.write(frame.data);
        } else if (frame.type === protocol.FIN_FRAME) {
            socket.end();
            self.logger.debug('socket.end browser socket!');
        } else if (frame.type === protocol.RST_FRAME) {
            const errorMsg = frame.data[1] === 0x3 ? 'timeout' : 'error';
            self.logger.warn(`RST_FRAME: remote service connect target host [${errorMsg}]!`);
        }
    }
};

Client.prototype.sendRemoteFrame = function (frame) {
    const websocketConn = this._wsConnection;
    if (websocketConn && websocketConn.readyState === WebSocket.OPEN) {
        const binaryData = protocol.serialize(frame, this.rnglen);
        const encdata = this.$encryptor.encrypt(binaryData);
        websocketConn.send(encdata, { binary: true });
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
    this.initSocks5Server();
    if (this.listenHttpPort) {
        this.initHttpServer();
    }
    this.ping && setInterval(this.keepConnection.bind(this), 10000);
};
module.exports = Client;
