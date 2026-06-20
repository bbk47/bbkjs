const test = require('node:test');
const assert = require('node:assert');
const BbkStream = require('../lib/stub/stream');

const tick = () => new Promise((r) => setImmediate(r));
const sum = (arr) => arr.reduce((a, b) => a + b.length, 0);

test('发送窗口：窗口耗尽则挂起，收到 WINDOW_UPDATE 后继续', async () => {
    const sent = [];
    const s = new BbkStream(
        (chunk) => sent.push(chunk),
        () => {},
        { windowSize: 100 }
    );

    let cbCalled = 0;
    s.write(Buffer.alloc(250, 1), () => cbCalled++);
    await tick();

    assert.strictEqual(sum(sent), 100);
    assert.strictEqual(cbCalled, 0);

    s.handleWindowUpdate(100);
    assert.strictEqual(sum(sent), 200);
    assert.strictEqual(cbCalled, 0);

    s.handleWindowUpdate(100);
    assert.strictEqual(sum(sent), 250);
    assert.strictEqual(cbCalled, 1);
});

test('发送窗口：大块数据跨多个窗口分片，不死锁', async () => {
    const sent = [];
    const s = new BbkStream(
        (chunk) => sent.push(chunk),
        () => {},
        { windowSize: 50 }
    );
    s.write(Buffer.alloc(120, 7));
    await tick();
    assert.strictEqual(sum(sent), 50);
    s.handleWindowUpdate(1000);
    assert.strictEqual(sum(sent), 120);
});

test('接收窗口：按阈值（窗口一半）发送 WINDOW_UPDATE', async () => {
    const updates = [];
    const s = new BbkStream(
        () => {},
        (n) => updates.push(n),
        { windowSize: 100 }
    );
    s.on('data', () => {});
    await tick();

    s.produce(Buffer.alloc(40));
    await tick();
    assert.strictEqual(updates.length, 0);

    s.produce(Buffer.alloc(20));
    await tick();
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0], 60);
});

test('接收侧：空 produce 不会 push 空 buffer 或误发更新', async () => {
    const updates = [];
    let dataCount = 0;
    const s = new BbkStream(
        () => {},
        (n) => updates.push(n),
        { windowSize: 100 }
    );
    s.on('data', (d) => {
        dataCount++;
        assert.ok(d.length > 0);
    });
    await tick();
    s.produce(Buffer.alloc(0));
    s.produce(null);
    await tick();
    assert.strictEqual(dataCount, 0);
    assert.strictEqual(updates.length, 0);
});

test('半关闭：end() 触发 localfin', async () => {
    const s = new BbkStream(() => {}, () => {});
    let fin = false;
    s.on('localfin', () => (fin = true));
    s.end();
    await tick();
    assert.strictEqual(fin, true);
});

test('半关闭：remoteFinish() 结束可读侧，但可写侧仍可用', async () => {
    const sent = [];
    const s = new BbkStream(
        (c) => sent.push(c),
        () => {}
    );
    let ended = false;
    s.on('data', () => {});
    s.on('end', () => (ended = true));
    await tick();

    s.produce(Buffer.from('hello'));
    s.remoteFinish();
    await tick();
    assert.strictEqual(ended, true);

    s.write(Buffer.from('world'));
    await tick();
    assert.strictEqual(sum(sent), 5);
});

test('remoteReset()：销毁且不回发 localreset', async () => {
    const s = new BbkStream(() => {}, () => {});
    let reset = false;
    let closed = false;
    s.on('localreset', () => (reset = true));
    s.on('close', () => (closed = true));
    s.remoteReset();
    await tick();
    assert.strictEqual(reset, false);
    assert.strictEqual(closed, true);
});

test('异常 destroy()：回发 localreset', async () => {
    const s = new BbkStream(() => {}, () => {});
    let reset = false;
    s.on('localreset', () => (reset = true));
    s.on('error', () => {});
    s.destroy();
    await tick();
    assert.strictEqual(reset, true);
});

test('优雅双向关闭：不回发 localreset', async () => {
    const s = new BbkStream(() => {}, () => {});
    let reset = false;
    s.on('localreset', () => (reset = true));
    s.on('data', () => {});
    s.end();
    s.remoteFinish();
    await tick();
    await tick();
    assert.strictEqual(reset, false);
});
