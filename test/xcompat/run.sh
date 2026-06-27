#!/usr/bin/env bash
# run.sh —— bbk(Go) <-> bbkjs(TS) 跨语言互通矩阵。
#
# 验证 v4 线协议(SecureConn 随机IV流加密 + yamux 复用 + 流级握手)在 Go 与 TS
# 两套实现之间双向互通，覆盖 TCP CONNECT 与 SOCKS5 UDP ASSOCIATE。
#
#   A: Go-server  + JS-client   (socks :1090)
#   B: JS-server  + Go-client   (socks :1091)
#
# 用法:  PROTO=ws ./run.sh        # PROTO 可选 ws|tcp，默认 ws
#        PROTO=tcp ./run.sh
#
# 依赖: 同级 ../bbk(Go 仓库，用于 Go 二进制与 udpdns_probe.go) + 本仓库 dist/bbk.min.js。
# 二者缺失时本脚本会尝试自动构建。免 root。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
JS_ROOT="$(cd "$HERE/../.." && pwd)"          # bbkjs/
GO_ROOT="$(cd "$JS_ROOT/.." && pwd)/bbk"      # ../bbk
JS_BIN="$JS_ROOT/dist/bbk.min.js"
GO_BIN="$GO_ROOT/tests/bin/bbk"
PROBE="$GO_ROOT/tests/lib/udpdns_probe.go"
WORK="$(mktemp -d)"
PROTO="${PROTO:-ws}"
DNS="${DNS:-1.1.1.1:53}"

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '\033[0;32m[ OK ]\033[0m %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf '\033[0;31m[FAIL]\033[0m %s\n' "$*"; }
info(){ printf '\033[0;36m[INFO]\033[0m %s\n' "$*"; }

# ---- 准备二进制 ----
[ -d "$GO_ROOT" ] || { bad "缺少同级 ../bbk 仓库: $GO_ROOT"; exit 1; }
if [ ! -x "$GO_BIN" ]; then
  info "构建 Go 二进制 -> $GO_BIN"
  ( cd "$GO_ROOT" && go build -o "$GO_BIN" ./main.go ) || { bad "go build 失败"; exit 1; }
fi
if [ ! -f "$JS_BIN" ]; then
  info "构建 bbkjs -> $JS_BIN"
  ( cd "$JS_ROOT" && npm run build ) || { bad "npm run build 失败"; exit 1; }
fi

pkill -f 'tests/bin/bbk' 2>/dev/null; pkill -f 'dist/bbk.min.js' 2>/dev/null; sleep 1

mkcfg(){ # role listenPort [tunnelPort]
  local role=$1 lport=$2 tport=${3:-} f
  if [ "$role" = server ]; then
    f="$WORK/server_$lport.json"
    printf '{"mode":"server","listenAddr":"127.0.0.1","listenPort":%s,"logLevel":"error","method":"aes-256-cfb","password":"p@ssword","workMode":"%s","workPath":"/websocket"}\n' "$lport" "$PROTO" >"$f"
  else
    f="$WORK/client_$lport.json"
    printf '{"mode":"client","listenAddr":"127.0.0.1","listenPort":%s,"logLevel":"error","tunnelOpts":{"protocol":"%s","secure":false,"host":"127.0.0.1","port":"%s","path":"/websocket","method":"aes-256-cfb","password":"p@ssword"},"ping":true}\n' "$lport" "$PROTO" "$tport" >"$f"
  fi
  echo "$f"
}

waitport(){ local p=$1 i=0; while [ $i -lt 100 ]; do (exec 3<>"/dev/tcp/127.0.0.1/$p")2>/dev/null && { exec 3>&- 3<&-; return 0;}; sleep 0.1; i=$((i+1)); done; return 1; }

PIDS=()
go_run(){ "$GO_BIN" -c "$1" >"$WORK/$2.log" 2>&1 & PIDS+=($!); }
js_run(){ node "$JS_BIN" -c "$1" >"$WORK/$2.log" 2>&1 & PIDS+=($!); }
cleanup(){ for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

probe_socks(){ # label socksPort
  local label=$1 sp=$2 code tag log
  tag="${label//[^A-Za-z0-9]/_}"
  log="$WORK/${tag}_udp.log"
  code=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 30 --socks5-hostname "127.0.0.1:$sp" http://example.com 2>/dev/null)
  [ "$code" = 200 ] && ok "$label TCP   http://example.com -> 200" || bad "$label TCP   -> code=$code"
  code=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 30 --socks5-hostname "127.0.0.1:$sp" https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null)
  [ "$code" = 200 ] && ok "$label TCP/H2 https cloudflare -> 200" || bad "$label TCP/H2 -> code=$code"
  if ( cd "$GO_ROOT" && go run "$PROBE" -socks "127.0.0.1:$sp" -dns "$DNS" -name example.com ) >"$log" 2>&1; then
    ok "$label UDP   DNS example.com -> $(tail -1 "$log")"
  else
    bad "$label UDP   DNS -> $(tail -1 "$log")"
  fi
}

info "PROTO=$PROTO  GO_BIN=$GO_BIN  JS_BIN=$JS_BIN"

info "A: Go-server(:5900) + JS-client(socks :1090)"
go_run "$(mkcfg server 5900)" A_go_server
waitport 5900 || bad "A go-server :5900 not up"
js_run "$(mkcfg client 1090 5900)" A_js_client
waitport 1090 || bad "A js-client socks :1090 not up"
sleep 1
probe_socks "A[Go-srv/JS-cli]" 1090

info "B: JS-server(:5901) + Go-client(socks :1091)"
js_run "$(mkcfg server 5901)" B_js_server
waitport 5901 || bad "B js-server :5901 not up"
go_run "$(mkcfg client 1091 5901)" B_go_client
waitport 1091 || bad "B go-client socks :1091 not up"
sleep 1
probe_socks "B[JS-srv/Go-cli]" 1091

echo "----------------------------------------"
echo "XCOMPAT(PROTO=$PROTO) PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
