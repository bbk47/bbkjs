import * as net from 'net';
import * as tls from 'tls';
import * as http2 from 'http2';
import { Duplex } from 'stream';
import { WebSocket } from 'ws';
import { WsConn } from './tunnel/wsconn';
import type { TunnelOpts } from './option';

// 本文件提供"裸字节流"拨号：不做任何应用层分帧，直接把载体连接作为 Duplex 返回，
// 交由上层 (SecureConn + yamux) 处理。与 bbk-go src/transport/raw.go 对齐。

const DIAL_TIMEOUT = 10 * 1000;

function dialTcp(host: string, port: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        socket.setTimeout(DIAL_TIMEOUT, () => socket.destroy(new Error('tcp dial timeout')));
        socket.once('connect', () => {
            socket.setTimeout(0);
            resolve(socket);
        });
        socket.once('error', reject);
        socket.connect(port, host);
    });
}

function dialTls(host: string, port: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => resolve(socket));
        socket.once('error', reject);
    });
}

function dialH2(host: string, port: number, path: string): Promise<Duplex> {
    return new Promise((resolve, reject) => {
        const client = http2.connect(`https://${host}:${port}`, { rejectUnauthorized: false });
        client.once('error', reject);
        const stream = client.request({
            ':method': 'POST',
            ':path': path || '/',
            'content-type': 'application/octet-stream',
        });
        stream.once('response', () => resolve(stream as unknown as Duplex));
        stream.once('error', reject);
    });
}

function dialWs(host: string, port: number, path: string, secure: boolean): Promise<Duplex> {
    return new Promise((resolve, reject) => {
        const wsURL = secure ? `wss://${host}:${port}${path}` : `ws://${host}:${port}${path}`;
        const ws = new WebSocket(wsURL, { perMessageDeflate: false, handshakeTimeout: 3000, rejectUnauthorized: false });
        ws.once('open', () => resolve(new WsConn(ws)));
        ws.once('error', reject);
    });
}

// dialRawCarrier 按隧道协议建立一条裸字节流(Duplex)，WebSocket 经字节流适配器包装。
// 加密与多路复用由上层(SecureConn + yamux)负责。
export function dialRawCarrier(opts: TunnelOpts): Promise<Duplex> {
    switch (opts.protocol) {
        case 'tcp':
            return dialTcp(opts.host, opts.port);
        case 'tls':
            return dialTls(opts.host, opts.port);
        case 'h2':
            return dialH2(opts.host, opts.port, opts.path);
        case 'ws':
        case 'wss':
            return dialWs(opts.host, opts.port, opts.path, opts.secure || opts.protocol === 'wss');
        default:
            return Promise.reject(new Error(`unsupport tunnel protocol [${opts.protocol}]`));
    }
}
