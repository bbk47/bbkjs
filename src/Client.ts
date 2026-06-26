import * as net from 'net';
import * as dgram from 'dgram';
import { socks5, logger, retry, deferred, proxy, BbkStream } from '@bbk47/toolbox';
import type { Logger } from '@bbk47/toolbox';
import serializerFactory from './serializer';
import type { Serializer } from './serializer';
import * as tscreater from './transport';
import type { Transport } from './transport';
import StubWorker from './stub/index';
import type { AppOptions } from './option';

interface BbkStreamEx extends BbkStream {
    cid: number;
}

interface BrowserObj {
    type: string;
    defer: ReturnType<typeof deferred>;
    addr: Buffer;
    remoteaddr: string;
}

class Client {
    private cliOpts: AppOptions;
    private tlsOpts: { key?: string; cert?: string; rejectUnauthorized: boolean };
    private _browserObjects: Record<number, BrowserObj>;
    private logger: Logger;
    private $serializer: Serializer;
    private _stubclient?: StubWorker;
    private _tunnelReadyPm?: Promise<void>;
    _proxyServers?: net.Server[];

    constructor(config: AppOptions) {
        this.cliOpts = config;
        this.tlsOpts = {
            key: config.sslKey,
            cert: config.sslCrt,
            rejectUnauthorized: false,
        };
        this._browserObjects = {};
        this.logger = logger('c>', (config.logLevel as Parameters<typeof logger>[1]) || 'error', config.logFile);

        const tunopts = config.tunnelOpts;
        this.$serializer = serializerFactory(tunopts.password, tunopts.method);
    }

    createTransport(opts: AppOptions['tunnelOpts']): Promise<Transport> {
        return new Promise((resolve, reject) => {
            let tsport: Transport | undefined;
            const onOpen = () => resolve(tsport!);
            const { protocol } = opts;
            if (protocol === 'ws' || protocol === 'wss') {
                tsport = tscreater.createWebsocketTransport(opts, onOpen);
            } else if (protocol === 'h2') {
                tsport = tscreater.createHttp2Transport(opts, onOpen);
            } else if (protocol === 'tls') {
                tsport = tscreater.createTlsTransport(opts, onOpen);
            } else if (protocol === 'tcp') {
                tsport = tscreater.createTcpTransport(opts, onOpen);
            } else if (protocol === 'unix' || protocol === 'domainsocket') {
                tsport = tscreater.createUnixsocketTransport(opts, onOpen);
            } else {
                return reject(new Error('unsupport tunnel protocol:' + protocol));
            }
            if (tsport?.conn && typeof (tsport.conn as net.Socket).once === 'function') {
                (tsport.conn as net.Socket).once('error', reject);
            }
        });
    }

    async setupTunnel(): Promise<void> {
        try {
            const tunnelOpts = this.cliOpts.tunnelOpts;
            this.logger.info(`creating ${tunnelOpts.protocol} transport`);
            const taskfn = () => this.createTransport(tunnelOpts);
            const tsport = await retry(taskfn, { times: 5, interval: 3000 });
            this._stubclient = new StubWorker(tsport, this.$serializer);
            this.bindTunnelEvent();
        } catch (error) {
            this.logger.error(`tunnel error:${(error as Error).message}!`);
            process.exit(-1);
        }
    }

    bindTunnelEvent(): void {
        const stubclient = this._stubclient!;
        stubclient.on('pong', (event: { up: number; down: number }) => {
            this.logger.info(`tunnel health！ up:${event.up}ms, down:${event.down}ms, rtt:${event.up + event.down}ms`);
        });
        stubclient.on('stream', this.handleStream.bind(this));
        stubclient.on('error', this.handleConnError.bind(this));
        stubclient.on('close', this.handleConnClose.bind(this));
    }

    handleConnError(err: Error): void {
        this.logger.error(`tunnel error:${err.message}!`);
        this._tunnelReadyPm = undefined;
    }

    handleConnClose(code: number): void {
        this.logger.info(`tunnel closed! exit code:${code}!`);
        this._tunnelReadyPm = undefined;
    }

    handleStream(stream: BbkStreamEx): void {
        const targetObj = this._browserObjects[stream.cid];
        targetObj?.defer.resolve(stream);
    }

    keepConnection(): Promise<void> {
        return this.setupEnv().then(() => this._stubclient!.ping());
    }

    async setupStream(browserObj: BrowserObj): Promise<BbkStream> {
        await this.setupEnv();
        const stream = this._stubclient!.startStream(browserObj.addr) as BbkStreamEx;
        this._browserObjects[stream.cid] = browserObj;
        const timeoutPm = new Promise<BbkStream>((_, reject) => {
            setTimeout(() => reject(new Error(`${browserObj.remoteaddr} timeout! 30000ms exceeded!`)), 30 * 1000);
        });
        return Promise.race([browserObj.defer.promise as Promise<BbkStream>, timeoutPm]);
    }

    setupEnv(): Promise<void> {
        if (!this._tunnelReadyPm) {
            this._tunnelReadyPm = this.setupTunnel();
        }
        return this._tunnelReadyPm;
    }

    handleProxyConn(isConnect: boolean, cSocket: net.Socket): void {
        const onConnect = async (addr: Buffer, callback: (err?: Error) => void) => {
            try {
                const addrInfo = socks5.parseSocks5Addr(addr);
                const remoteaddr = `${addrInfo.dstAddr}:${addrInfo.dstPort}`;
                const browserObj: BrowserObj = { type: 'socks5', defer: deferred(), addr, remoteaddr };
                this.logger.info(`connecting ${browserObj.remoteaddr}!`);
                const stream = await this.setupStream(browserObj);
                callback();
                this.logger.info(`stream connect:${browserObj.remoteaddr} success`);
                cSocket.pipe(stream);
                stream.pipe(cSocket);
                cSocket.on('close', () => stream.destroy());
                cSocket.on('error', (err) => stream.destroy(err));
                stream.on('close', () => cSocket.destroy());
            } catch (error) {
                this.logger.warn((error as Error).message);
                callback(new Error('timeout'));
            }
        };
        const onUdpAssociate = async (udpSocket: dgram.Socket, ctrlSocket: net.Socket) => {
            try {
                await this.setupEnv();
            } catch (_err) {
                udpSocket.close();
                return;
            }
            let browserAddr: dgram.RemoteInfo | null = null;

            const cid = this._stubclient!.startUdpSession((addrBuf: Buffer, payload: Buffer) => {
                if (!browserAddr) return;
                const header = Buffer.concat([Buffer.from([0x00, 0x00, 0x00]), addrBuf]);
                udpSocket.send(Buffer.concat([header, payload]), browserAddr.port, browserAddr.address, (err) => {
                    if (err) this.logger.warn('udp send to browser error: ' + err.message);
                });
            });

            udpSocket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
                browserAddr = rinfo;
                try {
                    const { addrBuf, payload } = parseSocks5UdpDatagram(msg);
                    this._stubclient!.sendUdpDatagram(cid, addrBuf, payload);
                } catch (err) {
                    this.logger.warn('udp parse error: ' + (err as Error).message);
                }
            });

            const cleanup = () => {
                this._stubclient?.closeUdpSession(cid);
                try { udpSocket.close(); } catch (_) {}
            };
            ctrlSocket.on('close', cleanup);
            ctrlSocket.on('error', cleanup);
            udpSocket.on('error', () => {
                this._stubclient?.closeUdpSession(cid);
            });
        };
        isConnect ? proxy.createConnectProxy(cSocket, onConnect) : proxy.createSocks5Proxy(cSocket, onConnect, onUdpAssociate);
    }

    initProxyServer(host: string, port: number, isConnect = false): void {
        const server = net.createServer({ allowHalfOpen: true });
        server.on('connection', this.handleProxyConn.bind(this, isConnect));
        server.listen(port, host, () => {
            this.logger.info('proxy server listen on tcp://' + host + ':' + port);
        });
        this._proxyServers = this._proxyServers ?? [];
        this._proxyServers.push(server);
    }

    bootstrap(): void {
        this.initProxyServer(this.cliOpts.listenAddr, this.cliOpts.listenPort);
        if (this.cliOpts.listenHttpPort) {
            this.initProxyServer(this.cliOpts.listenAddr, this.cliOpts.listenHttpPort, true);
        }
        if (this.cliOpts.ping) {
            setInterval(this.keepConnection.bind(this), 3000);
        }
    }
}

// SOCKS5 UDP 数据报: RSV(2)+FRAG(1)+ATYP(1)+ADDR(var)+PORT(2)+DATA
function parseSocks5UdpDatagram(buf: Buffer): { addrBuf: Buffer; payload: Buffer } {
    const atyp = buf[3];
    let addrEnd: number;
    if (atyp === 0x01) {
        addrEnd = 3 + 1 + 4 + 2;
    } else if (atyp === 0x03) {
        addrEnd = 3 + 1 + 1 + buf[4] + 2;
    } else if (atyp === 0x04) {
        addrEnd = 3 + 1 + 16 + 2;
    } else {
        throw new Error('unsupported SOCKS5 UDP ATYP: ' + atyp);
    }
    return { addrBuf: buf.slice(3, addrEnd), payload: buf.slice(addrEnd) };
}

export default Client;
