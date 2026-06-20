const net = require('net');
const http = require('http');
const tls = require('tls');
const http2 = require('http2');
const url = require('url');
const WebSocket = require('ws');

function createWsServer(workPath, handler, httpHandler) {
    const server = http.createServer(function (req, res) {
        if (httpHandler) {
            httpHandler(req, res);
        }
    });
    // ws 2.x exposes Server as WebSocket.Server
    const WsServer = WebSocket.Server;
    const wss = new WsServer({ noServer: true, clientTracking: false });
    wss.on('connection', function (wsconn) {
        handler(wsconn);
    });
    server.on('upgrade', function (request, socket, head) {
        const pathname = url.parse(request.url || '').pathname;
        if (pathname === workPath) {
            wss.handleUpgrade(request, socket, head, function done(ws) {
                wss.emit('connection', ws, request);
            });
        } else {
            socket.destroy();
        }
    });
    return server;
}

function createHttp2Server(tlsOpts, workPath, handler, httpHandler) {
    const http2Opts = Object.assign({ allowHTTP1: true }, tlsOpts);
    const server = http2.createSecureServer(http2Opts, function (req, res) {
        if (httpHandler) {
            httpHandler(req, res);
        }
    });
    server.on('stream', function (stream, headers) {
        const path = headers[':path'];
        if (path === workPath) {
            handler(stream);
        } else {
            stream.destroy();
        }
    });
    return server;
}

function createTcpServer(handler) {
    const server = net.createServer(function (conn) {
        handler(conn);
    });
    return server;
}

function createTlsServer(tlsOpts, handler) {
    const server = tls.createServer(tlsOpts, function (conn) {
        handler(conn);
    });
    return server;
}

module.exports = {
    createWsServer,
    createHttp2Server,
    createTcpServer,
    createTlsServer,
};
