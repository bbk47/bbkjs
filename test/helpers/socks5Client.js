const net = require('net');
const { buildSocks5Addr } = require('@bbk47/toolbox').socks5;

function socks5Connect({ proxyHost, proxyPort, targetHost, targetPort }) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(proxyPort, proxyHost);
        let stage = 'greet';

        function cleanup(err) {
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            socket.destroy();
            reject(err);
        }

        function onError(err) {
            cleanup(err);
        }

        function onData(chunk) {
            if (stage === 'greet') {
                if (chunk[0] !== 0x05 || chunk[1] !== 0x00) {
                    cleanup(new Error('socks5 greet failed'));
                    return;
                }
                stage = 'connect';
                const addr = buildSocks5Addr(targetHost, targetPort);
                socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr]));
                return;
            }

            if (stage === 'connect') {
                if (chunk[0] !== 0x05 || chunk[1] !== 0x00) {
                    cleanup(new Error('socks5 connect failed'));
                    return;
                }
                socket.removeListener('data', onData);
                socket.removeListener('error', onError);
                socket.on('error', (err) => socket.destroy(err));
                resolve(socket);
            }
        }

        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('connect', () => {
            socket.write(Buffer.from([0x05, 0x01, 0x00]));
        });
    });
}

module.exports = { socks5Connect };
