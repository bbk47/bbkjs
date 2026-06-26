const net = require('net');
const Server = require('../../lib/Server');
const Client = require('../../lib/Client');
const { getFreePort } = require('./ports');

function startEchoServer(host = '127.0.0.1', port = 0) {
    return new Promise((resolve, reject) => {
        const server = net.createServer((socket) => {
            socket.pipe(socket);
        });
        server.once('error', reject);
        server.listen(port, host, () => {
            resolve({
                server,
                host,
                port: server.address().port,
                close: () =>
                    new Promise((res, rej) => {
                        server.close((err) => (err ? rej(err) : res()));
                    }),
            });
        });
    });
}

function closeNetServer(server) {
    return new Promise((resolve) => {
        if (!server || !server.listening) {
            resolve();
            return;
        }
        server.close(() => resolve());
    });
}

async function startBbkServer(config) {
    if (!config.listenPort) {
        config.listenPort = await getFreePort(config.listenAddr);
    }
    const app = new Server(config);
    app.bootstrap();
    return {
        app,
        port: config.listenPort,
        close: () => closeNetServer(app._server),
    };
}

async function startBbkClient(config) {
    if (!config.listenPort) {
        config.listenPort = await getFreePort(config.listenAddr);
    }
    const app = new Client(config);
    app.bootstrap();
    return {
        app,
        port: config.listenPort,
        close: async () => {
            if (app._stubclient) app._stubclient.close();
            const servers = app._proxyServers || [];
            await Promise.all(servers.map((s) => closeNetServer(s)));
        },
    };
}

function waitForTunnel(clientApp, timeoutMs = 10000) {
    return Promise.race([
        clientApp.setupEnv(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('tunnel setup timeout')), timeoutMs)),
    ]);
}

module.exports = {
    startEchoServer,
    startBbkServer,
    startBbkClient,
    waitForTunnel,
};
