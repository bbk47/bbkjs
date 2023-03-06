const net = require('net');
const { socks5 } = require('@bbk47/toolbox');

exports.createSocks5Proxy = function (cSock, onConnect) {
    var stage = 'INIT';
    cSock.on('data', function dataListener(data) {
        if (stage === 'INIT') {
            cSock.write('\x05\x00');
            stage = 'ADDR';
            return;
        } else if (stage === 'ADDR') {
            onConnect(data.slice(3), (err) => {
                if (!err) {
                    stage = 'STREAM';
                    cSock.write('\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00');
                    cSock.removeAllListeners('data');
                    cSock.pause(); // for pipe start stream
                } else {
                    cSock.destroy();
                }
            });
            return;
        } else {
            // transport data stage
        }
    });

    cSock.on('error', function (error) {
        cSock.destroy();
    });
};

exports.createConnectProxy = function (cSock, onConnect) {
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
                    cSock.removeAllListeners('data');
                    cSock.pause(); // for pipe start stream
                } else {
                    cSock.destroy();
                }
            });
        } else {
            // transport data stage
        }
    });

    cSock.on('error', function (error) {
        cSock.destroy();
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
