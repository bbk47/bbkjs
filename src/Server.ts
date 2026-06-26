import * as net from 'net';
import { socks5, logger, BbkStream } from '@bbk47/toolbox';
import type { Logger } from '@bbk47/toolbox';

interface BbkStreamEx extends BbkStream {
    cid: number;
    addr: Buffer;
}
import serializerFactory from './serializer';
import type { Serializer } from './serializer';
import * as transport from './transport';
import * as serverCreater from './frameServer';
import StubWorker from './stub/index';
import type { AppOptions } from './option';

class Server {
    private opts: AppOptions;
    private workMode: string;
    private tlsOpts: { key?: string; cert?: string };
    private listenAddr: string;
    private listenPort: number;
    private workPath: string;
    private logger: Logger;
    private $serializer: Serializer;
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
        this.$serializer = serializerFactory(config.password, config.method);
    }

    initServer(): void {
        const handlers: [(conn: unknown) => void] = [this.handleConnection.bind(this, this.workMode)];
        let serve: net.Server;

        if (this.workMode === 'ws') {
            serve = serverCreater.createWsServer(this.workPath, ...handlers);
        } else if (this.workMode === 'h2') {
            serve = serverCreater.createHttp2Server(this.tlsOpts, this.workPath, ...handlers) as unknown as net.Server;
        } else if (this.workMode === 'tls') {
            serve = serverCreater.createTlsServer(this.tlsOpts, ...handlers);
        } else if (this.workMode === 'tcp') {
            serve = serverCreater.createTcpServer(...handlers);
        } else {
            throw new Error('unimplement work mode!' + this.workMode);
        }

        serve.listen(this.listenPort, this.listenAddr);
        this._server = serve;
        this.logger.info(`broker server listening on ${this.workMode}://${this.listenAddr}:${this.listenPort}${this.workPath}`);
    }

    handleConnection(type: string, conn: unknown): void {
        const tsport = transport.wrapSocket(type as transport.Transport['type'], conn as net.Socket);
        const stubworker = new StubWorker(tsport, this.$serializer);
        stubworker.on('stream', this.handleStream.bind(this, stubworker));
        stubworker.on('error', this.handleConnError.bind(this, stubworker));
        stubworker.on('close', this.handleConnClose.bind(this, stubworker));
    }

    handleConnError(_stubworker: StubWorker, err: Error): void {
        this.logger.error(`fire event[error] on client!message:${err.message}`);
    }

    handleConnClose(_stubworker: StubWorker, code: number): void {
        this.logger.error(`fire event[close] on client!code:${code}`);
    }

    handleStream(stubworker: StubWorker, stream: BbkStreamEx, addrData: Buffer): void {
        const targetSocket = new net.Socket();
        const addrInfo = socks5.parseSocks5Addr(addrData);
        this.logger.info(`REQ REQUEST ===> ${addrInfo.dstAddr}:${addrInfo.dstPort}`);
        targetSocket.connect(addrInfo.dstPort, addrInfo.dstAddr, () => {
            this.logger.info(`connect success. ${addrInfo.dstAddr}:${addrInfo.dstPort}`);
            stubworker.setReady(stream);
            stream.pipe(targetSocket);
            targetSocket.pipe(stream);
        });
        targetSocket.on('close', () => stream.destroy());
        targetSocket.on('error', (err) => stream.destroy(err));
        stream.on('error', () => targetSocket.destroy());
    }

    bootstrap(): void {
        this.initServer();
    }
}

export default Server;
