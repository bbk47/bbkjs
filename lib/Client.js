const net = require('net');
const uuid = require('uuid').v4;
const WebSocket = require('ws');
const meta = require('./meta');

const MAX_CONNECTIONS = 50000;
const DATA_MAX_SIZE = 1024;

const WEBSOCKET_INIT = 0;
const WEBSOCKET_CONNECTING = 1;
const WEBSOCKET_READY = 2;
const WEBSOCKET_DESTORYED = 3;

function Client(config) {
    const uri = `${config.serverAddress}:${config.serverPort}${config.websocketUri}`;
    this.websocketUrl = config.tls ? `wss://${uri}` : `ws://${uri}`;
    this.localAddress = config.localAddress;
    this.localPort = config.localPort;
    this.logLevel = config.logLevel || 'error';
    this.logFile = null;
    this._remoteFrameQueue = [];
    this._localFrameQueue = [];
    this._wsStatus = WEBSOCKET_INIT;
    this._wsConnection = null;
    this._browserSockets = {};
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
        console.info(`end event of client connection has been triggered`);
        stage = 'DESTORYED';
        self.flushRemoteFrame({ cid: connectionId, type: meta.FIN_FRAME, data: Buffer.from([0, 1]) });
    });
    socket.on('close', function (hadError) {
        console.info(`close event of client connection has been triggered!hadError:${hadError}`);
        stage = 'DESTORYED';
        socket.destroy();
        self.flushRemoteFrame({ cid: connectionId, type: meta.FIN_FRAME, data: Buffer.from([0, 1]) });
    });
    socket.on('error', function (error) {
        console.info(`error event of client connection has been triggered!message:${error.message}`);
        stage = 'DESTORYED';
        socket.destroy();
        self.flushRemoteFrame({ cid: connectionId, type: meta.FIN_FRAME, data: Buffer.from([0, 1]) });
    });
};

Client.prototype.setupWsConnection = function () {
    const self = this;
    const ws = new WebSocket(self.websocketUrl, { perMessageDeflate: false });
    self._wsStatus = WEBSOCKET_CONNECTING;
    ws.on('open', function () {
        self._wsStatus = WEBSOCKET_READY;
        console.log('open websocket success url:' + self.websocketUrl);
        self._wsConnection = ws;
        self.flushRemoteFrame();
    });
    ws.on('message', function (data) {
        const frame = meta.derialize(data);
        // console.log('websocket server message come! for cid:' + frame.cid);
        if (frame.type === meta.PONG_FRAME) {
            let stTimeBuf = frame.data.slice(0, 13);
            let serverTimeBuf = frame.data.slice(13, 26);
            let start = stTimeBuf.toString('ascii');
            let finsish = serverTimeBuf.toString('ascii');
            ws.healthy = parseInt(finsish) - parseInt(start);
            console.log(`websocket connection health:${ws.healthy}ms`);
            return;
        }
        self.flushLocalFrame(frame);
    });
    ws.on('close', function (event) {
        console.log(`close event of websocket connection has been triggered!`, event);
        self._wsStatus = WEBSOCKET_DESTORYED;
        self._wsConnection = null;
        ws.close();
    });
    ws.on('error', function (err) {
        self._wsStatus = WEBSOCKET_DESTORYED;
        console.log(`error event of websocket connection has been triggered!${err.message}`);
        self._wsConnection = null;
        ws.close();
    });
};

Client.prototype.keepConnection = function () {
    const websocketConn = this._wsConnection;
    if (websocketConn && websocketConn.readyState === WebSocket.OPEN) {
        const now = Date.now();
        const frame = { type: meta.PING_FRAME, data: Buffer.from(now + '') };
        websocketConn.send(meta.serialize(frame), { binary: true });
    }
};

Client.prototype.flushLocalFrame = function (frame) {
    const socket = this._browserSockets[frame.cid];
    if (socket && socket.readyState === 'open') {
        if (frame.type === meta.STREAM_FRAME) {
            socket.write(frame.data);
        } else if (frame.type === meta.FIN_FRAME) {
            socket.end();
            console.log('socket.end browser socket!');
        } else if (frame.type === meta.RST_FRAME) {
            socket.destroy();
            console.log('socket.destory browser socket!');
        }
    }
};

Client.prototype.sendRemoteFrame = function (frame) {
    const websocketConn = this._wsConnection;
    if (websocketConn && websocketConn.readyState === WebSocket.OPEN) {
        websocketConn.send(meta.serialize(frame), { binary: true });
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
    setInterval(this.keepConnection.bind(this), 5000);
};
module.exports = Client;
