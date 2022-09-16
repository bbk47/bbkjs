const WebSocket = require('ws');
const tls = require('tls');
const http2 = require('http2');
const net = require('net');

exports.createWsServer = function (opts, handler, onReady) {
    const server = new WebSocket.Server({
        host: opts.listenAddr,
        port: opts.listenPort,
        path: opts.workPath,
        perMessageDeflate: false,
        // backlog: MAX_CONNECTIONS,
    });
    server.on('connection', handler);
    server.on('listening', onReady);
};

exports.createTcpServer = function (opts, handler, onReady) {
    // create a new server instance
    const server = net.createServer(handler);
    // Start listening on a specific port and address
    server.listen(opts.listenPort, opts.listenAddr, onReady);
};

exports.createTlsServer = function (tlsOpts, opts, handler, onReady) {
    // create a new server instance
    const server = tls.createServer(tlsOpts, handler);
    // Start listening on a specific port and address
    server.listen(opts.listenPort, opts.listenAddr, onReady);
};

exports.createHttp2Server = function (opts, handler, onReady) {
    // create a new server instance
    const server = http2.createServer();
    // the 'stream' callback is called when a new
    // stream is created. Or in other words, every time a
    // new request is received
    server.on('stream', handler);
    // Start listening on a specific port and address
    server.listen(opts.listenPort, opts.listenAddr, onReady);
};
