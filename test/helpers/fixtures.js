const protocol = require('../../src/protocol');
const serializerFn = require('../../src/serializer').default;
const StubWorker = require('../../src/stub').default;
const { createLoopback } = require('./loopback');

// socks5 ipv4 地址 buffer：127.0.0.1:80
const ADDR = Buffer.from([0x01, 127, 0, 0, 1, 0x00, 0x50]);

const TEST_PASSWORD = 'test-pass';
const TEST_METHOD = 'aes-256-cfb';

function makePlainSerializer() {
    return {
        serialize: (frame) => protocol.encode(frame),
        derialize: (buf) => protocol.decode(buf),
    };
}

function makeEncryptedSerializer(password = TEST_PASSWORD, method = TEST_METHOD) {
    return serializerFn(password, method);
}

function setupStubPair({ encrypted = false } = {}) {
    const [ta, tb] = createLoopback();
    const serializer = encrypted ? makeEncryptedSerializer() : makePlainSerializer();
    const client = new StubWorker(ta, serializer);
    const server = new StubWorker(tb, serializer);
    return { client, server, ta, tb };
}

function makeServerConfig(overrides = {}) {
    return Object.assign(
        {
            mode: 'server',
            listenAddr: '127.0.0.1',
            listenPort: 0,
            logLevel: 'error',
            method: TEST_METHOD,
            password: TEST_PASSWORD,
            workMode: 'tcp',
            workPath: '/tunnel',
        },
        overrides
    );
}

function makeClientConfig(overrides = {}) {
    const tunnelOverrides = overrides.tunnelOpts || {};
    delete overrides.tunnelOpts;
    return Object.assign(
        {
            mode: 'client',
            listenAddr: '127.0.0.1',
            listenPort: 0,
            logLevel: 'error',
            ping: false,
            tunnelOpts: Object.assign(
                {
                    protocol: 'tcp',
                    host: '127.0.0.1',
                    port: 0,
                    method: TEST_METHOD,
                    password: TEST_PASSWORD,
                },
                tunnelOverrides
            ),
        },
        overrides
    );
}

module.exports = {
    ADDR,
    TEST_PASSWORD,
    TEST_METHOD,
    makePlainSerializer,
    makeEncryptedSerializer,
    setupStubPair,
    makeServerConfig,
    makeClientConfig,
};
