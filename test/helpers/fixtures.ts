import * as fs from 'fs';
import * as path from 'path';

export const ADDR = Buffer.from([0x01, 127, 0, 0, 1, 0x00, 0x50]);

export const TEST_PASSWORD = 'test-pass';
export const TEST_METHOD = 'aes-256-cfb';

// 仓库自带的自签证书（已过期），仅用于本地 tls/h2 载体测试；
// 拨号侧统一 rejectUnauthorized:false，证书有效期不影响握手。
const CERT_DIR = path.join(__dirname, '../../examples/tls/certs');

let sslCache: { sslKey: string; sslCrt: string } | undefined;

export function loadTestTls(): { sslKey: string; sslCrt: string } {
    if (!sslCache) {
        sslCache = {
            sslKey: fs.readFileSync(path.join(CERT_DIR, 'key.pem'), 'utf8'),
            sslCrt: fs.readFileSync(path.join(CERT_DIR, 'cert.pem'), 'utf8'),
        };
    }
    return sslCache;
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
            tunnelOpts: Object.assign(
                {
                    protocol: 'tcp',
                    host: '127.0.0.1',
                    port: 0,
                    path: '/tunnel',
                    method: TEST_METHOD,
                    password: TEST_PASSWORD,
                },
                tunnelOverrides
            ),
        },
        rest
    );
}
