const Duplex = require('stream').Duplex;

class BbkStream extends Duplex {
    constructor(writerFn, sendWindowUpdateFn) {
        super();
        this.writerFn = writerFn;
        this.cache = Buffer.from([]);
        this.windowSize = 32 * 1024; // 32KB窗口大小
        this.sentBytes = 0;
        this.isStreamPaused=false;
        this.pendingData = [];
        this.sendWindowUpdateFn = sendWindowUpdateFn;
    }

    produce(rawData) {
        if (!rawData) {
            console.log('no rawData====', rawData);
        }
        this.cache = Buffer.concat([this.cache, rawData]);
        this.read();
    }

    _write(chunk, encoding, callback) {
        if (this.sentBytes >= this.windowSize) {
            // 窗口满了，暂停上游（自动流控）
            this.pendingData.push({ chunk, callback });
            if (!this.isStreamPaused) {
                this.isStreamPaused = true;
                this.pause(); // ✅ 暂停 pipe 流
            }
            return;
        }
        
        // 窗口未满，直接发送
        this._sendData(chunk, callback);
    }
    
    _sendData(chunk, callback) {
        this.sentBytes += chunk.length;
        this.writerFn(chunk);
        callback();
        
        // 检查是否需要处理待发送队列
        this._processPendingData();
    }
    
    _processPendingData() {
        while (this.pendingData.length > 0 && this.sentBytes < this.windowSize) {
            const { chunk, callback } = this.pendingData.shift();
            this._sendData(chunk, callback);
        }

        if (this.isStreamPaused && this.sentBytes < this.windowSize) {
            this.isStreamPaused = false;
            this.resume(); // ✅ 恢复 pipe 继续流动
        }
    }

    // 处理窗口更新帧
    handleWindowUpdate(updateBytes) {
        // console.log('handleWindowUpdate==============', updateBytes);
        this.sentBytes -= updateBytes;
        this._processPendingData();
    }
    
    
    _read(size) {
        size = size || 1024 * 4;
        const rawdata = this.cache.subarray(0, size);
        this.push(rawdata);
        this.cache = this.cache.subarray(size);
        
        // 读取数据后，发送窗口更新
        if (rawdata.length > 0) {
            // console.log('sendWindowUpdateFn==============', rawdata.length);
            this.sendWindowUpdateFn(rawdata.length);
        }
    }
}

module.exports = BbkStream;
