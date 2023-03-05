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
