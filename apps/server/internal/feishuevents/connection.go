package feishuevents

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
)

// DefaultBaseURL is Feishu's open platform, where an app with no base URL
// of its own negotiates its long connection.
const DefaultBaseURL = "https://open.feishu.cn"

const (
	defaultPingInterval = 2 * time.Minute
	// stableConnection: a connection that lasted this long resets the
	// reconnect backoff.
	stableConnection = time.Minute
)

// connection is the server's one long connection for one Feishu app. It
// reconnects with backoff until stopped, reading the app's credentials
// afresh on every attempt, so a corrected secret is picked up without a
// restart.
type connection struct {
	hub    *Hub
	appID  string
	cancel context.CancelFunc
	done   chan struct{}
	// kick cuts a reconnect wait short (someone new needs the app).
	kick chan struct{}
}

func (h *Hub) startConnection(appID string) *connection {
	ctx, cancel := context.WithCancel(context.Background())
	c := &connection{hub: h, appID: appID, cancel: cancel, done: make(chan struct{}), kick: make(chan struct{}, 1)}
	go c.run(ctx)
	return c
}

func (c *connection) retryNow() {
	select {
	case c.kick <- struct{}{}:
	default:
	}
}

func (c *connection) run(ctx context.Context) {
	defer close(c.done)
	delay := c.hub.ReconnectMin
	for {
		started := time.Now()
		err := c.connectOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			err = errors.New("the connection closed")
		}
		c.hub.connectionChanged(c, Status{Detail: err.Error()})
		c.hub.logf("feishu events: app %s: %v", c.appID, err)
		if time.Since(started) >= stableConnection {
			delay = c.hub.ReconnectMin
		}
		wait := delay/2 + rand.N(delay/2+1)
		select {
		case <-ctx.Done():
			return
		case <-c.kick:
			delay = c.hub.ReconnectMin
			continue
		case <-time.After(wait):
		}
		delay = min(delay*2, c.hub.ReconnectMax)
	}
}

// connectOnce negotiates an endpoint, dials it and serves the connection
// until it fails or ctx ends.
func (c *connection) connectOnce(ctx context.Context) error {
	credentials, err := c.hub.credentials.AppCredentials(ctx, c.appID)
	if err != nil {
		return fmt.Errorf("read the app's credentials: %w", err)
	}
	base := c.hub.Domain
	if base == "" {
		base = credentials.BaseURL
	}
	if base == "" {
		base = DefaultBaseURL
	}
	endpoint, config, err := c.hub.fetchEndpoint(ctx, base, credentials)
	if err != nil {
		return err
	}
	address, err := url.Parse(endpoint)
	if err != nil || address.Host == "" {
		return fmt.Errorf("feishu returned an invalid event endpoint")
	}
	socket, response, err := c.hub.dialer().DialContext(ctx, endpoint, nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		if response != nil && response.Header.Get(larkws.HeaderHandshakeMsg) != "" {
			return fmt.Errorf("feishu refused the event connection: %s", response.Header.Get(larkws.HeaderHandshakeMsg))
		}
		return fmt.Errorf("dial the event connection: %w", err)
	}
	serviceID, _ := strconv.ParseInt(address.Query().Get(larkws.ServiceID), 10, 32)
	live := &liveConnection{connection: c, socket: socket, serviceID: int32(serviceID)}
	live.pingInterval.Store(int64(defaultPingInterval))
	live.configure(config)
	c.hub.connectionChanged(c, Status{Connected: true})
	return live.serve(ctx)
}

// fetchEndpoint asks Feishu where to connect: POST /callback/ws/endpoint
// with the app's id and secret.
func (h *Hub) fetchEndpoint(ctx context.Context, base string, credentials Credentials) (string, *larkws.ClientConfig, error) {
	body, _ := json.Marshal(larkws.BootstrapRequest{AppID: credentials.AppID, AppSecret: credentials.AppSecret})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(base, "/")+larkws.GenEndpointUri, bytes.NewReader(body))
	if err != nil {
		return "", nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("locale", "zh")
	response, err := h.httpClient().Do(request)
	if err != nil {
		return "", nil, fmt.Errorf("ask feishu for an event endpoint: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", nil, fmt.Errorf("read feishu's event endpoint: %w", err)
	}
	var answer larkws.EndpointResp
	if err := json.Unmarshal(raw, &answer); err != nil {
		return "", nil, fmt.Errorf("feishu's event endpoint answered %d: %s", response.StatusCode, truncate(raw, 200))
	}
	if response.StatusCode != http.StatusOK || answer.Code != larkws.OK {
		return "", nil, fmt.Errorf("feishu refused an event endpoint (%d): %s", answer.Code, answer.Msg)
	}
	if answer.Data == nil || answer.Data.Url == "" {
		return "", nil, errors.New("feishu returned no event endpoint")
	}
	return answer.Data.Url, answer.Data.ClientConfig, nil
}

func truncate(raw []byte, limit int) string {
	if len(raw) > limit {
		return string(raw[:limit]) + "…"
	}
	return string(raw)
}

// liveConnection is one dialled socket of a connection.
type liveConnection struct {
	*connection
	socket       *websocket.Conn
	serviceID    int32
	pingInterval atomic.Int64
	writing      sync.Mutex
	parts        parts
}

func (l *liveConnection) configure(config *larkws.ClientConfig) {
	if config != nil && config.PingInterval > 0 {
		l.pingInterval.Store(int64(time.Duration(config.PingInterval) * time.Second))
	}
}

func (l *liveConnection) write(frame larkws.Frame) error {
	raw, err := frame.Marshal()
	if err != nil {
		return err
	}
	l.writing.Lock()
	defer l.writing.Unlock()
	_ = l.socket.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return l.socket.WriteMessage(websocket.BinaryMessage, raw)
}

// serve pings on Feishu's interval and reads frames until the socket fails
// or ctx ends. Events are handled in the reading goroutine, in order, and
// acked as soon as the router took them.
func (l *liveConnection) serve(ctx context.Context) error {
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-ctx.Done():
		case <-stop:
		}
		_ = l.socket.Close()
	}()
	go func() {
		for {
			if err := l.write(pingFrame(l.serviceID)); err != nil {
				_ = l.socket.Close()
				return
			}
			select {
			case <-stop:
				return
			case <-time.After(time.Duration(l.pingInterval.Load())):
			}
		}
	}()
	for {
		// Silence longer than two ping rounds means the path is gone.
		_ = l.socket.SetReadDeadline(time.Now().Add(2*time.Duration(l.pingInterval.Load()) + 10*time.Second))
		kind, raw, err := l.socket.ReadMessage()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("event connection lost: %w", err)
		}
		if kind != websocket.BinaryMessage {
			continue
		}
		var frame larkws.Frame
		if err := frame.Unmarshal(raw); err != nil {
			continue
		}
		switch larkws.FrameType(frame.Method) {
		case larkws.FrameTypeControl:
			if frameType(frame) == string(larkws.MessageTypePong) && len(frame.Payload) > 0 {
				var config larkws.ClientConfig
				if json.Unmarshal(frame.Payload, &config) == nil {
					l.configure(&config)
				}
			}
		case larkws.FrameTypeData:
			if err := l.handleData(frame); err != nil {
				return fmt.Errorf("ack an event: %w", err)
			}
		}
	}
}

// handleData routes one event and acks it. A payload that is not an event
// is acked too: Feishu repushing it would not make it one.
func (l *liveConnection) handleData(frame larkws.Frame) error {
	started := time.Now()
	payload, whole := l.parts.add(frame, started)
	if !whole || frameType(frame) != string(larkws.MessageTypeEvent) {
		return nil
	}
	event, err := parseEvent(l.appID, payload, started)
	if err != nil {
		l.hub.logf("feishu events: app %s: dropped a frame that is not an event: %v", l.appID, err)
	} else {
		l.hub.receive(l.connection, event)
	}
	return l.write(ackFrame(frame, time.Since(started)))
}
