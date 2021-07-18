package bbk

import (
	"encoding/binary"
	"sync"
	"time"
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
 * @param {*} frame
 * |<------32(cid)------->|<--8(timestramp)-->|<--1(type)-->|<------------data------------->|
 *
 * @returns
 */

type Frame struct {
	Cid  string
	Time uint64
	Type uint8
	Data []byte
}

func Serialize(frame Frame) []byte {
	frame.Time = uint64(time.Now().UnixNano())

	bs := make([]byte, 8)
	binary.BigEndian.PutUint64(bs, frame.Time)
	cidBuf := []byte(frame.Cid)
	typeBuf := []byte{frame.Type}

	ret1 := append(cidBuf, bs...)
	ret2 := append(ret1, typeBuf[0])
	ret3 := append(ret2, frame.Data...)
	return ret3
}

func Derialize(binaryBs []byte) Frame {
	cid := string(binaryBs[:32])
	timeBuf := binaryBs[32:40]
	typeVal := binaryBs[40]
	dataBuf := binaryBs[41:]
	timeVal := binary.BigEndian.Uint64(timeBuf)
	frame := Frame{Cid: cid, Type: typeVal, Time: timeVal, Data: dataBuf}
	return frame
}

type FrameQueue struct {
	items []Frame
	lock  sync.RWMutex
}

// 创建队列
func (q *FrameQueue) New() *FrameQueue {
	q.items = []Frame{}
	return q
}

// 入队列
func (q *FrameQueue) Push(f Frame) {
	q.lock.Lock()
	q.items = append(q.items, f)
	q.lock.Unlock()
}

// 出队列
func (q *FrameQueue) Shift() *Frame {
	q.lock.Lock()
	item := q.items[0]
	q.items = q.items[1:len(q.items)]
	q.lock.Unlock()
	return &item
}

// 判空
func (q *FrameQueue) IsEmpty() bool {
	return len(q.items) == 0
}

func (q *FrameQueue) Size() int {
	return len(q.items)
}
