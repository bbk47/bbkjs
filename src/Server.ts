import * as net from 'net';
import { socks5, logger } from '@bbk47/toolbox';
import type { Logger } from '@bbk47/toolbox';
import { Duplex } from 'stream';
import type WebSocket from 'ws';
import * as serverCreater from './frameServer';
import { SecureConn, Session, WsConn } from './tunnel';
import type { TunnelStream } from './tunnel';
import { relay } from './utils';
import { serveUDP, isUDPMarker } from './proxy/udp';
import type { AppOptions } from './option';

class Server {
    private opts: AppOptions;
    private workMode: string;
    private tlsOpts: { key?: string; cert?: string };
    private listenAddr: string;
    private listenPort: number;
    private workPath: string;
    private logger: Logger;
    _server?: net.Server;

    constructor(config: AppOptions) {
        this.opts = config;
        this.workMode = config.workMode;
        this.tlsOpts = {
            key: config.sslKey,
            cert: config.sslCrt,
        };
        this.listenAddr = config.listenAddr;
        this.listenPort = config.listenPort;
        this.workPath = config.workPath;
        this.logger = logger('s>', (config.logLevel as Parameters<typeof logger>[1]) || 'error', config.logFile);
    }

    private initServer(): void {
        const onConn = (conn: unknown) => this.handleConnection(this.workMode, conn);
        let serve: net.Server;

        if (this.workMode === 'ws') {
            serve = serverCreater.createWsServer(this.workPath, onConn);
        } else if (this.workMode === 'h2') {
            serve = serverCreater.createHttp2Server(this.tlsOpts, this.workPath, onConn) as unknown as net.Server;
        } else if (this.workMode === 'tls') {
            serve = serverCreater.createTlsServer(this.tlsOpts, onConn);
        } else if (this.workMode === 'tcp') {
            serve = serverCreater.createTcpServer(onConn);
        } else {
            throw new Error('unimplement work mode!' + this.workMode);
        }

        serve.listen(this.listenPort, this.listenAddr);
        this._server = serve;
        this.logger.info(`broker server listening on ${this.workMode}://${this.listenAddr}:${this.listenPort}${this.workPath}`);
    }

    // serverCarrier 把接受到的隧道连接转成裸字节流(Duplex)。
    private serverCarrier(type: string, conn: unknown): Duplex {
        if (type === 'ws') {
            return new WsConn(conn as WebSocket);
        }
        // h2 stream / tcp / tls 本身即 Duplex 字节流。
        return conn as Duplex;
    }

    private async handleConnection(type: string, conn: unknown): Promise<void> {
        const raw = this.serverCarrier(type, conn);
        let secure: SecureConn;
        try {
            secure = await SecureConn.serverSecure(raw, this.opts.method, this.opts.password);
        } catch (err) {
            this.logger.error(`secure handshake err:${(err as Error).message}`);
            raw.destroy();
            return;
        }
        const sess = new Session(secure, true);
        sess.on('stream', (stream: TunnelStream) => this.handleStream(stream));
        sess.on('error', (err: Error) => this.logger.error(`session err:${err.message}`));
    }

    private handleStream(stream: TunnelStream): void {
        if (isUDPMarker(stream.addr)) {
            this.logger.info('REQ UDP ASSOCIATE');
            stream.setReady();
            serveUDP(stream, this.logger);
            return;
        }

        const addrInfo = socks5.parseSocks5Addr(stream.addr);
        const remoteAddr = `${addrInfo.dstAddr}:${addrInfo.dstPort}`;
        this.logger.info(`REQ CONNECT=>${remoteAddr}`);

        const target = new net.Socket({ allowHalfOpen: true });
        target.setTimeout(15000, () => target.destroy(new Error('dial timeout')));
        target.connect(addrInfo.dstPort, addrInfo.dstAddr, () => {
            target.setTimeout(0);
            this.logger.info(`DIAL SUCCESS==>${remoteAddr}`);
            stream.setReady();
            relay(stream, target, this.logger);
        });
        target.on('error', () => {
            // 不发就绪状态：client 侧 OpenStream 会收到 FIN/超时（等价旧的"无 EST"）。
            stream.closeWrite();
            stream.destroy();
        });
    }

    bootstrap(): void {
        this.initServer();
    }

    close(): void {
        try {
            this._server?.close();
        } catch (_e) {
            // ignore
        }
    }
}

export default Server;
