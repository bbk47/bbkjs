import * as net from 'net';
import * as tls from 'tls';
import * as http2 from 'http2';
import WebSocket from 'ws';

type TransportType = 'ws' | 'h2' | 'tls' | 'tcp' | 'domainsocket';

type AnyConn = WebSocket | net.Socket | tls.TLSSocket | http2.ClientHttp2Stream;
type StreamConn = net.Socket | tls.TLSSocket | http2.ClientHttp2Stream;

type DataListener = (data: Buffer) => void;
type ErrorListener = (err: Error) => void;
type CloseListener = (code?: number) => void;

function bindStreamSocket(s: StreamConn, onData: DataListener, onError: ErrorListener, onClose: CloseListener): void {
    let buffcache = Buffer.from([]);
    s.on('data', (data: Buffer) => {
        buffcache = Buffer.concat([buffcache, data]);
        while (true) {
            if (buffcache.length <= 2) return;
            const datalen = buffcache[0] * 256 + buffcache[1];
            if (buffcache.length < datalen + 2) return;
            const pack = buffcache.slice(2, datalen + 2);
            buffcache = buffcache.slice(datalen + 2);
            onData(pack);
        }
    });
    s.on('close', () => onClose());
    s.on('error', (err: Error) => {
        s.destroy();
        onError(err);
    });
}

function bindWebsocket(ws: WebSocket, onData: DataListener, onError: ErrorListener, onClose: CloseListener): void {
    ws.on('message', (msg: Buffer) => onData(msg));
    ws.on('close', (code: number) => onClose(code));
    ws.on('error', (err: Error) => {
        ws.close();
        onError(err);
    });
}

function tcpsocketSend(socket: StreamConn, data: Buffer): void {
    const datalen = data.length;
    if (socket.writable) {
        socket.write(Buffer.concat([Buffer.from([datalen >> 8, datalen % 256]), data]));
    } else {
        throw new Error('socket cannot writeable!');
    }
}

function websocketSend(ws: WebSocket, data: Buffer): void {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(data, { binary: true });
    } else {
        throw new Error('ws socket not open!' + ws.readyState);
    }
}

export class Transport {
    type: TransportType;
    conn: AnyConn;

    constructor(opts: { type: TransportType; conn: AnyConn }) {
        this.type = opts.type;
        this.conn = opts.conn;
    }

    sendPacket(binarydata: Buffer): void {
        if (this.type === 'ws') {
            websocketSend(this.conn as WebSocket, binarydata);
        } else {
            tcpsocketSend(this.conn as StreamConn, binarydata);
        }
    }

    bindEvents(onData: DataListener, onError: ErrorListener, onClose: CloseListener): void {
        if (this.type === 'ws') {
            bindWebsocket(this.conn as WebSocket, onData, onError, onClose);
        } else {
            bindStreamSocket(this.conn as StreamConn, onData, onError, onClose);
        }
    }

    close(): void {
        try {
            if (this.type === 'ws') {
                (this.conn as WebSocket).close();
            } else if (this.type === 'h2') {
                const stream = this.conn as http2.ClientHttp2Stream;
                stream.close();
                stream.session?.destroy();
            } else {
                (this.conn as net.Socket).destroy();
            }
        } catch (_err) {
            // ignore
        }
    }
}

export interface TunnelOpts {
    protocol: string;
    host: string;
    port: number;
    path?: string;
    secure?: boolean;
}

export function createWebsocketTransport(params: TunnelOpts, onOpen: () => void): Transport {
    const url = `${params.secure ? 'wss' : 'ws'}://${params.host}:${params.port}${params.path ?? ''}`;
    const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 3000 });
    const ts = new Transport({ type: 'ws', conn: ws });
    ws.on('open', onOpen);
    return ts;
}

export function createHttp2Transport(params: TunnelOpts, onOpen: () => void): Transport {
    const http2Url = `https://${params.host}:${params.port}`;
    const client = http2.connect(http2Url, { rejectUnauthorized: false, requestCert: true });
    const stream = client.request({
        ':method': 'POST',
        ':path': params.path ?? '/',
        'Content-Type': 'octet-stream',
    });
    stream.on('response', onOpen);
    return new Transport({ type: 'h2', conn: stream });
}

export function createTlsTransport(params: TunnelOpts, onOpen: () => void): Transport {
    const tlsConn = tls.connect({ rejectUnauthorized: false, host: params.host, port: params.port }, onOpen);
    return new Transport({ type: 'tls', conn: tlsConn });
}

export function createTcpTransport(params: TunnelOpts, onOpen: () => void): Transport {
    const socket = new net.Socket();
    socket.connect(params.port, params.host, onOpen);
    return new Transport({ type: 'tcp', conn: socket });
}

export function createUnixsocketTransport(params: TunnelOpts, onOpen: () => void): Transport {
    const socket = new net.Socket();
    socket.connect(params.path ?? '', onOpen);
    return new Transport({ type: 'domainsocket', conn: socket });
}

export function wrapSocket(type: TransportType, conn: AnyConn): Transport {
    return new Transport({ type, conn });
}
