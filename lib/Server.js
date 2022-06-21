const WebSocket = require('ws');
const tls = require('tls');
const http2 = require('http2');
const net = require('net');
const protocol = require('./protocol');
const serializerFn = require('./serializer');
const toolboxjs = require('@bbk47/toolbox');
const socks5 = toolboxjs.socks5;
const loggerFn = toolboxjs.logger;
const Encryptor = toolboxjs.encrypt.Encryptor;

const MAX_CONNECTIONS = 50000;
const DATA_MAX_SIZE = 1024 * 8;

function Server(config) {
    this.websocketUrl = `${config.listenAddr}:${config.listenPort}${config.websocketPath}`;
    this.websocketPath = config.websocketPath;
    this.listenAddr = config.listenAddr;
    this.listenPort = config.listenPort;
    this.protocol = config.protocol;
    this.tlsOpts = {
        key: config.sslKey,
        cert: config.sslCrt,
    }
    // 内部属性
    this._targetConnection = {};
    this.logger = loggerFn('s>', config.logLevel || 'error', config.logFile);
    this.$encryptor = new Encryptor(config.password, config.method);
    this.$serializer = serializerFn(config.password, config.method, config.rnglen);
}

Server.prototype.initServer = function () {
    const self = this;
    if (this.protocol === 'ws') {
        const server = new WebSocket.Server({
            host: self.listenAddr,
            port: self.listenPort,
            path: self.websocketPath,
            perMessageDeflate: false,
            backlog: MAX_CONNECTIONS,
        });
        self.server = server;
        server.on('connection', self.handleWsConn.bind(self));
        server.on('listening', function () {
            self.logger.info(`server listening on ws://${self.websocketUrl}`);
        });
    } else if (this.protocol === 'h2') {
        // create a new server instance
        const server = http2.createServer();
        // the 'stream' callback is called when a new
        // stream is created. Or in other words, every time a
        // new request is received
        server.on('stream', self.handleHttp2Conn.bind(self));
        // Start listening on a specific port and address
        server.listen(this.listenPort, this.listenAddr, function () {
            self.logger.info(`server listening on http://${self.listenAddr}:${self.listenPort}`);
        });
    }else if (this.protocol === 'tls') {
        // create a new server instance
        const server =tls.createServer(self.tlsOpts, function (connection) {
            console.log('new connection...');
            self.handleHttp2Conn(connection);
        })
        // Start listening on a specific port and address
        server.listen(this.listenPort, this.listenAddr, function () {
            self.logger.info(`server listening on http://${self.listenAddr}:${self.listenPort}`);
        });
    } else {
        throw Error('un implement protocol!');
    }
};

Server.prototype.handleHttp2Conn = function (stream, headers) {
    const self = this;
    console.log('handleHttp2Conn...');
    var buffcache = Buffer.from([]);
    var datalen = 0;
    var pack;
    stream.on('data', function (data) {
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
            self.handleClientMsg(stream, pack);
        }
    });
    stream.on('close', function (hadError) {
        self.logger.debug(`fire event[close] on client!hasError:${hadError}`);
    });
    stream.on('error', function (error) {
        self.logger.error(`fire event[error] on client!message:${error.message}`);
        stream.destroy();
    });
};
Server.prototype.handleWsConn = function (connection) {
    const self = this;
    connection.on('message', self.handleClientMsg.bind(this, connection));
    connection.on('close', function (hadError) {
        self.logger.debug(`fire event[close] on client!hasError:${hadError}`);
    });
    connection.on('error', function (error) {
        self.logger.error(`fire event[error] on client!message:${error.message}`);
        connection.close();
    });
};

Server.prototype.handleClientMsg = function (connection, msgdata) {
    const self = this;
    try {
        const frame = self.$serializer.derialize(msgdata);
        self.logger.debug(`read. ws tunnel cid:${frame.cid}, data[${msgdata.length}]bytes`);
        if (frame.type === protocol.PING_FRAME) {
            const now = Date.now();
            const buff = Buffer.concat([frame.data, Buffer.from(now + '')]);
            const respFrame = { cid: frame.cid, type: protocol.PONG_FRAME, data: buff };
            console.log('pong...');
            self.flusResponseFrame(connection, respFrame);
        } else {
            self.logger.debug('websocket client message come! cid:' + frame.cid);
            self.dispatchRequestFrame(connection, frame);
        }
    } catch (error) {
        console.log(error);
        const ip = connection._socket && connection._socket.remoteAddress;
        self.logger.fatal(`client:[${ip}] decrypt or derialize message falied!`);
    }
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
    const encData = this.$serializer.serialize(frame);
    this.logger.info(`write tunnel cid:${frame.cid}, data[${encData.length}]bytes`);
    if (this.protocol === 'ws') {
        client.send(encData, { binary: true });
    } else if (this.protocol === 'h2'||this.protocol==='tls') {
        var datalen = encData.length;
        client.write(Buffer.concat([Buffer.from([datalen >> 8, datalen % 256]), encData]));
    }
};

Server.prototype.flusResponseFrame = function (client, frame) {
    if (this.protocol === 'ws' && client.readyState !== WebSocket.OPEN) {
        return; // missing client connection
    }
    if (this.protocol === 'h2' && client.writable === false) {
        return; // missing client connection
    }
    if (this.protocol === 'tls' && client.writable === false) {
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
    if (frame.type === protocol.INIT_FRAME) {
        let targetObj = { dataCache: [] };
        let targetSocket = net.Socket();
        self._targetConnection[frame.cid] = targetObj;
        targetObj.status = 'connecting';
        const addrInfo = socks5.parseAddrInfo(frame.data);
        self.logger.info(`REQ REQUEST ===> ${addrInfo.dstAddr}:${addrInfo.dstPort}`);
        targetSocket.connect(addrInfo.dstPort, addrInfo.dstAddr, function () {
            self.logger.info(`connect success. ${addrInfo.dstAddr}:${addrInfo.dstPort}`);
            targetObj.status = 'connected';
            targetObj.socket = targetSocket;
            const respFrame = { cid: frame.cid, type: protocol.EST_FRAME, data: frame.data };
            self.flusResponseFrame(connection, respFrame);
            let firstData = Buffer.concat(targetObj.dataCache);
            targetSocket.write(firstData, function (err) {
                targetObj.dataCache = null;
            });
        });
        targetSocket.on('data', function (data) {
            // console.log('target server data come! for cid:' + frame.cid);
            const respFrame = { cid: frame.cid, type: protocol.STREAM_FRAME, data: data };
            self.flusResponseFrame(connection, respFrame);
        });
        targetSocket.on('close', function (hadError) {
            self.logger.debug(`fire event[close] on target[${addrInfo.dstAddr}:${addrInfo.dstPort}]!hasError:${hadError}`);
            self.cleanTargetCache(targetObj, frame);
            const respFrame = { cid: frame.cid, type: protocol.FIN_FRAME, data: Buffer.from([0, 1]) };
            self.flusResponseFrame(connection, respFrame);
        });
        targetSocket.on('error', function (err) {
            self.logger.error(`fire event[error] on target[${addrInfo.dstAddr}:${addrInfo.dstPort}]!message:${err.message}`);
            self.cleanTargetCache(targetObj, frame);
            const respFrame = { cid: frame.cid, type: protocol.RST_FRAME, data: Buffer.from([0, 2]) };
            self.flusResponseFrame(connection, respFrame);
        });
    } else if (frame.type === protocol.STREAM_FRAME) {
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
    } else if (frame.type === protocol.FIN_FRAME) {
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

Server.prototype.bootstrap = function () {
    this.initServer();
};
module.exports = Server;
