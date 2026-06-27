---
name: proxy-stability
description: Run bbkjs (TS) proxy stability tests covering TCP/UDP over tcp/ws/h2/tls carriers, and verify Go(bbk)<->TS(bbkjs) wire compatibility. Use when testing the bbkjs proxy (client/server), debugging UDP relay / yamux stream issues, validating leak/long-soak behavior, or checking cross-language interop with the Go bbk implementation.
---

# bbkjs 代理稳定性 & 跨语言互通测试

测试 `bbkjs`（TypeScript 版 `bbk`，Client→Server 两端拓扑）的 TCP/UDP 稳定性，
并验证它与 Go 版 `bbk` 的 **v4 线协议互通**。主流程免 root。

## 核心认知

`bbkjs` 与 Go 版 `bbk` 是同一套 **v4 线协议**的两种实现，必须逐字节兼容：

- 载体(tcp/tls/h2/ws)只产出一条有序字节流；
- `SecureConn`：每条连接随机 IV 明文交换 + 连续流加密（`src/tunnel/secureconn.ts`，对应 Go `src/tunnel/secureconn.go`）；
- `@bbk47/yamux` 复用（与 Go `hashicorp/yamux` 同线格式）；
- 流级握手：`[2字节大端长度][socks5addr]` → 对端回 `1字节状态`(0x00 OK)（`src/tunnel/session.ts`）；
- UDP：SOCKS5 UDP ASSOCIATE，哨兵地址 `0xFD 'U''D''P'` 标记关联流，记录 `[len(2)][socks5addr+payload]`（`src/proxy/udp.ts`，对应 Go `src/proxy/udprelay.go`）。

| 现象 | 根因 | 用例 |
|---|---|---|
| 数据损坏/隧道重连 | SecureConn / yamux 复用 bug | `test:stress`(tcp 大包) |
| UDP 首包丢失/超时 | 中继 `message` 监听挂得太晚（见“注意事项”）| `xcompat` UDP / 单发探针 |
| 句柄/RSS 持续增长 | 关联流/socket/定时器未回收 | `test:stress` `STRESS_ASSERT_LEAK=1` |
| ws 模式起不来 | `ws` 默认导入在打包后 `WebSocket.Server` 丢失 | 跑 **打包产物** ws server |
| 仅某方向不通 | Go/TS 线协议实现分叉 | `xcompat` A/B |

## 测试分层

- **Node 单元/集成/e2e**：`test/integration`(SecureConn+yamux 真实 TCP 回显/多路复用)、
  `test/e2e`(socks5→tcp→echo 全链路)。跑 `npm test`（秒级，进程内）。
- **压力/长稳**：`test/stress/tunnel-stress.ts`，参数化 **载体 tcp/ws/h2/tls × 负载 tcp/udp**，
  含句柄/RSS 泄漏门禁。跑 `npm run test:stress`。
- **跨语言互通**：`test/xcompat/run.sh`，起 Go 与 TS 两套二进制做 A/B 双向矩阵。

> 盲区：`src/Client.ts` 重连退避、h3/QUIC（代码栈与 Node 核心都不含）无覆盖。

## 工作流（免 root）

```
- [ ] 0. typecheck + 构建产物 (npm run typecheck && npm run build)
- [ ] 1. Node 自测回归 (npm test)
- [ ] 2. 压力/泄漏 (npm run test:stress，必要时调大档位)
- [ ] 3. 跨语言互通矩阵 (test/xcompat/run.sh，ws + tcp)
- [ ] 4. 按结果判读定位
```

**0. typecheck + 构建**（互通测试用的是 `dist/bbk.min.js` 打包产物，必须先 build）
```bash
npm run typecheck && npm run build
```

**1. Node 自测**
```bash
npm test                 # unit/integration/e2e
```

**2. 压力 / 泄漏**（默认是 2s 级冒烟，可放心快速跑；env 调档做长稳）
```bash
npm run test:stress
# 长稳 + 泄漏门禁示例：
STRESS_DURATION_MS=600000 STRESS_CONCURRENCY=200 STRESS_ASSERT_LEAK=1 npm run test:stress
# 只测某载体/负载：
STRESS_CARRIERS=ws STRESS_MODES=udp npm run test:stress
```
> 关键 env：`STRESS_CARRIERS`/`STRESS_MODES`/`STRESS_DURATION_MS`/`STRESS_CONCURRENCY`/
> `STRESS_ASSERT_LEAK=1`(句柄增长作硬门禁)/`STRESS_ASSERT_RSS=1`。详见脚本头注释。

**3. 跨语言互通矩阵**（需同级 `../bbk` 仓库；脚本会自动构建缺失的二进制）
```bash
PROTO=ws  ./test/xcompat/run.sh    # A: Go-server+JS-client / B: JS-server+Go-client
PROTO=tcp ./test/xcompat/run.sh    # 每方向覆盖 TCP CONNECT + SOCKS5 UDP DNS
```

## 判读

- `xcompat` 某方向 TCP 不通 → 查 `SecureConn`(IV 交换)、`session.ts`(地址/状态握手) 与 Go 对端是否逐字节一致。
- `xcompat` UDP 不通而 TCP 通 → 查 `src/proxy/udp.ts` 记录分帧/哨兵地址，以及中继监听时序（见注意事项）。
- `test:stress` tcp 大包出现 `payload mismatch` → SecureConn/yamux 复用损坏（`src/tunnel/`）。
- `test:stress` 句柄随 ops 线性增长 → 关联流/socket/定时器泄漏（`src/proxy/udp.ts`、`Client.ts`、`Server.ts` 的 close 路径）。

## 注意事项（影响结果可靠性，含已踩坑）

- **必须测打包产物的 ws server**：`Node 自测/压测`走的是 `src/` 源码（tsx），
  而真实部署跑的是 `dist/bbk.min.js`。`ws` 用默认导入 `import WebSocket from 'ws'`
  时，esbuild 打包后 `WebSocket.Server` 会变成 `undefined`（默认导入互操作），
  **源码能跑、打包产物 ws server 崩**。已改用具名导入 `{ WebSocketServer }`/`{ WebSocket }`。
  回归方式：直接用 `dist/bbk.min.js` 起一个 `workMode:"ws"` 的 server。
- **UDP 首包时序**：toolbox 在 bind 中继 socket 后会**立即**回 app `ASSOCIATE` 应答，
  app 随即发数据报；而隧道流(openStream)还需一个网络往返才就绪。中继侧 `message`
  监听若等到流就绪才挂，这期间到达的数据报会被 Node dgram 直接丢弃（Go 侧靠内核
  UDP 收包缓冲不受影响）。`src/proxy/udp.ts` 已改为**同步挂监听 + 缓存早到数据报、
  流就绪后回放**。压测 `udpRoundtrip` 用 150ms 重传会**掩盖**此问题；用单发探针
  （`../bbk/tests/lib/udpdns_probe.go`）才能暴露。
- **跨语言对照必须 PROTO 与 method/password 一致**：两端 `method`(如 `aes-256-cfb`)、
  `password`、`workPath` 必须相同，否则 SecureConn 握手或 ws 升级失败。
- **互通脚本依赖同级 `../bbk`**：用其 Go 二进制与 `udpdns_probe.go`（仅依赖标准库）。

完整 Go 侧说明见 `../bbk/.cursor/skills/proxy-stability/SKILL.md` 与 `../bbk/tests/README.md`。
