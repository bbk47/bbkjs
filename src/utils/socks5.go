package utils

import (
	"encoding/binary"
	"errors"
	"fmt"
)

type AddrInfo struct {
	Addr string
	Port uint16
}

func ParseAddrInfo(buf []byte) (*AddrInfo, error) {
	var addrInfo AddrInfo
	atyp := buf[0]
	length := len(buf)
	switch atyp {
	case 1:
		addrInfo.Addr = fmt.Sprintf("%d.%d.%d.%d", buf[1], buf[2], buf[3], buf[4])
		addrInfo.Port = binary.BigEndian.Uint16(buf[length-2:])
		return &addrInfo, nil
	case 3:
		addrLen := int(buf[1])
		addrInfo.Addr = string(buf[2 : addrLen+2])
		addrInfo.Port = binary.BigEndian.Uint16(buf[length-2:])
		return &addrInfo, nil
	case 4:
		return nil, errors.New("IPv6: no supported yet")

	default:
		return nil, errors.New("invalid atyp")
	}
}
