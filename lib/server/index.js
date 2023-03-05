const WebSocket = require('ws');
const tls = require('tls');
const http2 = require('http2');
const net = require('net');
const fs = require('fs');
const transport = require('../transport/index');

exports.createWsServer = function (opts, handler, onReady) {
    const server = new WebSocket.Server({
        host: opts.listenAddr,
        port: opts.listenPort,
        path: opts.workPath,
        perMessageDeflate: false,
        // backlog: MAX_CONNECTIONS,
    });
    server.on('connection', function (wsconn) {
        handler(transport.wrapSocket('ws', wsconn));
    });
    server.on('listening', onReady);
};

exports.createTcpServer = function (opts, handler, onReady) {
    // create a new server instance
    const server = net.createServer(function (conn) {
        handler(transport.wrapSocket('tcp', conn));
    });
    // Start listening on a specific port and address
    server.listen(opts.listenPort, opts.listenAddr, onReady);
};

exports.createUnixsocketServer = function (opts, handler, onReady) {
    // create a new server instance
    const server = net.createServer(function (conn) {
        handler(transport.wrapSocket('domainsocket', conn));
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
        handler(transport.wrapSocket('tls', conn));
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
        stream.respond({ ':status': 200 });
        handler(transport.wrapSocket('h2', stream));
    });
    // Start listening on a specific port and address
    server.listen(opts.listenPort, opts.listenAddr, onReady);
};
