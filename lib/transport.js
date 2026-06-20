const WebSocket = require('ws');
const net = require('net');
const http2 = require('http2');
const tls = require('tls');

// ===== 收发 / 分帧 helper =====

function bindStreamSocket(s, onData, onError, onClose) {
    let buffcache = Buffer.from([]);
    s.on('data', function (data) {
        buffcache = Buffer.concat([buffcache, data]);
        while (true) {
            if (buffcache.length <= 2) {
                return;
            }
            const datalen = buffcache[0] * 256 + buffcache[1];
            if (buffcache.length < datalen + 2) {
                return;
            }
            const pack = buffcache.slice(2, datalen + 2);
            buffcache = buffcache.slice(datalen + 2);
            onData(pack);
        }
    });
    s.on('close', function (code) {
        onClose(code);
    });
    s.on('error', function (err) {
        s.destroy();
        onError(err);
    });
}

function bindWebsocket(ws, onData, onError, onClose) {
    ws.on('message', onData);
    ws.on('close', (code) => {
        onClose(code);
    });
    ws.on('error', (err) => {
        ws.close();
        onError(err);
    });
}

function tcpsocketSend(socket, data) {
    const datalen = data.length;
    if (socket.writable) {
        socket.write(Buffer.concat([Buffer.from([datalen >> 8, datalen % 256]), data]));
    } else {
        throw new Error('socket cannot writeable!');
    }
}

function websocketSend(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(data, { binary: true });
    } else {
        throw new Error('ws socket not open!' + ws.readyState);
    }
}

// ===== Transport 抽象 =====

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
            if (this.type === 'ws' || this.type === 'h2') {
                this.conn.close();
            } else {
                this.conn.destroy();
            }
        } catch (_err) {
            // ignore
        }
    }
}

// ===== 客户端建连 creater =====

function createWebsocketTransport(params, onOpen) {
    const tunnelWsUrl = `${params.secure ? 'wss' : 'ws'}://${params.host}:${params.port}${params.path || ''}`;
    const ws = new WebSocket(tunnelWsUrl, {
        perMessageDeflate: false,
        handshakeTimeout: 3000,
    });
    const ts = new Transport({ type: 'ws', conn: ws });
    ws.on('open', onOpen);
    return ts;
}

function createHttp2Transport(params, onOpen) {
    const http2Url = `https://${params.host}:${params.port}`;
    const client = http2.connect(http2Url, {
        rejectUnauthorized: false,
        requestCert: true,
    });
    const http2stream = client.request({
        ':method': 'POST',
        ':path': params.path || '/',
        'Content-Type': 'octet-stream',
    });
    http2stream.on('response', onOpen);
    const ts = new Transport({ type: 'h2', conn: http2stream });
    return ts;
}

function createTlsTransport(params, onOpen) {
    const tlsOpts = {
        rejectUnauthorized: false,
        host: params.host,
        port: params.port,
    };
    const tlsConn = tls.connect(tlsOpts, function () {
        onOpen();
    });
    const ts = new Transport({ type: 'tls', conn: tlsConn });
    return ts;
}

function createTcpTransport(params, onOpen) {
    const socket = new net.Socket();
    socket.connect(params.port, params.host, function () {
        onOpen();
    });
    return new Transport({ type: 'tcp', conn: socket });
}

function createUnixsocketTransport(params, onOpen) {
    const socket = new net.Socket();
    socket.connect(params.path || '', function () {
        onOpen();
    });
    const ts = new Transport({ type: 'domainsocket', conn: socket });
    return ts;
}

function wrapSocket(type, conn) {
    return new Transport({ type, conn });
}

module.exports = {
    Transport,
    wrapSocket,
    createWebsocketTransport,
    createHttp2Transport,
    createTlsTransport,
    createTcpTransport,
    createUnixsocketTransport,
};
