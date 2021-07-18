package main

import bbk "bbk/src"

func main() {
	opt := bbk.Option{
		ListenAddr:    "127.0.0.1",
		ListenPort:    5900,
		FillByte:      0,
		LogLevel:      "info",
		Method:        "aes-256-cfb",
		Password:      "p@ssword",
		WebsocketPath: "/websocket",
	}
	server := bbk.NewServer(opt)
	server.Bootstrap()
}
