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

exports.createConnectProxy = function (cReq, cSock, onConnect, onData, onClose) {
    const hostport = cReq.url.split(':');
    const hostname = hostport[0];
    const port = Number(hostport[1]);
    const socksAddrInfo = socks5.buildSocks5Addr(hostname, port);
    onConnect(socksAddrInfo, (err) => {
        if (!err) {
            cSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        } else {
            cSock.destroy();
        }
    });

    cSock.on('data', onData);
    cSock.on('close', (msg) => onClose(null, msg));
    cSock.on('error', function (error) {
        cSock.destroy();
        onClose(error);
    });
};
