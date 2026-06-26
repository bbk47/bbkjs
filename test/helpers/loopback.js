// 内存 loopback transport：两端互联，每个 packet 异步投递给对端，保持 FIFO 顺序
class MockTransport {
    constructor() {
        this.conn = null;
        this._closed = false;
        this.peer = null;
    }
    bindEvents(onData, onError, onClose) {
        this.onData = onData;
        this.onError = onError;
        this.onClose = onClose;
    }
    sendPacket(buf) {
        if (this._closed) throw new Error('transport closed');
        const peer = this.peer;
        const copy = Buffer.from(buf);
        setImmediate(() => {
            if (peer && peer.onData && !peer._closed) peer.onData(copy);
        });
    }
    close() {
        this._closed = true;
    }
}

function createLoopback() {
    const a = new MockTransport();
    const b = new MockTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
}

module.exports = { MockTransport, createLoopback };
