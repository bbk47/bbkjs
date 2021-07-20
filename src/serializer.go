package bbk

import (
	"bbk/src/utils"
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
	return ss.encryptor.Encrypt(data)
}

func (ss Serializer) ExecDecrypt(data []byte) (data2 []byte, err error) {
	data2, err = ss.encryptor.Decrypt(data)
	return data2, err
}
