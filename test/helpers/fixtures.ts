import * as protocol from '../../src/protocol';
import serializerFn from '../../src/serializer';
import StubWorker from '../../src/stub';
import { createLoopback } from './loopback';

export const ADDR = Buffer.from([0x01, 127, 0, 0, 1, 0x00, 0x50]);

export const TEST_PASSWORD = 'test-pass';
export const TEST_METHOD = 'aes-256-cfb';

export function makePlainSerializer() {
    return {
        serialize: (frame: protocol.Frame) => protocol.encode(frame),
        derialize: (buf: Buffer) => protocol.decode(buf),
    };
}

export function makeEncryptedSerializer(password = TEST_PASSWORD, method = TEST_METHOD) {
    return serializerFn(password, method);
}

export function setupStubPair({ encrypted = false } = {}) {
    const [ta, tb] = createLoopback();
    const serializer = encrypted ? makeEncryptedSerializer() : makePlainSerializer();
    const client = new StubWorker(ta as any, serializer);
    const server = new StubWorker(tb as any, serializer);
    return { client, server, ta, tb };
}

export function makeServerConfig(overrides: Record<string, unknown> = {}) {
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

export function makeClientConfig(overrides: Record<string, unknown> & { tunnelOpts?: Record<string, unknown> } = {}) {
    const tunnelOverrides = overrides.tunnelOpts ?? {};
    const { tunnelOpts: _ignored, ...rest } = overrides;
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
        rest
    );
}
