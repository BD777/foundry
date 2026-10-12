package feishuevents

import (
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"

	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
)

// Feishu's long connection speaks pbbp2 frames over a WebSocket: control
// frames (ping, pong carrying the client config) and data frames (an event,
// possibly split into parts, which the receiver acks with {"code":200} in a
// frame echoing the event's). The frame types are the SDK's; this file only
// builds and reads them, for both ends: the server's connection to Feishu
// and the socket it serves feishu-cli.

func frameType(frame larkws.Frame) string {
	return larkws.Headers(frame.Headers).GetString(larkws.HeaderType)
}

func pingFrame(serviceID int32) larkws.Frame {
	return *larkws.NewPingFrame(serviceID)
}

// pongFrame answers a ping; a non-nil config tells the client its settings.
func pongFrame(serviceID int32, config *larkws.ClientConfig) larkws.Frame {
	headers := larkws.Headers{}
	headers.Add(larkws.HeaderType, string(larkws.MessageTypePong))
	frame := larkws.Frame{Method: int32(larkws.FrameTypeControl), Service: serviceID, Headers: headers}
	if config != nil {
		frame.Payload, _ = json.Marshal(config)
	}
	return frame
}

// eventFrame carries one whole event payload.
func eventFrame(seq uint64, serviceID int32, messageID string, payload []byte) larkws.Frame {
	headers := larkws.Headers{}
	headers.Add(larkws.HeaderType, string(larkws.MessageTypeEvent))
	headers.Add(larkws.HeaderMessageID, messageID)
	headers.Add(larkws.HeaderSum, "1")
	headers.Add(larkws.HeaderSeq, "0")
	headers.Add(larkws.HeaderTraceID, messageID)
	headers.Add(larkws.HeaderTimestamp, strconv.FormatInt(time.Now().UnixMilli(), 10))
	return larkws.Frame{SeqID: seq, LogID: seq, Service: serviceID, Method: int32(larkws.FrameTypeData), Headers: headers, Payload: payload}
}

// ackFrame is the receiver's answer to a data frame: the same frame with
// the handling time added and {"code":200} as its payload.
func ackFrame(frame larkws.Frame, handled time.Duration) larkws.Frame {
	headers := append(larkws.Headers(nil), frame.Headers...)
	headers.Add(larkws.HeaderBizRt, strconv.FormatInt(handled.Milliseconds(), 10))
	payload, _ := json.Marshal(larkws.NewResponseByCode(http.StatusOK))
	frame.Headers, frame.Payload = headers, payload
	return frame
}

// parts reassembles events Feishu split across several data frames; a part
// left incomplete for partTTL is forgotten.
type parts struct {
	mu      sync.Mutex
	pending map[string]*partial
}

type partial struct {
	chunks [][]byte
	seen   time.Time
}

const partTTL = 5 * time.Second

// add takes one frame's payload and returns the whole payload once every
// part of its message has arrived.
func (p *parts) add(frame larkws.Frame, now time.Time) ([]byte, bool) {
	headers := larkws.Headers(frame.Headers)
	sum, seq := headers.GetInt(larkws.HeaderSum), headers.GetInt(larkws.HeaderSeq)
	if sum <= 1 {
		return frame.Payload, true
	}
	if seq < 0 || seq >= sum {
		return nil, false
	}
	id := headers.GetString(larkws.HeaderMessageID)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.pending == nil {
		p.pending = map[string]*partial{}
	}
	for key, stale := range p.pending {
		if now.Sub(stale.seen) > partTTL {
			delete(p.pending, key)
		}
	}
	message := p.pending[id]
	if message == nil || len(message.chunks) != sum {
		message = &partial{chunks: make([][]byte, sum)}
		p.pending[id] = message
	}
	message.chunks[seq], message.seen = frame.Payload, now
	size := 0
	for _, chunk := range message.chunks {
		if chunk == nil {
			return nil, false
		}
		size += len(chunk)
	}
	delete(p.pending, id)
	whole := make([]byte, 0, size)
	for _, chunk := range message.chunks {
		whole = append(whole, chunk...)
	}
	return whole, true
}
