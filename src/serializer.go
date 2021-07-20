package bbk

import (
	"bbk/src/utils"
	"math/rand"
)

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

func (ss Serializer) ExecEncrypt(data []byte) []byte {
	if ss.fillByte > 0 {
		token := make([]byte, ss.fillByte)
		rand.Read(token)
		data = append(token, data...)
	}
	return ss.encryptor.Encrypt(data)
}

func (ss Serializer) ExecDecrypt(data []byte) (data2 []byte, err error) {
	data2, err = ss.encryptor.Decrypt(data)
	if ss.fillByte > 0 {
		return data2[ss.fillByte:], err
	}

	return data2, err

}
