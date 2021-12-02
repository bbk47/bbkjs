package bbk

import (
	"sync"
)

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
