// Package tunnel 提供基于 @bbk47/yamux 的隧道多路复用层，替代自研的
// protocol/serializer/stub 三件套。分层职责：
//
//   SecureConn —— 在裸载体(Duplex)之上做整条连接的流式加密
//                 (每条连接随机 IV + 连续 cipher.update，取代逐帧固定 IV 的 CFB)。
//   Session    —— 封装 yamux 会话，并补上 yamux 不负责的"流级握手"
//                 (目标地址 + 连接就绪确认，取代旧的 INIT/EST 帧)。
//   WsConn     —— 把 WebSocket 的消息流适配成 yamux 要求的有序字节流。
//
// 载体(tcp/tls/h2/ws)只负责产出一条有序字节流，分帧/复用/流控全部交给 yamux。
export { SecureConn } from './secureconn';
export { WsConn } from './wsconn';
export { Session, STATUS_OK, STATUS_FAIL } from './session';
export type { TunnelStream } from './session';
export { readN } from './ioutil';
