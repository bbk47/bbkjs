const net = require('net');
const http = require('http');
const tls = require('tls');
const http2 = require('http2');
const url = require('url');
const WebSocket = require('ws');

exports.createWsServer = function (workPath, handler, httpHandler) {
    const server = http.createServer(function (req, res) {
        if (httpHandler) {
            httpHandler(req, res);
        }
    });
    const wss = new WebSocket.Server({ noServer: true, clientTracking: false });
    wss.on('connection', function (wsconn) {
        handler(wsconn);
    });
    server.on('upgrade', function (request, socket, head) {
        const pathname = url.parse(request.url).pathname;
        if (pathname === workPath) {
            wss.handleUpgrade(request, socket, head, function done(ws) {
                wss.emit('connection', ws, request);
            });
        } else {
            socket.destroy();
        }
    });
    return server;
};
exports.createHttp2Server = function (tlsOpts, workPath, handler, httpHandler) {
    const http2Opts = Object.assign({ allowHTTP1: true }, tlsOpts);
    server = http2.createSecureServer(http2Opts, function (req, res) {
        if (httpHandler) {
            httpHandler(req, res);
        }
    });
    server.on('stream', function (stream, headers) {
        const path = headers[':path'];
        if (path === workPath) {
            handler(stream);
            return;
        } else {
            stream.destroy();
        }
    });
    return server;
};

exports.createTcpServer = function (handler) {
    server = net.createServer(function (conn) {
        handler(conn);
    });
    return server;
};

exports.createTlsServer = function (tlsOpts, handler) {
    server = tls.createServer(tlsOpts, function (conn) {
        handler(conn);
    });
    return server;
};
