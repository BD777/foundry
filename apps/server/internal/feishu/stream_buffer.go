package feishu

import (
	"context"
	"sync"
	"time"
)

type updatePayload struct {
	client        *Client
	cardMessageID string
	title         string
	content       string
	statusTip     string
}

type StreamBuffer struct {
	mu          sync.Mutex
	minInterval time.Duration
	pending     map[string]*sessionBuffer
}

type sessionBuffer struct {
	mu         sync.Mutex
	payload    updatePayload
	lastUpdate time.Time
	timer      *time.Timer
}

func NewStreamBuffer(minInterval time.Duration) *StreamBuffer {
	if minInterval <= 0 {
		minInterval = 800 * time.Millisecond
	}
	return &StreamBuffer{
		minInterval: minInterval,
		pending:     make(map[string]*sessionBuffer),
	}
}

func (sb *StreamBuffer) Update(sessionID string, client *Client, cardMessageID, title, content, statusTip string) {
	sb.mu.Lock()
	buf, ok := sb.pending[sessionID]
	if !ok {
		buf = &sessionBuffer{}
		sb.pending[sessionID] = buf
	}
	sb.mu.Unlock()

	buf.mu.Lock()
	defer buf.mu.Unlock()

	buf.payload = updatePayload{
		client:        client,
		cardMessageID: cardMessageID,
		title:         title,
		content:       content,
		statusTip:     statusTip,
	}

	now := time.Now()
	if now.Sub(buf.lastUpdate) >= sb.minInterval {
		buf.lastUpdate = now
		p := buf.payload
		go func() {
			cardJSON := BuildRunningCard(p.title, p.content, p.statusTip)
			_ = p.client.PatchCard(context.Background(), p.cardMessageID, cardJSON)
		}()
	} else if buf.timer == nil {
		wait := sb.minInterval - now.Sub(buf.lastUpdate)
		buf.timer = time.AfterFunc(wait, func() {
			buf.mu.Lock()
			buf.timer = nil
			buf.lastUpdate = time.Now()
			p := buf.payload
			buf.mu.Unlock()

			cardJSON := BuildRunningCard(p.title, p.content, p.statusTip)
			_ = p.client.PatchCard(context.Background(), p.cardMessageID, cardJSON)
		})
	}
}

func (sb *StreamBuffer) Complete(sessionID string, client *Client, cardMessageID, title, content string, duration time.Duration) {
	sb.mu.Lock()
	if buf, ok := sb.pending[sessionID]; ok {
		buf.mu.Lock()
		if buf.timer != nil {
			buf.timer.Stop()
			buf.timer = nil
		}
		buf.mu.Unlock()
		delete(sb.pending, sessionID)
	}
	sb.mu.Unlock()

	cardJSON := BuildCompletedCard(title, content, duration)
	_ = client.PatchCard(context.Background(), cardMessageID, cardJSON)
}

func (sb *StreamBuffer) Fail(sessionID string, client *Client, cardMessageID, title, content, errorMsg string) {
	sb.mu.Lock()
	if buf, ok := sb.pending[sessionID]; ok {
		buf.mu.Lock()
		if buf.timer != nil {
			buf.timer.Stop()
			buf.timer = nil
		}
		buf.mu.Unlock()
		delete(sb.pending, sessionID)
	}
	sb.mu.Unlock()

	cardJSON := BuildFailedCard(title, content, errorMsg)
	_ = client.PatchCard(context.Background(), cardMessageID, cardJSON)
}
