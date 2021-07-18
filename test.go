package main

import bbk "bbk/src"
import "fmt"

func main() {
	frame := bbk.Frame{Cid: "79d309c9e17b44fc9e1425ed5fe92d31", Type: 1, Data: []byte{0x1, 0x2, 0x3, 0x4}}

	buf := bbk.Serialize(frame)

	fmt.Printf("%v  ==== len %v\n", buf, len(buf))

	frame2 := bbk.Derialize(buf)
	fmt.Printf("%v  ====\n", frame2)
	// let result = serialize(payload);
	// console.log(result);
	// let parseObj = derialize(result);
	// console.log(parseObj);

	// let buf = Buffer.from([0x05, 0x06, 0x07]);

	// console.log(buf.readUIntBE(0, 2));
}
