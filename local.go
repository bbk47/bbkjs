package main

import bbk "bbk/src"

func main() {
	client := bbk.Client{
		ListenAddr:   "127.0.0.1",
		ListenPort:   1090,
		FillByte:    0,
		LogLevel:     "info",
		Method:       "aes-256-cfb",
		Password:     "p@ssword",
		WebsocketUrl: "ws://127.0.0.1:5900/websocket",
		Ping:         true,
	}
	client.Bootstrap()
}
