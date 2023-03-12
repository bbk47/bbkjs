const WebSocket = require('ws');
const net = require('net');
const http2 = require('http2');
const tls = require('tls');

const Transport = require('./transport');

exports.createWebsocketTransport = function (params, onOpen) {
    // tunnelWsUrl,  seed, method,password,protocol, host,port,path, ctrlcode,ctrlmethod,
    let tunnelWsUrl = `${params.secure ? 'wss' : 'ws'}://${params.host}:${params.port}${params.path}`;
    console.log('====wsurl:', tunnelWsUrl);
    const ws = new WebSocket(tunnelWsUrl, { perMessageDeflate: false, handshakeTimeout: 3000 });
    const ts = new Transport({ type: 'ws', conn: ws });
    ws.on('open', onOpen);
    return ts;
};

exports.createHttp2Transport = function (params, onOpen) {
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

    http2stream.on('ready', onOpen);
    const ts = new Transport({ type: 'h2', conn: http2stream });
    return ts;
};

exports.createTlsTransport = function (params, onOpen) {
    const tlsOpts = {
        rejectUnauthorized: false,
        host: params.host,
        port: params.port,
        // path: params.path,
    };
    const tlsConn = tls.connect(tlsOpts, function () {
        onOpen();
    });
    const ts = new Transport({ type: 'tls', conn: tlsConn });
    return ts;
};

exports.createTcpTransport = function (params, onOpen) {
    const socket = new net.Socket();
    socket.connect(params.port, params.host, function () {
        onOpen();
    });
    return new Transport({ type: 'tcp', conn: socket });
};

exports.createUnixsocketTransport = function (params, onOpen) {
    const socket = new net.Socket();
    socket.connect(params.path, function () {
        onOpen();
    });
    const ts = new Transport({ type: 'domainsocket', conn: socket });
    return ts;
};

exports.wrapSocket = function (type, conn) {
    return new Transport({ type, conn });
};
