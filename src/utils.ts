import type { Duplex } from 'stream';
import type { Logger } from '@bbk47/toolbox';

// relay 在 a、b 之间双向转发，支持半关闭：
// 借助 Node 的 pipe 做流控与"源端 EOF -> 目标端 end()"的半关闭映射
// （对 tunnel.Stream 即 end() 触发 'finish' -> 发 FIN；对 socket 即 CloseWrite）；
// 任一端出错或彻底关闭后再整体销毁。对应 bbk-go utils.Relay。
export function relay(a: Duplex, b: Duplex, logger?: Logger): void {
    let closed = false;
    const closeBoth = () => {
        if (closed) return;
        closed = true;
        for (const s of [a, b]) {
            try {
                s.destroy();
            } catch (_e) {
                // ignore
            }
        }
    };

    // pipe 默认在源端 'end' 时调用目标端 end()，从而实现半关闭。
    a.pipe(b);
    b.pipe(a);

    const onErr = (label: string) => (err: Error) => {
        logger?.debug(`${label} ${err.message}`);
        closeBoth();
    };
    a.on('error', onErr('a->b'));
    b.on('error', onErr('b->a'));
    a.on('close', closeBoth);
    b.on('close', closeBoth);
}
