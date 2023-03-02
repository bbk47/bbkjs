const WebSocket = require('ws');
const net = require('net');
const http2 = require('http2');
const tls = require('tls');

function bindStreamSocket(stream, onData, onError, onClose) {
    var buffcache = Buffer.from([]);
    stream.on('data', function (data) {
        buffcache = Buffer.concat([buffcache, data]);
        var datalen = 0;
        var pack;
        while (true) {
            if (buffcache.length <= 2) {
                return;
            }
            datalen = buffcache[0] * 256 + buffcache[1];
            if (buffcache.length < datalen + 2) {
                return;
            }
            pack = buffcache.slice(2, datalen + 2);
            buffcache = buffcache.slice(datalen + 2);
            onData(pack);
        }
    });
    stream.on('close', function (code) {
        onClose(code);
    });
    stream.on('error', function (err) {
        stream.destroy();
        onError(err);
    });
}

function bindWebsocket(ws, onData, onError, onClose) {
    ws.on('message', onData);
    ws.on('close', (code) => {
        // console.log('===close===',code);
        onClose(code);
    });
    ws.on('error', (err) => {
        // console.log('===error===')
        ws.close();
        onError(err);
    });
}

function tcpsocketSend(socket, data) {
    var datalen = data.length;
    socket.write(Buffer.concat([Buffer.from([datalen >> 8, datalen % 256]), data]));
    if (socket.writable) {
    } else {
        throw Error('socket cannot writeable!');
    }
}
function websocketSend(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(data, { binary: true });
    } else {
        throw Error('ws socket not open!' + ws.readyState);
    }
}

exports.createWebsocketTransport = function (params, onReady, onMessage, onError, onClose) {
    // tunnelWsUrl,  seed, method,password,protocol, host,port,path, ctrlcode,ctrlmethod,
    let tunnelWsUrl = `${params.secure ? 'wss' : 'ws'}://${params.host}:${params.port}${params.path}`;
    console.log('====wsurl:', tunnelWsUrl);
    const ws = new WebSocket(tunnelWsUrl, { perMessageDeflate: false, handshakeTimeout: 3000 });
    ws.on('open', onReady);
    ws.on('error', onError);
    bindWebsocket(ws, onMessage, onError, onClose);
    return {
        sendPacket: websocketSend.bind(null, ws),
        close: function () {
            ws.close();
        },
    };
};

exports.createHttp2Transport = function (params, onReady, onMessage, onError, onClose) {
    const http2Url = `https://${params.host}:${params.port}`;
    // console.log('====http2Url:', http2Url);
    const client = http2.connect(http2Url, {
        rejectUnauthorized: false,
        requestCert: true,
    });
    client.on('error', onError);

    const http2stream = client.request({
        ':method': 'POST',
        ':path': params.path || '/',
        'Content-Type': 'octet-stream',
    });

    http2stream.on('ready', () => setTimeout(onReady, 10));
    bindStreamSocket(http2stream, onMessage, onError, onClose);
    return {
        sendPacket: tcpsocketSend.bind(null, http2stream),
        close: function () {
            http2stream.end();
        },
    };
};

exports.createTlsTransport = function (params, onReady, onMessage, onError, onClose) {
    const tlsOpts = {
        rejectUnauthorized: false,
        host: params.host,
        port: params.port,
        // path: params.path,
    };
    const tlsConn = tls.connect(tlsOpts, function () {
        onReady();
    });
    bindStreamSocket(tlsConn, onMessage, onError, onClose);
    return {
        sendPacket: tcpsocketSend.bind(null, tlsConn),
        close: function () {
            tlsConn.end();
        },
    };
};

exports.createTcpTransport = function (params, onReady, onMessage, onError, onClose) {
    const socket = new net.Socket();
    socket.connect(params.port, params.host, function () {
        onReady();
    });
    bindStreamSocket(socket, onMessage, onError, onClose);
    return {
        sendPacket: tcpsocketSend.bind(null, socket),
        close: function () {
            socket.end();
        },
    };
};

exports.createUnixsocketTransport = function (params,onReady, onMessage, onError, onClose) {
    const socket = new net.Socket();
    socket.connect(params.path, function () {
        onReady();
    });
    bindStreamSocket(socket, onMessage, onError, onClose);
    return {
        sendPacket: tcpsocketSend.bind(null, socket),
        close: function () {
            socket.end();
        },
    };
};

exports.websocketSend = websocketSend;
exports.tcpsocketSend = tcpsocketSend;
exports.bindStreamSocket = bindStreamSocket;
exports.bindWebsocket = bindWebsocket;
