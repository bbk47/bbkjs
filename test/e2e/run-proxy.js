#!/usr/bin/env node
const assert = require('node:assert');
const { getFreePort } = require('../helpers/ports');
const { makeServerConfig, makeClientConfig } = require('../helpers/fixtures');
const { startEchoServer, startBbkServer, startBbkClient, waitForTunnel } = require('../helpers/servers');
const { socks5Connect } = require('../helpers/socks5Client');

(async () => {
    let echo;
    let broker;
    let clientApp;
    let socket;

    try {
        echo = await startEchoServer();

        const brokerPort = await getFreePort();
        const proxyPort = await getFreePort();

        broker = await startBbkServer(
            makeServerConfig({
                listenPort: brokerPort,
                workMode: 'tcp',
            })
        );

        clientApp = await startBbkClient(
            makeClientConfig({
                listenPort: proxyPort,
                tunnelOpts: {
                    protocol: 'tcp',
                    host: '127.0.0.1',
                    port: brokerPort,
                },
            })
        );

        await waitForTunnel(clientApp.app, 8000);

        socket = await socks5Connect({
            proxyHost: '127.0.0.1',
            proxyPort: clientApp.port,
            targetHost: '127.0.0.1',
            targetPort: echo.port,
        });

        const message = 'bbk-e2e-' + Date.now();
        const reply = await new Promise((resolve, reject) => {
            socket.once('error', reject);
            socket.on('data', (buf) => resolve(buf.toString()));
            socket.write(message);
        });

        assert.strictEqual(reply, message);
    } finally {
        socket?.destroy();
        void clientApp?.close();
        void broker?.close();
        void echo?.close();
    }

    console.log('OK');
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
