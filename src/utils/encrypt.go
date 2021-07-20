package utils

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/des"
	"crypto/md5"
	"crypto/rc4"
	"errors"
	"golang.org/x/crypto/blowfish"
	"golang.org/x/crypto/cast5"
)

var errEmptyPassword = errors.New("empty key")

func md5sum(d []byte) []byte {
	h := md5.New()
	h.Write(d)
	return h.Sum(nil)
}

func evpBytesToKey(password string, keyLen, ivLen int) (key []byte, iv []byte) {

	md5Len := 16
	total := keyLen + ivLen
	ret := make([]byte, total)
	passByte := []byte(password)
	tempBuf := make([]byte, md5Len+len(password))

	var last []byte
	offset := 0
	for offset < total {
		if offset == 0 {
			last = md5sum(passByte)
		} else {
			copy(tempBuf, last)
			copy(tempBuf[md5Len:], passByte)
			last = md5sum(tempBuf)
		}
		copy(ret[offset:], last)
		offset += md5Len
	}
	return ret[:keyLen], ret[keyLen:]
}

type DecOrEnc int

const (
	Decrypt DecOrEnc = iota
	Encrypt
)

func newStream(block cipher.Block, err error, key, iv []byte,
	doe DecOrEnc) (cipher.Stream, error) {
	if err != nil {
		return nil, err
	}
	if doe == Encrypt {
		return cipher.NewCFBEncrypter(block, iv), nil
	} else {
		return cipher.NewCFBDecrypter(block, iv), nil
	}
}

func newAESCFBStream(key, iv []byte, doe DecOrEnc) (cipher.Stream, error) {
	block, err := aes.NewCipher(key)
	return newStream(block, err, key, iv, doe)
}

func newAESCTRStream(key, iv []byte, doe DecOrEnc) (cipher.Stream, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewCTR(block, iv), nil
}

func newDESStream(key, iv []byte, doe DecOrEnc) (cipher.Stream, error) {
	block, err := des.NewCipher(key)
	return newStream(block, err, key, iv, doe)
}

func newBlowFishStream(key, iv []byte, doe DecOrEnc) (cipher.Stream, error) {
	block, err := blowfish.NewCipher(key)
	return newStream(block, err, key, iv, doe)
}

func newCast5Stream(key, iv []byte, doe DecOrEnc) (cipher.Stream, error) {
	block, err := cast5.NewCipher(key)
	return newStream(block, err, key, iv, doe)
}

func newRC4MD5Stream(key, iv []byte, _ DecOrEnc) (cipher.Stream, error) {
	h := md5.New()
	h.Write(key)
	h.Write(iv)
	rc4key := h.Sum(nil)

	return rc4.NewCipher(rc4key)
}

type cipherInfo struct {
	keyLen    int
	ivLen     int
	newStream func(key, iv []byte, doe DecOrEnc) (cipher.Stream, error)
}

var cipherMethod = map[string]*cipherInfo{
	"aes-128-cfb": {16, 16, newAESCFBStream},
	"aes-192-cfb": {24, 16, newAESCFBStream},
	"aes-256-cfb": {32, 16, newAESCFBStream},
	"aes-128-ctr": {16, 16, newAESCTRStream},
	"aes-192-ctr": {24, 16, newAESCTRStream},
	"aes-256-ctr": {32, 16, newAESCTRStream},
	"des-cfb":     {8, 8, newDESStream},
	"bf-cfb":      {16, 8, newBlowFishStream},
	"cast5-cfb":   {16, 8, newCast5Stream},
	"rc4-md5":     {16, 16, newRC4MD5Stream},
	"rc4-md5-6":   {16, 6, newRC4MD5Stream},
}

type Cipher struct {
	key  []byte
	iv   []byte
	info *cipherInfo
}

// NewCipher creates a cipher that can be used in Dial() etc.
// Use cipher.Copy() to create a new cipher with the same method and password
// to avoid the cost of repeated cipher initialization.
func NewCipher(method, password string) (c *Cipher, err error) {
	if password == "" {
		return nil, errEmptyPassword
	}
	mi, ok := cipherMethod[method]
	if !ok {
		return nil, errors.New("Unsupported encryption method: " + method)
	}

	key, iv := evpBytesToKey(password, mi.keyLen, mi.ivLen)

	c = &Cipher{key: key, iv: iv, info: mi}

	if err != nil {
		return nil, err
	}
	return c, nil
}

type Encryptor struct {
	enc    cipher.Stream
	dec    cipher.Stream
	key    []byte
	iv     []byte
	cipher *Cipher
}

func NewEncryptor(method, password string) (encryptor *Encryptor, err error) {
	cipher, err := NewCipher(method, password)
	if err != nil {
		return nil, err
	}

	ee := Encryptor{}
	ee.cipher = cipher
	ee.key = cipher.key
	ee.iv = cipher.iv

	return &ee, nil
}

func (ee *Encryptor) Encrypt(buf []byte) []byte {
	enc, _ := ee.cipher.info.newStream(ee.key, ee.iv, Encrypt)
	enc.XORKeyStream(buf, buf)
	return buf
}

func (ee *Encryptor) Decrypt(buf []byte) (data []byte, err error) {
	dec, err := ee.cipher.info.newStream(ee.key, ee.iv, Decrypt)
	if err != nil {
		return nil, err
	}
	dec.XORKeyStream(buf, buf)
	return buf, nil
}
