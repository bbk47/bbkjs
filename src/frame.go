package bbk

import (
	"bbk/src/utils"
	"crypto/rand"
	"sync"
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
 * |<------32(cid)------->|<--6(rand byte)-->|<--1(type)-->|<------------data------------->|
 *
 * @returns
 */

type Frame struct {
	Cid  string
	Type uint8
	Data []byte
}

// get rand byte with length
func GetRandByte(len int) []byte {
	randbytes := make([]byte, len)
	rand.Read(randbytes)
	return randbytes
}

type Serializer struct {
	fillByte  int
	encryptor *utils.Encryptor
}

func NewSerializer(method, password string, fillBye int) (ss *Serializer, err error) {
	encryptor, err := utils.NewEncryptor(method, password)
	if err != nil {
		return nil, err
	}
	ss = &Serializer{fillByte: fillBye}
	ss.encryptor = encryptor
	return ss, nil
}

func (ss *Serializer) Serialize(frame *Frame) []byte {
	ret1 := []byte(frame.Cid)

	if ss.fillByte > 0 {
		randbs := GetRandByte(ss.fillByte)
		ret1 = append(randbs, ret1...)
	}

	randBuf := GetRandByte(6)
	typeBuf := []byte{frame.Type}
	ret2 := append(ret1, randBuf...)
	ret3 := append(ret2, typeBuf[0])
	ret4 := append(ret3, frame.Data...)
	return ss.encryptor.Encrypt(ret4)
}

func (ss *Serializer) Derialize(binaryBs []byte) (frame *Frame, err error) {
	decData, err := ss.encryptor.Decrypt(binaryBs)
	if err != nil {
		return nil, err
	}
	if ss.fillByte > 0 {
		decData = decData[ss.fillByte:]
	}

	cid := string(decData[:32])
	typeVal := decData[38]
	dataBuf := decData[39:]
	frame1 := Frame{Cid: cid, Type: typeVal, Data: dataBuf}
	return &frame1, nil
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
