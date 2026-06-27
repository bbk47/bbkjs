import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { makeServerConfig, makeClientConfig, loadTestTls } from '../helpers/fixtures';
import { startBbkServer, startBbkClient, waitForTunnel } from '../helpers/servers';
import { startTcpEchoServer, startUdpEchoServer, EchoTarget } from '../helpers/echo';
import { tcpRoundtrip, udpRoundtrip } from '../helpers/roundtrip';

// 参数化压力/长稳测试 harness。覆盖载体 tcp/ws/h2/tls × 负载 TCP CONNECT / UDP ASSOCIATE。
// 说明：代码栈不含 HTTP/3(QUIC)，Node 核心也无稳定 H3，故 H3 无法覆盖。
//
// 通过环境变量调档（默认是几秒级的快速冒烟，可放心进 CI）：
//   STRESS_CARRIERS=tcp,ws,h2,tls   要测的载体（逗号分隔）
//   STRESS_MODES=tcp,udp            要测的负载类型
//   STRESS_DURATION_MS=2000         每个载体的持续时长
//   STRESS_CONCURRENCY=16           并发 worker 数（= 同时在飞的流/连接数）
//   STRESS_TCP_PAYLOAD=16384        TCP 单次回显最大随机负载字节
//   STRESS_UDP_PAYLOAD=1024         UDP 单个数据报最大随机负载字节
//   STRESS_OP_TIMEOUT_MS=8000       单次往返超时
//   STRESS_ERROR_BUDGET=0           允许的失败次数上限
//   STRESS_HANDLE_GROWTH=128        静默期后活跃句柄增长上限（泄漏的确定性信号）
//   STRESS_RSS_GROWTH_MB=256        RSS 增长告警阈值（MB，仅告警，V8 堆水位本就有噪声）
//   STRESS_ASSERT_LEAK=0            置 1 时把句柄增长超阈值视为失败（泄漏门禁）
//   STRESS_ASSERT_RSS=0             置 1 时额外把 RSS 增长超阈值也视为失败
//
// 长稳示例：STRESS_DURATION_MS=600000 STRESS_CONCURRENCY=200 STRESS_ASSERT_LEAK=1 npm run test:stress

function envInt(name: string, def: number): number {
    const v = process.env[name];
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : def;
}
function envList(name: string, def: string[]): string[] {
    const v = process.env[name];
    return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def;
}

const CARRIERS = envList('STRESS_CARRIERS', ['tcp', 'ws', 'h2', 'tls']);
const MODES = envList('STRESS_MODES', ['tcp', 'udp']);
const DURATION_MS = envInt('STRESS_DURATION_MS', 2000);
const CONCURRENCY = envInt('STRESS_CONCURRENCY', 16);
const TCP_PAYLOAD = envInt('STRESS_TCP_PAYLOAD', 16 * 1024);
const UDP_PAYLOAD = envInt('STRESS_UDP_PAYLOAD', 1024);
const OP_TIMEOUT_MS = envInt('STRESS_OP_TIMEOUT_MS', 8000);
const ERROR_BUDGET = envInt('STRESS_ERROR_BUDGET', 0);
const HANDLE_GROWTH = envInt('STRESS_HANDLE_GROWTH', 128);
const RSS_GROWTH_MB = envInt('STRESS_RSS_GROWTH_MB', 256);
const DRAIN_MS = envInt('STRESS_DRAIN_MS', 1500);
const ASSERT_LEAK = process.env.STRESS_ASSERT_LEAK === '1';
const ASSERT_RSS = process.env.STRESS_ASSERT_RSS === '1';

function randomPayload(max: number): Buffer {
    const n = 1 + Math.floor(Math.random() * Math.max(1, max));
    return crypto.randomBytes(n);
}

function carrierConfigs(carrier: string): { server: Record<string, unknown>; clientTunnel: Record<string, unknown> } {
    const needsTls = carrier === 'tls' || carrier === 'h2';
    const tls = needsTls ? loadTestTls() : {};
    return {
        server: makeServerConfig({ workMode: carrier, ...tls }),
        clientTunnel: { protocol: carrier },
    };
}

interface Stats {
    ops: number;
    failures: number;
    samples: string[];
}

async function runCarrier(carrier: string): Promise<void> {
    const { server: serverCfg, clientTunnel } = carrierConfigs(carrier);

    const tcpEcho: EchoTarget = await startTcpEchoServer();
    const udpEcho: EchoTarget = await startUdpEchoServer();
    const broker = await startBbkServer(serverCfg);
    const clientApp = await startBbkClient(
        makeClientConfig({ tunnelOpts: { ...clientTunnel, host: '127.0.0.1', port: broker.port } })
    );

    const teardown = async () => {
        await clientApp.close();
        await broker.close();
        await tcpEcho.close();
        await udpEcho.close();
    };

    try {
        await waitForTunnel(clientApp.app, 8000);

        const proxyHost = '127.0.0.1';
        const proxyPort = clientApp.port;
        const stats: Stats = { ops: 0, failures: 0, samples: [] };

        const oneOp = async (mode: string): Promise<void> => {
            if (mode === 'udp') {
                await udpRoundtrip(proxyHost, proxyPort, udpEcho.host, udpEcho.port, randomPayload(UDP_PAYLOAD), OP_TIMEOUT_MS);
            } else {
                await tcpRoundtrip(proxyHost, proxyPort, tcpEcho.host, tcpEcho.port, randomPayload(TCP_PAYLOAD), OP_TIMEOUT_MS);
            }
        };

        // 预热：先各跑一次，稳定 JIT/缓冲后再采集 RSS 基线。
        for (const mode of MODES) {
            try {
                await oneOp(mode);
            } catch (_e) {
                // 预热失败不计入，但下面的正式跑会暴露问题
            }
        }
        global.gc?.();
        const rssBaseline = process.memoryUsage().rss;
        const handlesBaseline = process.getActiveResourcesInfo?.().length ?? -1;

        const deadline = Date.now() + DURATION_MS;
        const worker = async (id: number): Promise<void> => {
            let iter = 0;
            while (Date.now() < deadline) {
                const mode = MODES[(id + iter) % MODES.length];
                iter++;
                try {
                    await oneOp(mode);
                    stats.ops++;
                } catch (err) {
                    stats.failures++;
                    if (stats.samples.length < 5) stats.samples.push(`[${mode}] ${(err as Error).message}`);
                }
            }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

        // 静默期：停止发起新往返后，给在飞的连接/流足够时间完成关闭，再采集"残留"。
        // 这样能把"真实泄漏"和"采样滞后（大量在飞 op 尚未 drain）"区分开。
        global.gc?.();
        await new Promise((r) => setTimeout(r, DRAIN_MS));
        global.gc?.();
        const rssAfter = process.memoryUsage().rss;
        const handlesAfter = process.getActiveResourcesInfo?.().length ?? -1;
        const rssGrowthMb = (rssAfter - rssBaseline) / (1024 * 1024);
        const handleGrowth = handlesAfter - handlesBaseline;
        const throughput = (stats.ops / DURATION_MS) * 1000;

        console.log(
            `[stress:${carrier}] ops=${stats.ops} fail=${stats.failures} ` +
                `thr=${throughput.toFixed(0)}/s rssΔ=${rssGrowthMb.toFixed(1)}MB ` +
                `handlesΔ=${handleGrowth} conc=${CONCURRENCY} dur=${DURATION_MS}ms`
        );
        if (stats.samples.length) console.log(`[stress:${carrier}] errors: ${stats.samples.join(' | ')}`);
        if (process.env.STRESS_DEBUG_HANDLES === '1') {
            const hist: Record<string, number> = {};
            for (const r of process.getActiveResourcesInfo?.() ?? []) hist[r] = (hist[r] ?? 0) + 1;
            console.log(`[stress:${carrier}] handles:`, hist);
        }

        assert.ok(stats.ops > 0, `${carrier}: 没有完成任何往返`);
        assert.ok(
            stats.failures <= ERROR_BUDGET,
            `${carrier}: 失败 ${stats.failures} 超过预算 ${ERROR_BUDGET}（样例: ${stats.samples.join(' | ')}）`
        );
        // 句柄增长是确定性的泄漏信号：静默期后应回到基线附近；若与 ops 成正比则说明每次往返都漏。
        if (ASSERT_LEAK) {
            assert.ok(
                handleGrowth <= HANDLE_GROWTH,
                `${carrier}: 静默后活跃句柄增长 ${handleGrowth} 超过阈值 ${HANDLE_GROWTH}（疑似资源泄漏，ops=${stats.ops}）`
            );
        } else if (handleGrowth > HANDLE_GROWTH) {
            console.warn(`[stress:${carrier}] 警告：活跃句柄增长 ${handleGrowth}（ops=${stats.ops}），疑似泄漏，请用 STRESS_ASSERT_LEAK=1 复测`);
        }
        // RSS 噪声大（V8 堆水位不轻易归还 OS），默认仅告警；STRESS_ASSERT_RSS=1 才作硬门禁。
        if (rssGrowthMb > RSS_GROWTH_MB) {
            const msg = `${carrier}: RSS 增长 ${rssGrowthMb.toFixed(1)}MB 超过阈值 ${RSS_GROWTH_MB}MB`;
            if (ASSERT_RSS) assert.ok(false, msg);
            else console.warn(`[stress:${carrier}] 警告：${msg}`);
        }
    } finally {
        await teardown();
    }
}

for (const carrier of CARRIERS) {
    test(`stress 载体[${carrier}] 并发 ${CONCURRENCY} × ${DURATION_MS}ms（${MODES.join('+')}）`, { timeout: DURATION_MS + 60000 }, async () => {
        await runCarrier(carrier);
    });
}
