const WebSocket = require('ws');
const net = require('net');
const http2 = require('http2');
const tls = require('tls');

const Transport = require('./transport');

exports.createWebsocketTransport = function (params,onReady) {
    // tunnelWsUrl,  seed, method,password,protocol, host,port,path, ctrlcode,ctrlmethod,
    let tunnelWsUrl = `${params.secure ? 'wss' : 'ws'}://${params.host}:${params.port}${params.path}`;
    console.log('====wsurl:', tunnelWsUrl);
    const ws = new WebSocket(tunnelWsUrl, { perMessageDeflate: false, handshakeTimeout: 3000 });
    const ts = new Transport('ws', ws);
    ws.on('open', onReady);
    return ts;
};

exports.createHttp2Transport = function (params, onReady) {
    const http2Url = `https://${params.host}:${params.port}`;
    // console.log('====http2Url:', http2Url);
    const client = http2.connect(http2Url, {
        rejectUnauthorized: false,
        requestCert: true,
    });

    const http2stream = client.request({
        ':method': 'POST',
        ':path': params.path || '/',
        'Content-Type': 'octet-stream',
    });

    http2stream.on('ready', onReady);
    const ts = new Transport('h2', http2stream);
    return ts;
};

exports.createTlsTransport = function (params,onReady) {
    const tlsOpts = {
        rejectUnauthorized: false,
        host: params.host,
        port: params.port,
        // path: params.path,
    };
    const tlsConn = tls.connect(tlsOpts, function(){
        onReady();
    });
    const ts = new Transport('tls', tlsConn);
    return ts;
};

exports.createTcpTransport = function (params,onReady) {
    const socket = new net.Socket();
    socket.connect(params.port, params.host, function(){
        onReady();
    });
    return new Transport('tcp', socket);
};

exports.createUnixsocketTransport = function (params, onReady) {
    const socket = new net.Socket();
    socket.connect(params.path, function () {
        onReady();
    });
    const ts = new Transport('domainsocket', socket);
    return ts;
};

exports.wrapSocket = function (type, socket) {
    return new Transport(type, socket);
};
