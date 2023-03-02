const WebSocket = require('ws');
const tls = require('tls');
const http2 = require('http2');
const net = require('net');
const fs = require('fs');
const TunnelConn = require('./conn');

exports.createWsServer = function (opts, handler, onReady) {
    const server = new WebSocket.Server({
        host: opts.listenAddr,
        port: opts.listenPort,
        path: opts.workPath,
        perMessageDeflate: false,
        // backlog: MAX_CONNECTIONS,
    });
    server.on('connection', function (wsconn) {
        const tunnelConn = new TunnelConn({ type: 'ws', conn: wsconn });
        handler(tunnelConn);
    });
    server.on('listening', onReady);
};

exports.createTcpServer = function (opts, handler, onReady) {
    // create a new server instance
    const server = net.createServer(function (conn) {
        const tunnelConn = new TunnelConn({ type: 'tcp', conn: conn });
        handler(tunnelConn);
    });
    // Start listening on a specific port and address
    server.listen(opts.listenPort, opts.listenAddr, onReady);
};

exports.createUnixsocketServer = function (opts, handler, onReady) {
    // create a new server instance
    const server = net.createServer(function (conn) {
        const tunnelConn = new TunnelConn({ type: 'tcp', conn: conn });
        handler(tunnelConn);
    });
    console.log('Checking for leftover socket.');
    fs.stat(opts.workPath, function (err, stats) {
        if (err) {
            // start server
            console.log('No leftover socket found.');
            // Start listening on a specific port and address
            server.listen(opts.workPath, onReady);
        }
        // remove file then start server
        console.log('Removing leftover socket.');
        fs.unlink(opts.workPath, function (err) {
            if (err) {
                // This should never happen.
                console.error(err);
                process.exit(0);
            }
            // Start listening on a specific port and address
            server.listen(opts.workPath, onReady);
        });
    });
};

exports.createTlsServer = function (tlsOpts, opts, handler, onReady) {
    // create a new server instance
    const server = tls.createServer(tlsOpts, function (conn) {
        const tunnelConn = new TunnelConn({ type: 'tls', conn: conn });
        handler(tunnelConn);
    });
    // Start listening on a specific port and address
    server.listen(opts.listenPort, opts.listenAddr, onReady);
};

exports.createHttp2Server = function (tlsOpts, opts, handler, onReady) {
    // create a new server instance
    const server = http2.createSecureServer(tlsOpts);
    // the 'stream' callback is called when a new
    // stream is created. Or in other words, every time a
    // new request is received
    server.on('stream', function (stream) {
        const tunnelConn = new TunnelConn({ type: 'h2', conn: stream });
        stream.respond({':status': 200});
        handler(tunnelConn);
    });
    // Start listening on a specific port and address
    server.listen(opts.listenPort, opts.listenAddr, onReady);
};
