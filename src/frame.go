package bbk

import (
	"github.com/bbk47/toolbox"
)

const (
	INIT_FRAME   uint8 = 0x0
	STREAM_FRAME uint8 = 0x1
	FIN_FRAME    uint8 = 0x2
	RST_FRAME    uint8 = 0x3
	EST_FRAME    uint8 = 0x4
	// ping pong
	PING_FRAME uint8 = 0x6
	PONG_FRAME uint8 = 0x9
)

/**
 *
 * // required: cid, type,  data
 * @param {*} frame
 * |<-version[1]->|<--cidLen[1]-->|<---(cid)---->|<--type[1]-->|<--dataLen[2]-->|<-------data------>|<--rndLen[1]-->|<---ran data-->|
 * |-----s1 ------|-------s2------|-----s3 ------|-------s4----|-------s5 ------|--------s6---------|------s7 ------|-------s8------|
 * @returns
 */

type Frame struct {
	Version uint8
	Cid     string
	Type    uint8
	Data    []byte
}

type Serializer struct {
	rnglen int
}

func NewSerializer(rnglen int) (ss *Serializer, err error) {
	if err != nil {
		return nil, err
	}
	ss = &Serializer{rnglen: rnglen}
	return ss, nil
}

func (ss *Serializer) Serialize(frame *Frame) []byte {
	if frame.Version == 0 {
		frame.Version = 1
	}
	cidlen := len(frame.Cid)
	datalen := len(frame.Data)
	ret1 := []byte{frame.Version, uint8(cidlen)} // s1,s2
	cidBuf := []byte(frame.Cid)                  // s3
	ret2 := append(ret1, cidBuf...)              // s1+s2+s3
	typeBuf := []byte{frame.Type}
	ret3 := append(ret2, typeBuf[0])                             // s1+s2+s3+s4
	ret4 := append(ret3, uint8(datalen>>8), uint8(datalen&0xff)) // +s5
	ret5 := append(ret4, frame.Data...)                          // +s6
	if ss.rnglen > 0 {                                           // append random byte , if rnglen set.
		randbs := toolbox.GetRandByte(ss.rnglen)
		ret5 = append(ret5, uint8(ss.rnglen))
		ret5 = append(ret5, randbs...)
	}
	return ret5
}

func (ss *Serializer) Derialize(binaryDt []byte) (frame *Frame, err error) {
	ver := binaryDt[0]                                               // s1
	cidlen := binaryDt[1]                                            // s2
	cid := string(binaryDt[2 : cidlen+2])                            // s3
	typeVal := binaryDt[cidlen+2]                                    // s4
	datalen := int(binaryDt[cidlen+3])*256 + int(binaryDt[cidlen+4]) //s5
	startIndex := int(cidlen + 5)
	dataBuf := binaryDt[startIndex : datalen+startIndex] // s6
	frame1 := Frame{Version: ver, Cid: cid, Type: typeVal, Data: dataBuf}
	return &frame1, nil
}
