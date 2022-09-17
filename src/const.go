package bbk

import (
	"time"
)

const (
	TUNNEL_INIT       uint8 = 0x0
	TUNNEL_OK         uint8 = 0x1
	TUNNEL_DISCONNECT uint8 = 0x2
)

const CONNECT_TIMEOUT = time.Second * 10
