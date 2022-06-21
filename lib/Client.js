const net = require('net');
const http = require('http');
const tls = require('tls');
const http2 = require('http2');
const WebSocket = require('ws');
const protocol = require('./protocol');
const serializerFn = require('./serializer');
const toolboxjs = require('@bbk47/toolbox');
const getRandomId = toolboxjs.uuid;
const socks5 = toolboxjs.socks5;
const loggerFn = toolboxjs.logger;

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
    this.http2Url = config.http2Url;
    this.listenAddr = config.listenAddr;
    this.listenPort = config.listenPort;
    this.listenHttpPort = config.listenHttpPort;
    this.protocol = config.protocol;
    this.ping = config.ping;
    this.tlsOpts = {
        key: config.sslKey,
        cert: config.sslCrt,
        rejectUnauthorized: false,
        host: config.tlsHost,
        port: config.tlsPort
    }
    // 内部属性
    this._remoteFrameQueue = [];
    this._wsStatus = WEBSOCKET_INIT;
    this._wsConn = null;
    this._httpConn = null;
    this._tlsConn = null;
    this._browserSockets = {};
    this._lastPong = Date.now();
    this.logger = loggerFn('c>', config.logLevel || 'error', config.logFile);
    this.$serializer = serializerFn(config.password, config.method, config.rnglen);
}

Client.prototype.initSocks5Server = function () {
    // console.log('initSocks5Server...');
    const self = this;
    let server = net.createServer({ allowHalfOpen: true });
    self.server = server;

    server.maxConnections = MAX_CONNECTIONS;
    server.on('connection', self.handleSocks5Conn.bind(self));
    server.on('close', function () {
        self.logger.log('server is closed');
    });
    server.listen(this.listenPort, this.listenAddr, function () {
        self.logger.info('client is listening on sockss://' + self.listenAddr + ':' + self.listenPort);
    });
};
Client.prototype.initHttpServer = function () {
    // console.log('initHttpServer...');
    const self = this;
    const httpserver = http.createServer();
    httpserver.on('connect', self.handleHttpServer.bind(this));
    httpserver.listen(self.listenHttpPort, self.listenAddr, function () {
        self.logger.info('client is listening on https://' + self.listenAddr + ':' + self.listenHttpPort);
    });
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
                const addrInfo = socks5.parseAddrInfo(socksAddrInfo);
                console.log('----' + addrInfo.dstAddr);
                if (addrInfo.dstAddr === 'support.browser.heytapmobi.com') {
                    console.log('ignore...' + addrInfo.dstAddr);
                    return;
                }
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
    const addrInfo = socks5.parseAddrInfo(socksAddrInfo);
    // console.log('----'+addrInfo.dstAddr)
    if (/(oppomobile.com|heytapmobi.com)$/.test(addrInfo.dstAddr)) {
        // console.log('ignore...'+addrInfo.dstAddr);
        cSock.end();
        return;
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

Client.prototype.setupTunnel = function () {
    if (this.protocol === 'ws') {
        this.setupWsConn();
    } else if (this.protocol === 'h2') {
        this.setupHttp2Conn();
    }  else if (this.protocol === 'tls') {
        this.setupTlsConn();
    }else {
        throw Error('un implement protocol!');
    }
};

Client.prototype.setupWsConn = function () {
    const self = this;
    self.logger.info(`websocket retry count:[${wsRetryCount}]`);
    self.logger.info(`connecting websocket url:  [${self.websocketUrl}]`);
    const ws = new WebSocket(self.websocketUrl, { perMessageDeflate: false });
    wsRetryCount++;
    self._wsStatus = WEBSOCKET_CONNECTING;
    ws.on('open', function () {
        self._wsStatus = WEBSOCKET_READY;
        self.logger.info('open websocket success url:' + self.websocketUrl);
        self._wsConn = ws;
        wsRetryCount = 0;
        self.flushRemoteFrame();
    });
    ws.on('message', self.handleServerMsg.bind(self));
    ws.on('close', function (code) {
        self.logger.info(`fire event[close] on websocket connection!code(${code})`);
        self._wsStatus = WEBSOCKET_DESTORYED;
        self._wsConn = null;
        ws.close();
    });
    ws.on('error', function (err) {
        self._wsStatus = WEBSOCKET_DESTORYED;
        self.logger.error(`fire event[close] on websocket connection!${err.message}`);
        self._wsConn = null;
        ws.close();
        if (wsRetryCount >= MAX_RETRY_COUNT) {
            self.logger.warn(`websocket retry reach max retry count[${MAX_RETRY_COUNT}], process exit! `);
            process.exit(-1);
        }
    });
};

Client.prototype.setupHttp2Conn = function () {
    const self = this;
    self.logger.info(`http2 retry count:[${wsRetryCount}]`);
    self.logger.info(`connecting http2 url:  [${self.http2Url}]`);
    wsRetryCount++;
    self._wsStatus = WEBSOCKET_CONNECTING;
    const http2Path = this.http2Url.replace(/^https?:\/\/[^/]*/, '');
    const client = http2.connect(`${this.http2Url}`);
    const http2Req = client.request({
        ':method': 'POST',
        ':path': http2Path || '/',
        'Content-Type': 'octet-stream',
    });

    http2Req.on('ready', function (event) {
        self.logger.info('open http2 success url:' + self.http2Url);
        self._wsStatus = WEBSOCKET_READY;
        self._httpConn = http2Req;
        wsRetryCount = 0;
        self.flushRemoteFrame();
    });

    var buffcache = Buffer.from([]);
    var datalen = 0;
    var pack;
    http2Req.on('data', function (data) {
        buffcache = Buffer.concat([buffcache, data]);
        while (true) {
            if (buffcache.length <= 2) {
                return;
            }
            datalen = buffcache[0] * 256 + buffcache[1];
            if (buffcache.length < datalen + 2) {
                return;
            }
            pack = buffcache.slice(2, datalen + 2);
            buffcache = buffcache.slice(datalen + 2);
            self.handleServerMsg(pack);
        }
    });
    http2Req.on('close', function () {
        self.logger.info(`fire event[close] on http2 connection!`);
        self._wsStatus = WEBSOCKET_DESTORYED;
        self._httpConn = null;
        http2Req.destroy();
    });
    http2Req.on('error', function (err) {
        self._wsStatus = WEBSOCKET_DESTORYED;
        self.logger.error(`fire event[close] on http2 connection!${err.message}`);
        self._httpConn = null;
        http2Req.destroy();
        if (wsRetryCount >= MAX_RETRY_COUNT) {
            self.logger.warn(`websocket retry reach max retry count[${MAX_RETRY_COUNT}], process exit! `);
            process.exit(-1);
        }
    });
};

Client.prototype.setupTlsConn = function(){
    const self = this;
    self.logger.info(`tls retry count:[${wsRetryCount}]`);
    self.logger.info(`connecting tls host:  [${self.tlsOpts.host}]`);
    wsRetryCount++;
    self._wsStatus = WEBSOCKET_CONNECTING;
    console.log(self.tlsOpts);
    const tlsConn = tls.connect(self.tlsOpts, function () {
        self.logger.info('open tls host success:' + self.tlsOpts.host);
        self._wsStatus = WEBSOCKET_READY;
        self._tlsConn = tlsConn;
        wsRetryCount = 0;
        self.flushRemoteFrame();
      });


    var buffcache = Buffer.from([]);
    var datalen = 0;
    var pack;
    tlsConn.on('data', function (data) {
        buffcache = Buffer.concat([buffcache, data]);
        while (true) {
            if (buffcache.length <= 2) {
                return;
            }
            datalen = buffcache[0] * 256 + buffcache[1];
            if (buffcache.length < datalen + 2) {
                return;
            }
            pack = buffcache.slice(2, datalen + 2);
            buffcache = buffcache.slice(datalen + 2);
            self.handleServerMsg(pack);
        }
    });
    tlsConn.on('close', function () {
        self.logger.info(`fire event[close] on tls connection!`);
        self._wsStatus = WEBSOCKET_DESTORYED;
        self._tlsConn = null;
        tlsConn.destroy();
    });
    tlsConn.on('error', function (err) {
        self._wsStatus = WEBSOCKET_DESTORYED;
        self.logger.error(`fire event[close] on tls connection!${err.message}`);
        self._tlsConn = null;
        tlsConn.destroy();
        if (wsRetryCount >= MAX_RETRY_COUNT) {
            self.logger.warn(`retry reach max retry count[${MAX_RETRY_COUNT}], process exit! `);
            process.exit(-1);
        }
    });
}

Client.prototype.handleServerMsg = function (msgdata) {
    const self = this;
    try {
        const frame = self.$serializer.derialize(msgdata);
        self.logger.info(`read. message cid:${frame.cid}, data[${msgdata.length}]bytes`);
        // self.logger.debug('websocket server message come! for cid:' + frame.cid);
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
        console.log(error);
        self.logger.fatal(`decrypt or derialize ws message  falied from server!`);
    }
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
    if (this.protocol === 'ws') {
        const websocketConn = this._wsConn;
        if (websocketConn && websocketConn.readyState === WebSocket.OPEN) {
            const encdata = this.$serializer.serialize(frame);
            this.logger.debug(`write ws tunnel cid:${frame.cid}, data[${encdata.length}]bytes`);
            websocketConn.send(encdata, { binary: true });
        }
    } else if (this.protocol === 'h2'||this.protocol==='tls') {
        const socket = this._httpConn||this._tlsConn;
        if (socket && socket.writable) {
            const encdata = this.$serializer.serialize(frame);
            this.logger.debug(`write http2 stream cid:${frame.cid}, data[${encdata.length}]bytes`);
            var datalen = encdata.length;
            socket.write(Buffer.concat([Buffer.from([datalen >> 8, datalen % 256]), encdata]));
        }
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
        this.setupTunnel();
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
