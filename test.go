package main

import (
	bbk "bbk/src"
	"bbk/src/utils"
	"log"
	"time"
)
import "fmt"

func main() {
	frame := bbk.Frame{Cid: "79d309c9e17b44fc9e1425ed5fe92d31", Type: 1, Data: []byte{0x1, 0x2, 0x3, 0x4}}

	buf := bbk.Serialize(frame)

	fmt.Printf("%v  ==== len ==43? %v\n", buf, len(buf))

	frame2 := bbk.Derialize(buf)
	fmt.Printf("%v  ====\n", frame2)

	encryptor, err := utils.NewEncryptor("aes-256-cfb", "csii2019")
	if err != nil {
		log.Fatalln(err)
	}
	originBuf := []byte("test123xuxihai")
	encrpted1 := encryptor.Encrypt(originBuf)
	encrpted2 := encryptor.Encrypt(originBuf)
	encrpted3 := encryptor.Encrypt(originBuf)

	fmt.Println(utils.GetBytesHex(encrpted1))
	fmt.Println(utils.GetBytesHex(encrpted2))
	fmt.Println(utils.GetBytesHex(encrpted3))

	origin1, _ := encryptor.Decrypt(encrpted1)
	origin2, _ := encryptor.Decrypt(encrpted2)
	origin3, _ := encryptor.Decrypt(encrpted3)

	fmt.Println(string(origin1))
	fmt.Println(string(origin2))
	fmt.Println(string(origin3))

	timest := time.Now().UnixNano() / 1e6
	tstr := fmt.Sprintf("%v", timest)
	log.Println(tstr)
	// let result = serialize(payload);
	// console.log(result);
	// let parseObj = derialize(result);
	// console.log(parseObj);

	// let buf = Buffer.from([0x05, 0x06, 0x07]);

	// console.log(buf.readUIntBE(0, 2));
}
