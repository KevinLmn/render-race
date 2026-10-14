package main

import (
	"context"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Headroom on top of the replay, for live messages while the browser catches up.
const clientBuffer = 4096

type message struct {
	data   []byte
	binary bool
}

type client struct {
	conn  *websocket.Conn
	send  chan message
	admin bool // connected through the private listener
}

// Hub fans messages out to browsers. Broadcast never blocks: a browser that
// can't keep up is disconnected rather than slowing down the scheduler.
type Hub struct {
	mu      sync.Mutex
	clients map[*client]struct{}
}

func NewHub() *Hub {
	return &Hub{clients: map[*client]struct{}{}}
}

// Add sizes the client's queue to hold the whole replay, so it never blocks.
func (h *Hub) Add(c *client, initial []message) {
	h.mu.Lock()
	defer h.mu.Unlock()
	c.send = make(chan message, len(initial)+clientBuffer)
	for _, m := range initial {
		c.send <- m
	}
	h.clients[c] = struct{}{}
}

func (h *Hub) Count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

func (h *Hub) Remove(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removeLocked(c)
}

func (h *Hub) removeLocked(c *client) {
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
	}
}

func (h *Hub) Broadcast(m message) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c.send <- m:
		default:
			h.removeLocked(c)
		}
	}
}

func (c *client) writeLoop(ctx context.Context) {
	defer c.conn.CloseNow()
	for m := range c.send {
		typ := websocket.MessageText
		if m.binary {
			typ = websocket.MessageBinary
		}
		wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := c.conn.Write(wctx, typ, m.data)
		cancel()
		if err != nil {
			return
		}
	}
}
