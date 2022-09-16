const net = require('net');
const protocol = require('./protocol');
const server = require('./server/index');
const transport = require('./transport/index');
const serializerFn = require('./serializer');
const frameSegment = require('./utils/segment');
const toolboxjs = require('@bbk47/toolbox');
const Readable = require('stream').Readable;
const socks5 = toolboxjs.socks5;
const loggerFn = toolboxjs.logger;
const Encryptor = toolboxjs.encrypt.Encryptor;

class Server {
    constructor(config) {
        this.opts = config;
        this.workMode = config.workMode;
        this.tlsOpts = {
            key: config.sslKey,
            cert: config.sslCrt,
        };
        // 内部属性
        this._targetConnection = {};
        this.logger = loggerFn('s>', config.logLevel || 'error', config.logFile);
        this.$serializer = serializerFn(config.password, config.method);
    }
    initServer() {
        const params = this.opts;
        const onReady = () => {
            console.log(`server listen on ${params.workMode}://${params.listenAddr}:${params.listenPort}`);
        };
        const handlers = [this.handleConnection.bind(this, this.workMode), onReady];
        if (this.workMode === 'ws') {
            server.createWsServer(params, ...handlers);
        } else if (this.workMode === 'h2') {
            server.createHttp2Server(params, ...handlers);
        } else if (this.workMode === 'tls') {
            server.createTlsServer(this.tlsOpts, params, ...handlers);
        } else if (this.workMode === 'tcp') {
            server.createTcpServer(params, ...handlers);
        } else {
            throw Error('unimplement work mode!'+this.workMode);
        }
    }
    handleConnection(type, socket) {
        var eventsListen = [this.handleConnMessage.bind(this, socket), this.handleConnError.bind(this, socket), this.handleConnClose.bind(this, socket)];
        type === 'ws' ? transport.bindWebsocket(socket, ...eventsListen) : transport.bindStreamSocket(socket, ...eventsListen);
    }
    handleConnMessage(connection, packet) {
        try {
            const frame = this.$serializer.derialize(packet);
            this.logger.debug(`read. ws tunnel cid:${frame.cid}, data[${packet.length}]bytes`);
            if (frame.type === protocol.PING_FRAME) {
                const now = Date.now();
                const buff = Buffer.concat([frame.data, Buffer.from(now + '')]);
                const respFrame = { cid: frame.cid, type: protocol.PONG_FRAME, data: buff };
                // console.log('pong...');
                this.flusResponseFrame(connection, respFrame);
            } else {
                this.logger.debug('websocket client message come! cid:' + frame.cid);
                this.dispatchRequestFrame(connection, frame);
            }
        } catch (error) {
            console.log(error);
            const ip = connection._socket && connection._socket.remoteAddress;
            this.logger.fatal(`client:[${ip}] decrypt or derialize message falied!`);
        }
    }
    handleConnError(socket, err) {
        this.logger.error(`fire event[error] on client!message:${error.message}`);
        socket.close();
    }
    handleConnClose(socket, code) {
        this.logger.error(`fire event[close] on client!code:${code}`);
    }
    dispatchRequestFrame(connection, frame) {
        if (frame.type === protocol.INIT_FRAME) {
            let rs = new Readable();
            rs._read = () => {};
            const targetObj = { dataCache: rs };
            const targetSocket = net.Socket();
            this._targetConnection[frame.cid] = targetObj;
            const addrInfo = socks5.parseSocks5Addr(frame.data);
            this.logger.info(`REQ REQUEST ===> ${addrInfo.dstAddr}:${addrInfo.dstPort}`);
            targetSocket.connect(addrInfo.dstPort, addrInfo.dstAddr, () => {
                this.logger.info(`connect success. ${addrInfo.dstAddr}:${addrInfo.dstPort}`);
                targetObj.socket = targetSocket;
                targetObj.dataCache.pipe(targetSocket)
                const respFrame = { cid: frame.cid, type: protocol.EST_FRAME, data: frame.data };
                this.flusResponseFrame(connection, respFrame);
            });
            targetSocket.on('data', (data) => {
                // console.log('stream frame <<<<<=====')
                // console.log('target server data come! for cid:' + frame.cid);
                const respFrame = { cid: frame.cid, type: protocol.STREAM_FRAME, data: data };
                this.flusResponseFrame(connection, respFrame);
            });
            targetSocket.on('close', (hadError) => {
                this.logger.debug(`fire event[close] on target[${addrInfo.dstAddr}:${addrInfo.dstPort}]!hasError:${hadError}`);
                this.releaseTarget(frame);
                const respFrame = { cid: frame.cid, type: protocol.FIN_FRAME, data: Buffer.from([0, 1]) };
                this.flusResponseFrame(connection, respFrame);
            });
            targetSocket.on('error', (err) => {
                this.logger.error(`fire event[error] on target[${addrInfo.dstAddr}:${addrInfo.dstPort}]!message:${err.message}`);
                this.releaseTarget(frame);
                const respFrame = { cid: frame.cid, type: protocol.RST_FRAME, data: Buffer.from([0, 2]) };
                this.flusResponseFrame(connection, respFrame);
            });
        } else if (frame.type === protocol.STREAM_FRAME) {
            // console.log('stream frame===>')
            const targetObj = this._targetConnection[frame.cid];
            if (targetObj) {
                targetObj.dataCache.push(frame.data);
            } else {
                this.logger.debug('====STREAM_FRAME missing target connection!!');
            }
        } else if (frame.type === protocol.FIN_FRAME) {
            this.logger.debug('====FIN_FRAME from client, end target connection!');
            this.releaseTarget(frame);
        }
    }

    flusResponseFrame(client, frame) {
        frameSegment(frame, (tinyframe) => {
            const encData = this.$serializer.serialize(tinyframe);
            this.logger.info(`write tunnel cid:${frame.cid}, data[${encData.length}]bytes`);
            try {
                this.workMode === 'ws' ? transport.websocketSend(client, encData) : transport.tcpsocketSend(client, encData);
            } catch (err) {
                // console.log('send frame error====')
                this.releaseTarget(frame);
            }
        });
    }

    releaseTarget(frame) {
        const targetObj = this._targetConnection[frame.cid];
        if (targetObj && targetObj.socket) {
            targetObj.socket.destroy();
            targetObj.socket = null;
            targetObj.dataCache = null;
            delete this._targetConnection[frame.cid]; // 清楚由于target关闭的缓存数据
        }
    }

    bootstrap() {
        this.initServer();
    }
}

module.exports = Server;
