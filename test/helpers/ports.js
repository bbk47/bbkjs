const net = require('net');

function getFreePort(host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, host, () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

module.exports = { getFreePort };
