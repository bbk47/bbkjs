const WebSocket = require('ws');
const net = require('net');
const http2 = require('http2');
const tls = require('tls');
const WebSocket = require('ws');

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
    if (socket.writable) {
        socket.write(Buffer.concat([Buffer.from([datalen >> 8, datalen % 256]), data]));
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

exports.websocketSend = websocketSend;
exports.tcpsocketSend = tcpsocketSend;
exports.bindStreamSocket = bindStreamSocket;
exports.bindWebsocket = bindWebsocket;



class Transport {
    constructor(opts) {
        this.type = opts.type;
        this.conn = opts.conn;
    }
    sendPacket(binarydata) {
        if (this.type === 'ws') {
            websocketSend(this.conn, binarydata);
        } else {
            tcpsocketSend(this.conn, binarydata);
        }
    }
    bindEvents(onData, onError, onClose) {
        if (this.type === 'ws') {
            bindWebsocket(this.conn, onData, onError, onClose);
        } else {
            bindStreamSocket(this.conn, onData, onError, onClose);
        }
    }

    close() {
        try {
            this.conn.close();
        } catch (err) {
            // ignore
        }
    }
}



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

exports.createTransport = function (tunnelOpts) {

    return new Promise((resolve, reject) => {
        let ts = null;
        const onOpen = () => resolve(ts);
        if (tunnelOpts.protocol === 'ws') {
            ts = exports.createWebsocketTransport(tunnelOpts, onOpen);
        } else if (tunnelOpts.protocol === 'h2') {
            ts = exports.createHttp2Transport(tunnelOpts, onOpen);
        } else if (tunnelOpts.protocol === 'tls') {
            ts = exports.createTlsTransport(tunnelOpts, onOpen);
        } else if (tunnelOpts.protocol === 'tcp') {
            ts = exports.createTcpTransport(tunnelOpts, onOpen);
        } else {
            reject(Error('un implement protocol!'));
        }
    })
};
