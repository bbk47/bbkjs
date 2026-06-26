import * as net from 'net';
import * as http from 'http';
import * as tls from 'tls';
import * as http2 from 'http2';
import * as url from 'url';
import WebSocket from 'ws';

type ConnHandler = (conn: unknown) => void;
type HttpHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export function createWsServer(workPath: string, handler: ConnHandler, httpHandler?: HttpHandler): http.Server {
    const server = http.createServer((req, res) => {
        httpHandler && httpHandler(req, res);
    });
    const wss = new WebSocket.Server({ noServer: true, clientTracking: false });
    wss.on('connection', (wsconn) => handler(wsconn));
    server.on('upgrade', (request, socket, head) => {
        const pathname = url.parse(request.url ?? '').pathname;
        if (pathname === workPath) {
            wss.handleUpgrade(request, socket as net.Socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else {
            socket.destroy();
        }
    });
    return server;
}

export function createHttp2Server(tlsOpts: tls.TlsOptions, workPath: string, handler: ConnHandler, httpHandler?: HttpHandler): http2.Http2SecureServer {
    const http2Opts = { allowHTTP1: true, ...tlsOpts };
    const server = http2.createSecureServer(http2Opts, (req, res) => {
        httpHandler && httpHandler(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
    });
    server.on('stream', (stream, headers) => {
        const path = headers[':path'];
        if (path === workPath) {
            handler(stream);
        } else {
            stream.destroy();
        }
    });
    return server;
}

export function createTcpServer(handler: ConnHandler): net.Server {
    return net.createServer((conn) => handler(conn));
}

export function createTlsServer(tlsOpts: tls.TlsOptions, handler: ConnHandler): tls.Server {
    return tls.createServer(tlsOpts, (conn) => handler(conn));
}
