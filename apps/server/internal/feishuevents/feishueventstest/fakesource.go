package feishueventstest

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
)

// FakeSource is a test double of Feishu's event side for one app, for
// package and server tests: endpoint discovery checks the app id and
// secret, and the socket answers pings, pushes the events a test sends to
// one open connection picked at random (Feishu's cluster mode), and records
// each ack with how long it took. Point a feishuevents.Hub at it with
// Hub.Domain.
type FakeSource struct {
	Server *httptest.Server

	appID, appSecret string

	mu        sync.Mutex
	endpoints int
	accepted  int
	open      []*fakeSocket
	acks      []Ack
	changed   chan struct{}
	seq       uint64
}

// Ack is a receiver's answer to one pushed event.
type Ack struct {
	MessageID string
	Code      int
	// After is the time from the push to the ack.
	After time.Duration
}

type fakeSocket struct {
	conn    *websocket.Conn
	writing sync.Mutex
	pushed  map[string]time.Time
}

// NewFakeSource starts the fake for one app.
func NewFakeSource(appID, appSecret string) *FakeSource {
	fake := &FakeSource{appID: appID, appSecret: appSecret, changed: make(chan struct{})}
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+larkws.GenEndpointUri, fake.endpoint)
	mux.HandleFunc("GET /ws", fake.socket)
	fake.Server = httptest.NewServer(mux)
	return fake
}

// URL is the fake's open-platform base.
func (f *FakeSource) URL() string { return f.Server.URL }

// Close closes every socket and the server.
func (f *FakeSource) Close() {
	f.DropAll()
	f.Server.Close()
}

// notifyLocked wakes everyone waiting for a change.
func (f *FakeSource) notifyLocked() {
	close(f.changed)
	f.changed = make(chan struct{})
}

// waitFor waits until ready (checked under the lock) or timeout.
func (f *FakeSource) waitFor(timeout time.Duration, ready func() bool) bool {
	deadline := time.After(timeout)
	for {
		f.mu.Lock()
		ok, changed := ready(), f.changed
		f.mu.Unlock()
		if ok {
			return true
		}
		select {
		case <-changed:
		case <-deadline:
			return false
		}
	}
}

func (f *FakeSource) endpoint(w http.ResponseWriter, r *http.Request) {
	var request larkws.BootstrapRequest
	_ = json.NewDecoder(r.Body).Decode(&request)
	f.mu.Lock()
	f.endpoints++
	f.notifyLocked()
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if request.AppID != f.appID || request.AppSecret != f.appSecret {
		_ = json.NewEncoder(w).Encode(larkws.EndpointResp{Code: larkws.AuthFailed, Msg: "app id or secret is wrong"})
		return
	}
	_ = json.NewEncoder(w).Encode(larkws.EndpointResp{Code: larkws.OK, Data: &larkws.Endpoint{
		Url:          fmt.Sprintf("ws://%s/ws?device_id=fake_%d&service_id=7", r.Host, rand.Int()),
		ClientConfig: &larkws.ClientConfig{PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 1},
	}})
}

func (f *FakeSource) socket(w http.ResponseWriter, r *http.Request) {
	conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	socket := &fakeSocket{conn: conn, pushed: map[string]time.Time{}}
	f.mu.Lock()
	f.accepted++
	f.open = append(f.open, socket)
	f.notifyLocked()
	f.mu.Unlock()
	defer func() {
		_ = conn.Close()
		f.mu.Lock()
		for index, open := range f.open {
			if open == socket {
				f.open = append(f.open[:index], f.open[index+1:]...)
				break
			}
		}
		f.notifyLocked()
		f.mu.Unlock()
	}()
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var frame larkws.Frame
		if frame.Unmarshal(raw) != nil {
			continue
		}
		switch larkws.FrameType(frame.Method) {
		case larkws.FrameTypeControl:
			if larkws.Headers(frame.Headers).GetString(larkws.HeaderType) == string(larkws.MessageTypePing) {
				_ = socket.write(pongFrame(frame.Service, &larkws.ClientConfig{PingInterval: 120}))
			}
		case larkws.FrameTypeData:
			var response larkws.Response
			_ = json.Unmarshal(frame.Payload, &response)
			id := larkws.Headers(frame.Headers).GetString(larkws.HeaderMessageID)
			f.mu.Lock()
			socket.writing.Lock()
			pushedAt, known := socket.pushed[id]
			socket.writing.Unlock()
			ack := Ack{MessageID: id, Code: response.StatusCode}
			if known {
				ack.After = time.Since(pushedAt)
			}
			f.acks = append(f.acks, ack)
			f.notifyLocked()
			f.mu.Unlock()
		}
	}
}

// pongFrame answers a ping with the client's settings, as Feishu does.
func pongFrame(serviceID int32, config *larkws.ClientConfig) larkws.Frame {
	headers := larkws.Headers{}
	headers.Add(larkws.HeaderType, string(larkws.MessageTypePong))
	payload, _ := json.Marshal(config)
	return larkws.Frame{Method: int32(larkws.FrameTypeControl), Service: serviceID, Headers: headers, Payload: payload}
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

func (s *fakeSocket) write(frame larkws.Frame) error {
	raw, err := frame.Marshal()
	if err != nil {
		return err
	}
	s.writing.Lock()
	defer s.writing.Unlock()
	return s.conn.WriteMessage(websocket.BinaryMessage, raw)
}

// EndpointRequests counts endpoint discoveries, refused ones included.
func (f *FakeSource) EndpointRequests() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.endpoints
}

// Accepted counts the sockets ever accepted.
func (f *FakeSource) Accepted() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.accepted
}

// Open counts the sockets open now.
func (f *FakeSource) Open() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.open)
}

// WaitOpen waits until exactly n sockets are open.
func (f *FakeSource) WaitOpen(n int, timeout time.Duration) bool {
	return f.waitFor(timeout, func() bool { return len(f.open) == n })
}

// Counts is what the fake has served: endpoint discoveries (refused ones
// included), sockets ever accepted and sockets open now.
type Counts struct{ Endpoints, Accepted, Open int }

// WaitUntil waits until ready holds for the fake's counts, or timeout.
func (f *FakeSource) WaitUntil(timeout time.Duration, ready func(Counts) bool) bool {
	return f.waitFor(timeout, func() bool {
		return ready(Counts{Endpoints: f.endpoints, Accepted: f.accepted, Open: len(f.open)})
	})
}

// ErrNoConnection: nothing is connected to push to.
var ErrNoConnection = errors.New("fake feishu: no event connection is open")

// Push sends payload as one event, split into parts frames, to one open
// socket picked at random, and returns its message id.
func (f *FakeSource) Push(payload []byte, parts int) (string, error) {
	f.mu.Lock()
	if len(f.open) == 0 {
		f.mu.Unlock()
		return "", ErrNoConnection
	}
	socket := f.open[rand.N(len(f.open))]
	f.seq++
	seq := f.seq
	f.mu.Unlock()
	parts = max(parts, 1)
	messageID := "msg_" + strconv.FormatUint(seq, 10)
	size := (len(payload) + parts - 1) / parts
	socket.writing.Lock()
	socket.pushed[messageID] = time.Now()
	socket.writing.Unlock()
	for index := 0; index < parts; index++ {
		chunk := payload[min(index*size, len(payload)):min((index+1)*size, len(payload))]
		frame := eventFrame(seq, 7, messageID, chunk)
		headers := larkws.Headers{}
		for _, header := range frame.Headers {
			switch header.Key {
			case larkws.HeaderSum:
				header.Value = strconv.Itoa(parts)
			case larkws.HeaderSeq:
				header.Value = strconv.Itoa(index)
			}
			headers = append(headers, header)
		}
		frame.Headers = headers
		if err := socket.write(frame); err != nil {
			return "", err
		}
	}
	return messageID, nil
}

// Acks are the acks received so far, in order.
func (f *FakeSource) Acks() []Ack {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Ack(nil), f.acks...)
}

// WaitAcks waits until at least n acks arrived and returns them.
func (f *FakeSource) WaitAcks(n int, timeout time.Duration) []Ack {
	f.waitFor(timeout, func() bool { return len(f.acks) >= n })
	return f.Acks()
}

// DropAll closes every open socket abruptly, as a network failure would.
func (f *FakeSource) DropAll() {
	f.mu.Lock()
	open := append([]*fakeSocket(nil), f.open...)
	f.mu.Unlock()
	for _, socket := range open {
		_ = socket.conn.UnderlyingConn().Close()
	}
}

// EventPayload is a schema 2.0 event as Feishu sends it.
func EventPayload(appID, eventID, eventType string, event any) []byte {
	payload, _ := json.Marshal(map[string]any{
		"schema": "2.0",
		"header": map[string]any{
			"event_id": eventID, "event_type": eventType, "app_id": appID, "tenant_key": "tenant_fake",
			"create_time": strconv.FormatInt(time.Now().UnixMilli(), 10), "token": "",
		},
		"event": event,
	})
	return payload
}

// MessagePayload is an im.message.receive_v1 event: a person's text in a
// group chat, mentioning the bot when mention is set, in reply to root
// when root is set.
func MessagePayload(appID, eventID, chatID, messageID, root, text string, mention bool) []byte {
	content, _ := json.Marshal(map[string]string{"text": text})
	message := map[string]any{
		"message_id": messageID, "chat_id": chatID, "chat_type": "group", "message_type": "text", "content": string(content),
		"create_time": strconv.FormatInt(time.Now().UnixMilli(), 10),
	}
	if root != "" {
		message["root_id"], message["parent_id"] = root, root
	}
	if mention {
		message["mentions"] = []map[string]any{{"key": "@_user_1", "name": "Foundry", "id": map[string]string{"open_id": "ou_bot"}}}
		message["content"] = strings.Replace(string(content), `"text":"`, `"text":"@_user_1 `, 1)
	}
	return EventPayload(appID, eventID, "im.message.receive_v1", map[string]any{
		"sender":  map[string]any{"sender_id": map[string]string{"open_id": "ou_person"}, "sender_type": "user", "tenant_key": "tenant_fake"},
		"message": message,
	})
}
