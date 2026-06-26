const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

test('e2e：Client(socks5) -> Server(tcp) -> Echo 目标全链路', { timeout: 20000 }, () => {
    const script = path.join(__dirname, 'run-proxy.js');
    const result = spawnSync(process.execPath, ['--require', 'tsx/cjs', script], {
        cwd: path.join(__dirname, '../..'),
        encoding: 'utf8',
        timeout: 15000,
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    assert.strictEqual(result.status, 0, result.stderr || result.stdout || 'e2e subprocess failed');
    assert.match(result.stdout, /OK/);
});
