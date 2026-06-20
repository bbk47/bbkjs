const Duplex = require('stream').Duplex;

// 流控默认窗口（两端必须一致：本端初始接收窗口 == 对端初始发送窗口）
const DEFAULT_WINDOW = 256 * 1024; // 256KB
// 单个数据帧最大切片，便于多流公平交错 & 背压粒度
const SEND_CHUNK = 16 * 1024;

/**
 * 逻辑流（多路复用中的一条 stream）。
 *
 * 发送方向（_write）：基于 sendWindow 的逐字节滑动窗口，窗口耗尽则挂起回调形成背压，
 *   收到对端 WINDOW_UPDATE 后继续发送。
 * 接收方向（produce/_read）：incoming 数据先入 _inQueue，按下游消费能力 push 到可读侧；
 *   push 返回 false（下游背压）时停止吐数据并停止给对端补窗口；按阈值发送 WINDOW_UPDATE。
 * 半关闭：本端 end() -> 'localfin'（对端只关读端）；收到对端 FIN -> remoteFinish()（本端只关读端）。
 */
class BbkStream extends Duplex {
    constructor(writerFn, sendWindowUpdateFn, options) {
        const windowSize = (options && options.windowSize) || DEFAULT_WINDOW;
        super({
            allowHalfOpen: true,
            readableHighWaterMark: windowSize,
            writableHighWaterMark: windowSize,
        });

        this.writerFn = writerFn;
        this.sendWindowUpdateFn = sendWindowUpdateFn;
        this.windowSize = windowSize;
        this._windowThreshold = Math.max(1, Math.floor(windowSize / 2));

        // 发送方向
        this._sendWindow = windowSize; // 对端通告给我们的可发送额度
        this._pendingWrites = []; // [{ buf, cb }]

        // 接收方向
        this._inQueue = []; // 已收到、尚未 push 给下游的数据
        this._inBytes = 0;
        this._pendingAck = 0; // 自上次 WINDOW_UPDATE 以来已消费、待通告的字节
        this._wantMore = false; // 下游是否还想要数据（_read 被调用过）
        this._remoteFin = false; // 对端已半关闭写端

        // 生命周期
        this._readEnded = false;
        this._writeFinished = false;
        this._remoteReset = false;

        this.once('end', () => {
            this._readEnded = true;
        });
        this.once('finish', () => {
            this._writeFinished = true;
        });
    }

    // ===== 发送方向 =====

    _write(chunk, encoding, callback) {
        this._pendingWrites.push({ buf: chunk, cb: callback });
        this._flushWrites();
    }

    _flushWrites() {
        while (this._pendingWrites.length > 0 && this._sendWindow > 0) {
            const item = this._pendingWrites[0];
            const n = Math.min(this._sendWindow, item.buf.length, SEND_CHUNK);
            const piece = item.buf.subarray(0, n);
            this._sendWindow -= n;
            this.writerFn(piece);
            if (n === item.buf.length) {
                this._pendingWrites.shift();
                item.cb();
            } else {
                item.buf = item.buf.subarray(n);
            }
        }
    }

    // 对端通告：可以多发 delta 字节
    handleWindowUpdate(delta) {
        if (!delta) return;
        this._sendWindow += delta;
        this._flushWrites();
    }

    // ===== 接收方向 =====

    produce(rawData) {
        if (!rawData || rawData.length === 0) return;
        this._inQueue.push(rawData);
        this._inBytes += rawData.length;
        this._flushReads();
    }

    _read() {
        this._wantMore = true;
        this._flushReads();
    }

    _flushReads() {
        while (this._wantMore && this._inQueue.length > 0) {
            const buf = this._inQueue.shift();
            this._inBytes -= buf.length;
            this._pendingAck += buf.length;
            const ok = this.push(buf);
            if (!ok) {
                this._wantMore = false;
            }
        }

        if (this._pendingAck >= this._windowThreshold) {
            const delta = this._pendingAck;
            this._pendingAck = 0;
            this.sendWindowUpdateFn(delta);
        }

        // 对端已 FIN 且本端队列吐空 -> 结束可读侧（半关闭）
        if (this._remoteFin && this._inQueue.length === 0 && !this._readEnded) {
            this._readEnded = true;
            this.push(null);
        }
    }

    // 收到对端 FIN：半关闭，仅结束本端可读侧，可写侧仍可继续
    remoteFinish() {
        this._remoteFin = true;
        this._wantMore = true; // 确保 _inQueue 中残留数据被吐完
        this._flushReads();
    }

    // 收到对端 RST：硬复位，销毁但不再回发 RST
    remoteReset() {
        this._remoteReset = true;
        this.destroy();
    }

    // 本端可写侧正常结束 -> 通知对端半关闭
    _final(callback) {
        this.emit('localfin');
        callback();
    }

    _destroy(err, callback) {
        // 仅在“异常/未优雅完成 且 非对端发起复位”时回发 RST
        if (!this._remoteReset && !(this._readEnded && this._writeFinished)) {
            this.emit('localreset');
        }
        // 丢弃挂起写（Node 流机制会负责中止其回调，这里不手动调用以免重复回调）
        this._pendingWrites = [];
        callback(err);
    }
}

BbkStream.DEFAULT_WINDOW = DEFAULT_WINDOW;
module.exports = BbkStream;
