# bbk

bbk is a powerful tool

# server

```json
{
    "listenAddr": "127.0.0.1",
    "listenPort": 5900,
    "fillByte": 8,
    "logLevel": "info",
    "method": "aes-256-cfb",
    "password": "p@ssword",
    "websocketPath": "/websocket"
}
```

```sh
node bin/server.js -c etc/server.json
```

# client

```json
{
    "listenAddr": "127.0.0.1",
    "listenPort": 1080,
    "fillByte": 8,
    "logLevel": "info",
    "method": "aes-256-cfb",
    "password": "p@ssword",
    "websocketUrl": "ws://127.0.0.1:5900/websocket",
    "ping": true
}
```

```sh
node bin/local.js -c etc/local.json
```

# BBK Heroku

## 概述

本专案用于在 Heroku 上部署 BBK，在合理使用的程度下，本镜像不会因为大量占用资源而导致封号。

部署完成后，每次启动应用时，运行的 BBK 将始终为最新版本

## 部署

### 步骤

1.  Fork 本专案到自己的 GitHub 账户（用户名以 `example` 为例）
2.  修改专案名称，注意不要包含 `bbk` 和 `heroku` 两个关键字（修改后的专案名以 `demo` 为例）
3.  修改 `README.md`，将 `bbk47/bbk` 替换为自己的内容（如 `example/demo`）

> [![Deploy](https://www.herokucdn.com/deploy/button.png)](https://dashboard.heroku.com/new?template=https://github.com/bbk47/bbk)

4.  回到专案首页，点击上面的链接以部署 bbk

### 变量

对部署时需设定的变量名称做如下说明。

| 变量             | 默认值       | 说明                                      |
| :--------------- | :----------- | :---------------------------------------- |
| `FILL_BYTE`      | `0`          | 用户混淆数据填充的无效字段                |
| `LISTEN_ADDR`    | `127.0.0.1`  | 服务器监听地址，`0.0.0.0`表示监听所有接口 |
| `LOG_LEVEL`      | `info`       | 控制台输出日志级别                        |
| `PASSWORD`       | `p@ssword`   | 加密算法密钥                              |
| `WEBSOCKET_PATH` | `/websocket` | websocket 工作路径                        |

## 接入 CloudFlare

以下两种方式均可以将应用接入 CloudFlare，从而在一定程度上提升速度。

1.  为应用绑定域名，并将该域名接入 CloudFlare
2.  通过 CloudFlare Workers 反向代理

## 注意

1.  **请勿滥用本专案，类似 Heroku 的免费服务少之又少，且用且珍惜**
2.  若使用域名接入 CloudFlare，请考虑启用 TLS 1.3

```

```
