const { Duplex, Readable } = require('stream');

// 改进后的 BbkStream
class BbkStream extends Duplex {
    constructor(writerFn, sendWindowUpdate, options = {}) {
        super(options);
        this.writerFn = writerFn;
        this.sendWindowUpdate = sendWindowUpdate;

        this.cache = Buffer.from([]);
        this.recv_window = 64 * 1024;
        this.consumed = 0;

        this.send_window = 64 * 1024;
        this.buffered_chunks = [];
        this.MAX_BUFFERED_SIZE = 10 * 1024 * 1024; // 10MB
        this.totalBufferedSize = 0;
    }

    // 接收上游生产的数据
    produce(rawData) {
        if (!rawData || !rawData.length) return;
        this.recv_window -= rawData.length;
        this.cache = Buffer.concat([this.cache, rawData]);
        // console.log('produce----',this.cache.length, this._readableState.needReadable);
        // ❌ 不要主动调用 this.read()，避免 CPU 飙高
         // ✅ 通知 Node 有新数据可读，让它调度 _read()
       // ✅ 仅在需要读取时触发 _read
        if (this.readableFlowing !== false) {
            // only if in flowing mode (i.e., .pipe() or .on('data') is active)
            setImmediate(() => this._read()); // 避免同步递归
        }
    }

    _read(size = 4 * 1024) {
        if (this.cache.length === 0) {
            return; // 没数据就等下次 produce()
        }

        const rawdata = this.cache.subarray(0, size);
        this.cache = this.cache.subarray(size);

        this.push(rawdata);
        this.consumed += rawdata.length;

        if (this.consumed >= 16 * 1024) {
            this.sendWindowUpdate?.(this.cid, this.consumed);
            this.recv_window += this.consumed;
            this.consumed = 0;
        }
    }

    _write(chunk, encoding, callback) {
        if (this.send_window >= chunk.length) {
            this.send_window -= chunk.length;
            this.writerFn(chunk, callback);
        } else {
            if (this.totalBufferedSize + chunk.length > this.MAX_BUFFERED_SIZE) {
                callback(new Error('Buffer overflow: send window full and too much buffered data.'));
                return;
            }

            this.buffered_chunks.push({ chunk, callback });
            this.totalBufferedSize += chunk.length;
            // 不立即 callback，让 Node.js 暂停上游写入（背压）
        }
    }

    tryFlush() {
        while (this.buffered_chunks.length && this.send_window > 0) {
            const { chunk, callback } = this.buffered_chunks[0];
            if (chunk.length > this.send_window) break;

            this.buffered_chunks.shift();
            this.totalBufferedSize -= chunk.length;
            this.send_window -= chunk.length;
            this.writerFn(chunk, callback);
        }

        // 如果缓冲已清空且流暂停，触发 drain 恢复写入
        if (this.buffered_chunks.length === 0) {
            this.emit('drain');
        }
    }

    updateSendWindow(delta) {
        this.send_window += delta;
        this.tryFlush();
    }
}


module.exports =BbkStream;