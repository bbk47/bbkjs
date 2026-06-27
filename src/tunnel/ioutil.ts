import type { Readable } from 'stream';

// readN 从一个 Readable 上以"暂停模式"精确读取 n 字节，多读到的部分用 unshift
// 放回流的内部缓冲，等后续（如 pipe）继续消费。用于流级握手中读取定长头
// （SecureConn 的对端 IV、Session 的地址长度前缀、就绪状态字节等）。
//
// 注意：调用 readN 期间不要给同一条流挂 'data' 监听或调用 resume，
// 否则会与这里的 'readable'/read() 竞争同一份数据。
export function readN(stream: Readable, n: number, timeoutMs: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
        if (n === 0) {
            resolve(Buffer.alloc(0));
            return;
        }

        const chunks: Buffer[] = [];
        let got = 0;
        let timer: NodeJS.Timeout | undefined;

        const cleanup = () => {
            stream.removeListener('readable', onReadable);
            stream.removeListener('end', onEnd);
            stream.removeListener('error', onError);
            if (timer) clearTimeout(timer);
        };

        const onReadable = () => {
            let chunk: Buffer | null;
            // 一次 readable 尽量取空内部缓冲，凑够 n 即返回并回退多余字节。
            while ((chunk = stream.read() as Buffer | null) !== null) {
                chunks.push(chunk);
                got += chunk.length;
                if (got >= n) {
                    const buf = Buffer.concat(chunks);
                    const head = buf.subarray(0, n);
                    const rest = buf.subarray(n);
                    if (rest.length > 0) stream.unshift(rest);
                    cleanup();
                    resolve(Buffer.from(head));
                    return;
                }
            }
        };

        const onEnd = () => {
            cleanup();
            reject(new Error('readN: stream ended before reading enough bytes'));
        };

        const onError = (err: Error) => {
            cleanup();
            reject(err);
        };

        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                cleanup();
                reject(new Error('readN: timeout'));
            }, timeoutMs);
        }

        stream.on('readable', onReadable);
        stream.on('end', onEnd);
        stream.on('error', onError);
        // 可能数据已在缓冲里，主动触发一次。
        onReadable();
    });
}
