package bbk

import (
	"encoding/hex"
	"github.com/bbk47/toolbox"
	"log"
	"testing"
)

func TestFrameBase(t *testing.T) {
	ser, _ := NewSerializer("aes-256-cfb", "csii2019", 2)

	frame1 := Frame{Cid: "79d309c9e17b44fc9e1425ed5fe92d31", Type: 1, Data: []byte{0x1, 0x2, 0x3, 0x4}}
	result := ser.Serialize(&frame1)
	log.Println(toolbox.GetBytesHex(result))

	frame2, err := ser.Derialize(result)
	if err != nil {
		t.Error(err)
	}

	if frame2.Cid != frame1.Cid || frame2.Type != frame1.Type || toolbox.GetBytesHex(frame2.Data) != toolbox.GetBytesHex(frame1.Data) {
		t.Errorf("test derialize failed!")
	}
}

func TestFrameDerialize(t *testing.T) {
	ser, _ := NewSerializer("aes-256-cfb", "csii2019", 4)

	hex1 := "c477433834f6f3afff9a1afff166d69f7d70e46b4a48e77af54b870779179ce476837fac998243028863317c760e4a"
	frame := Frame{Cid: "79d309c9e17b44fc9e1425ed5fe92d32", Type: 1, Data: []byte{0x1, 0x2, 0x3, 0x4}}
	data, err := hex.DecodeString(hex1)
	if err != nil {
		t.Error(err)
	}
	result, err := ser.Derialize(data)
	if err != nil {
		t.Error(err)
	}

	if result.Cid != frame.Cid || result.Type != frame.Type || toolbox.GetBytesHex(result.Data) != toolbox.GetBytesHex(frame.Data) {
		t.Errorf("test derialize failed!")
	}
}

func TestFrameDynamicData(t *testing.T) {
	ser, _ := NewSerializer("aes-256-cfb", "csii2019", 4)

	randata := toolbox.GetRandByte(20)
	frame := Frame{Cid: "79d309c9e17b44fc9e1425ed5fe92d32", Type: 1, Data: randata}
	result := ser.Serialize(&frame)

	frame2, err := ser.Derialize(result)
	if err != nil {
		t.Error(err)
	}

	if frame2.Cid == frame.Cid && frame2.Type == frame.Type && toolbox.GetBytesHex(frame2.Data) == toolbox.GetBytesHex(randata) {
		// success
	} else {
		t.Errorf("test derialize failed!")
	}
}
