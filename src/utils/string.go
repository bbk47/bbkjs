package utils

import (
	"fmt"
	"strconv"
	"time"
)

func GetBytesHex(buf []byte) string {
	hexStr := fmt.Sprintf("%x", buf)
	return hexStr
}

func GetNowInt64Bytes() []byte {
	timest := time.Now().UnixNano() / 1e6
	//tstr := fmt.Sprintf("%v", timest)
	tstr := strconv.Itoa(int(timest))
	return []byte(tstr)
}
