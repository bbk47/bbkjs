package transport

type Events struct {
	Data   chan []byte
	Status chan string
}
