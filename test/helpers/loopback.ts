type DataListener = (data: Buffer) => void;
type ErrorListener = (err: Error) => void;
type CloseListener = (code?: number) => void;

export class MockTransport {
    conn: null = null;
    _closed = false;
    peer: MockTransport | null = null;
    onData?: DataListener;
    onError?: ErrorListener;
    onClose?: CloseListener;

    bindEvents(onData: DataListener, onError: ErrorListener, onClose: CloseListener): void {
        this.onData = onData;
        this.onError = onError;
        this.onClose = onClose;
    }

    sendPacket(buf: Buffer): void {
        if (this._closed) throw new Error('transport closed');
        const peer = this.peer;
        const copy = Buffer.from(buf);
        setImmediate(() => {
            if (peer && peer.onData && !peer._closed) peer.onData(copy);
        });
    }

    close(): void {
        this._closed = true;
    }
}

export function createLoopback(): [MockTransport, MockTransport] {
    const a = new MockTransport();
    const b = new MockTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
}
