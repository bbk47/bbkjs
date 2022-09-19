const net = require('net');
const http = require('http');
const protocol = require('./protocol');
const transport = require('./transport/index');
const frameSegment = require('./utils/segment');
const proxy = require('./proxy/index');
const serializerFn = require('./serializer');
const toolboxjs = require('@bbk47/toolbox');
const getRandomId = toolboxjs.uuid;
const socks5 = toolboxjs.socks5;
const loggerFn = toolboxjs.logger;

const TUNNEL_INIT = 0;
const TUNNEL_CONNECTING = 1;
const TUNNEL_OK = 2;
const PING_CID = '0'.repeat(32);
let retryCount = 0;

class Client {
    constructor(config) {
        this.listenAddr = config.listenAddr;
        this.listenPort = config.listenPort;
        this.listenHttpPort = config.listenHttpPort;

        this.opts = config;
        this.tlsOpts = {
            key: config.sslKey,
            cert: config.sslCrt,
            rejectUnauthorized: false,
        };
        // 内部属性
        this._remoteFrameQueue = [];
        this._tunnelStatus = TUNNEL_INIT;
        this._wsConn = null;
        this._httpConn = null;
        this._tlsConn = null;
        this._browserSockets = {};
        this.logger = loggerFn('c>', config.logLevel || 'error', config.logFile);
        this.$serializer = serializerFn(config.password, config.method);
    }

    setupTunnel() {
        this.logger.info('====>setuping tunnel');
        const tunnelOpts = this.opts.tunnelOpts;
        const params = tunnelOpts;
        this._tunnelStatus = TUNNEL_CONNECTING;
        const eventsHandler = [this.handleConnOpen.bind(this), this.handleConnMsg.bind(this), this.handleConnError.bind(this), this.handleConnClose.bind(this)];
        let tsport;
        this.logger.info(`create ${tunnelOpts.protocol} transport`);
        if (tunnelOpts.protocol === 'ws') {
            tsport = transport.createWebsocketTransport(params, ...eventsHandler);
        } else if (tunnelOpts.protocol === 'h2') {
            tsport = transport.createHttp2Transport(params, ...eventsHandler);
        } else if (tunnelOpts.protocol === 'tls') {
            tsport = transport.createTlsTransport(params, ...eventsHandler);
        } else if (tunnelOpts.protocol === 'tcp') {
            tsport = transport.createTcpTransport(params, ...eventsHandler);
        } else {
            this._tunnelStatus = TUNNEL_INIT;
            throw Error('un implement protocol!');
        }
        this._transport = tsport;
    }
    handleConnOpen() {
        this.logger.info('==<<<create tunnel ok');
        this._tunnelStatus = TUNNEL_OK;
        retryCount = 0;
        this.resetSockets();
    }
    handleConnMsg(msgdata) {
        try {
            const frame = this.$serializer.derialize(msgdata);
            this.logger.debug(`read. message cid:${frame.cid}, type:${frame.type}, data[${msgdata.length}]bytes`);
            // self.logger.debug('websocket server message come! for cid:' + frame.cid);
            if (frame.type === protocol.PONG_FRAME) {
                const now = Date.now();
                const upUst = frame.atime - frame.stime;
                const downUst = now - frame.atime;
                this.logger.info(`ws tunnel health！ up:${upUst}ms, down:${downUst}ms, rtt:${now - frame.stime}ms`);
                return;
            } else if (frame.type === protocol.EST_FRAME) {
                // 通知建立连接成功
                const browserObj = this._browserSockets[frame.cid];
                if (browserObj && browserObj.onSuccess) {
                    browserObj.onSuccess();
                    browserObj.timeoutId && clearTimeout(browserObj.timeoutId);
                    delete browserObj.timeoutId;
                    delete browserObj.onSuccess;
                    this.logger.info(`EST_FRAME: connect ${browserObj.remoteaddr} success!`);
                } else {
                    this.logger.info(`missing browser socket!`);
                }
            }
            this.flushLocalFrame(frame);
        } catch (error) {
            console.log(error);
            this.logger.fatal(`decrypt or derialize ws message  falied from server!`);
        }
    }
    handleConnError(err) {
        this.logger.error(`tunnel error:${err.message}!`);
        if (this._tunnelStatus !== TUNNEL_OK) {
            retryCount++;
            if (retryCount > 5) {
                this.logger.error(`connect server attach max try count!`);
                process.exit(-1);
            }
        }
    }
    handleConnClose(code) {
        this.logger.info(`tunnel closed! exit code:${code}!`);
        this._tunnelStatus = TUNNEL_INIT;
    }
    keepConnection() {
        const frame = { cid: PING_CID, type: protocol.PING_FRAME, data: Buffer.from(Date.now() + '') };
        this.flushRemoteFrame(frame);
    }

    flushLocalFrame(frame) {
        // console.log('flush local frame====>', frame.cid);
        const socketObj = this._browserSockets[frame.cid];
        if (!socketObj) return;
        const socket = socketObj.socket;
        if (socket && socket.readyState === 'open') {
            if (frame.type === protocol.STREAM_FRAME) {
                // console.log('write browser socket data:', frame.data.length);
                socket.write(frame.data);
            } else if (frame.type === protocol.FIN_FRAME) {
                socket.end();
                this.logger.debug('socket.end browser socket!');
            } else if (frame.type === protocol.RST_FRAME) {
                const errorMsg = frame.data[1] === 0x3 ? 'timeout' : 'error';
                this.logger.warn(`RST_FRAME: remote service connect target host [${errorMsg}]!`);
            }
        }
    }

    sendRemoteFrame(frame) {
        try {
            if (!this._transport) {
                throw Error('transport missing!');
            }
            const encdata = this.$serializer.serialize(frame);
            this._transport.sendPacket(encdata);
        } catch (err) {
            this.logger.error('transport send err:' + err.message);
            this._tunnelStatus = TUNNEL_INIT;
        }
    }

    flushRemoteFrame(frame) {
        if (frame) {
            this._remoteFrameQueue.push(frame);
        }
        if (this._tunnelStatus === TUNNEL_CONNECTING) {
            return;
        }
        if (this._tunnelStatus !== TUNNEL_OK) {
            this.setupTunnel();
            return;
        }
        while (this._remoteFrameQueue.length > 0) {
            const frame = this._remoteFrameQueue.shift();
            frameSegment(frame, (tinyframe) => this.sendRemoteFrame(tinyframe));
        }
    }

    resetSockets() {
        var bwsockets = this._browserSockets;
        this.logger.info('=============resetSockets=============');
        Object.keys(bwsockets).forEach((key) => {
            var obj = bwsockets[key];
            obj.socket && obj.socket.destroy();
            delete bwsockets[key];
        });
    }

    handleProxyConn(isConnect, socket) {
        const self = this;
        const connectionId = getRandomId();
        const browserObj = { id: connectionId, type: 'socks5', socket };
        self._browserSockets[connectionId] = browserObj;
        var proxyEvents = [
            function onConnect(addr, callback) {
                browserObj.onSuccess = callback;
                const addrInfo = socks5.parseSocks5Addr(addr);
                browserObj.remoteaddr = `${addrInfo.dstAddr}:${addrInfo.dstPort}`;
                self.flushRemoteFrame({ cid: connectionId, type: protocol.INIT_FRAME, data: addr });
                self.logger.info(`connecting ${browserObj.remoteaddr}!`);
                browserObj.timeoutId = setTimeout(() => {
                    browserObj.onSuccess = null;
                    self.logger.warn(`connect ${browserObj.remoteaddr} timeout! 10000ms exceeded!`);
                    callback(Error('timeout'));
                }, 10 * 1000);
            },
            function onData(data) {
                self.flushRemoteFrame({ cid: connectionId, type: protocol.STREAM_FRAME, data: data });
            },
            function onClose(err, code) {
                self.logger.debug(`fire event[close] on local connection!hadError:${err ? err.message : code}`);
                self.flushRemoteFrame({ cid: connectionId, type: protocol.FIN_FRAME, data: Buffer.from([0, 2]) });
            },
        ];
        isConnect ? proxy.createConnectProxy(socket, ...proxyEvents) : proxy.createSocks5Proxy(socket, ...proxyEvents);
    }
    initProxyServer(host, port, isConnect) {
        const onReady = (address) => this.logger.info('proxy server listen on tcp://' + address);
        proxy.createProxyServer(host, port, this.handleProxyConn.bind(this, isConnect), onReady);
    }
    bootstrap() {
        this.initProxyServer(this.listenAddr, this.listenPort);
        if (this.listenHttpPort) {
            this.initProxyServer(this.listenAddr, this.listenHttpPort, true);
        }
        this.opts.ping && setInterval(this.keepConnection.bind(this), 10000);
    }
}

module.exports = Client;
