const net = require('net');
const { socks5 } = require('@bbk47/toolbox');

exports.createSocks5Proxy = function (cSock, onConnect, onData, onClose) {
    var stage = 'INIT';
    cSock.on('data', (data) => {
        if (stage === 'INIT') {
            cSock.write('\x05\x00');
            stage = 'ADDR';
            return;
        } else if (stage === 'ADDR') {
            onConnect(data.slice(3), (err) => {
                if (!err) {
                    stage = 'STREAM';
                    cSock.write('\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00');
                } else {
                    cSock.destroy();
                }
            });
            return;
        } else {
            onData(data);
        }
    });

    cSock.on('close', (msg) => onClose(null, msg));
    cSock.on('error', function (error) {
        cSock.destroy();
        onClose(error);
    });
};

exports.createConnectProxy = function (cSock, onConnect, onData, onClose) {
    var stage = 'INIT';
    cSock.on('data', (data) => {
        if (stage === 'INIT') {
            const str = data.toString('ascii');
            const lines = str.split(/\s/g);
            // console.log(lines);
            if (lines[0] !== 'CONNECT') {
                cSock.destroy();
                return;
            }
            const hoststr = lines[1];
            const reqhost = hoststr.split(':');
            const hostname = reqhost[0];
            const port = Number(reqhost[1]);
            const socksAddrInfo = socks5.buildSocks5Addr(hostname, port);
            onConnect(socksAddrInfo, (err) => {
                if (!err) {
                    cSock.write(Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'));
                    stage = 'STREAM';
                } else {
                    cSock.destroy();
                }
            });
        } else {
            onData(data);
        }
    });

    cSock.on('close', (msg) => onClose(null, msg));
    cSock.on('error', function (error) {
        cSock.destroy();
        onClose(error);
    });
};

exports.createProxyServer = function (host, port, handler, onReady) {
    const address = host + ':' + port;
    let server = net.createServer({ allowHalfOpen: true });
    server.on('connection', handler);
    server.listen(port, host, () => {
        onReady(address);
    });
};
