## 4.0.0

- feat!: port to bbk v4 wire protocol — yamux mux (`@bbk47/yamux`) + stream-wide `SecureConn` (per-connection random IV + continuous cipher stream), stream-level handshake (`[2B len][socks5addr]` → `1B status`). Interops byte-for-byte with Go bbk v4; not compatible with bbk/bbkjs v3.
- fix: ws-mode server crashed in the bundled `dist/bbk.min.js` (`WebSocket.Server is not a constructor`) — esbuild default-import interop drops the `.Server` static; switched to named `{ WebSocketServer }`/`{ WebSocket }` imports.
- fix: UDP relay dropped datagrams that arrived before the tunnel stream was ready (toolbox replies to ASSOCIATE before openStream completes; Node dgram drops messages with no listener). Now attaches the relay `message` listener synchronously and buffers early datagrams until the stream is ready, then replays them (matches Go's kernel-buffered behavior).
- test: add cross-language interop matrix `test/xcompat/run.sh` (`npm run test:xcompat`, Go↔TS A/B, TCP + UDP over ws/tcp); add proxy-stability skill.

## 3.2.0

- refact: stream use @bbk47/toolbox, move transport/server into package
- feat: upgrade @bbk47/toolbox 2.0, rewrite flow control and send scheduling
- refact: migrate local modules to @bbk47/toolbox, introduce esbuild build

## 3.0.0

- setup stub worker over transport

## 2.0.0

- support http2/tls transport