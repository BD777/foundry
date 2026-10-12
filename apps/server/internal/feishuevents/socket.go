package feishuevents

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishugateway"
	"github.com/gorilla/websocket"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
)

// GatewayEvents serves the Feishu gateway's event routes
// (feishugateway.EventSubscriptions) from the hub: Feishu's long-connection
// endpoint discovery and its event socket, emulated, so the unchanged
// `feishu-cli event consume` receives events from the server's one
// connection per app and the device never holds the app secret. The
// gateway authenticates both steps; a socket streams every event of the
// caller's app (feishu-cli keeps the types it consumes) and counts as one
// of the caller's subscriptions.
type GatewayEvents struct {
	Hub *Hub
	// Recheck authorizes a socket's caller again
	// (feishugateway.Gateway.Authorized); the socket closes once it fails.
	// Nil never rechecks.
	Recheck func(ctx context.Context, caller feishugateway.Caller) error
	// RecheckEvery is how often; zero is a minute.
	RecheckEvery time.Duration
}

var _ feishugateway.EventSubscriptions = GatewayEvents{}

// socketPingInterval is what the emulated endpoint tells feishu-cli.
const socketPingInterval = 120

func callerSubscriber(caller feishugateway.Caller) Subscriber {
	return Subscriber{SessionID: caller.SessionID, UserID: caller.UserID, WorkspaceID: caller.WorkspaceID}
}

func (g GatewayEvents) ServeEndpoint(w http.ResponseWriter, _ *http.Request, caller feishugateway.Caller, connectURL string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(g.endpoint(caller, connectURL))
}

// endpoint is the discovery answer: Feishu puts refusals in the code, with
// status 200. Forbidden is a client error to the SDK, so feishu-cli stops
// instead of retrying forever.
func (g GatewayEvents) endpoint(caller feishugateway.Caller, connectURL string) larkws.EndpointResp {
	if err := g.Hub.Integrations.Err(); err != nil {
		return larkws.EndpointResp{Code: larkws.Forbidden, Msg: err.Error()}
	}
	if caller.ClientID == "" {
		return larkws.EndpointResp{Code: larkws.Forbidden, Msg: "this session has no Feishu app to receive events of"}
	}
	separator := "?"
	if strings.Contains(connectURL, "?") {
		separator = "&"
	}
	connectURL += separator + larkws.DeviceID + "=" + url.QueryEscape(caller.SessionID) + "&" + larkws.ServiceID + "=1"
	return larkws.EndpointResp{Code: larkws.OK, Data: &larkws.Endpoint{
		Url: connectURL,
		// feishu-cli applies these: reconnect forever, 5 s apart (through
		// discovery again), after up to 1 s of jitter.
		ClientConfig: &larkws.ClientConfig{ReconnectCount: -1, ReconnectInterval: 5, ReconnectNonce: 1, PingInterval: socketPingInterval},
	}}
}

// refuseHandshake answers a socket request that cannot be served the way
// Feishu does, so the SDK reports the reason.
func refuseHandshake(w http.ResponseWriter, status int, message string) {
	w.Header().Set(larkws.HeaderHandshakeStatus, strconv.Itoa(status))
	w.Header().Set(larkws.HeaderHandshakeMsg, message)
	http.Error(w, message, status)
}

func (g GatewayEvents) ServeConnection(w http.ResponseWriter, r *http.Request, caller feishugateway.Caller) {
	if caller.ClientID == "" {
		refuseHandshake(w, larkws.Forbidden, "this session has no Feishu app to receive events of")
		return
	}
	subscription, err := g.Hub.addSubscription(callerSubscriber(caller), caller.ClientID, nil, "")
	if err != nil {
		refuseHandshake(w, larkws.Forbidden, err.Error())
		return
	}
	defer g.Hub.endSubscription(subscription)
	socket, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer socket.Close()
	serviceID, _ := strconv.ParseInt(r.URL.Query().Get(larkws.ServiceID), 10, 32)
	served := &servedSocket{socket: socket, serviceID: int32(serviceID)}
	done := make(chan struct{})
	defer close(done)
	go func() {
		defer socket.Close()
		served.stream(subscription, done)
	}()
	if g.Recheck != nil {
		go g.recheck(caller, socket, done)
	}
	served.read()
}

// recheck closes the socket once its caller may no longer receive events
// (the session ended, the account was stopped or unbound).
func (g GatewayEvents) recheck(caller feishugateway.Caller, socket *websocket.Conn, done <-chan struct{}) {
	every := g.RecheckEvery
	if every <= 0 {
		every = time.Minute
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			err := g.Recheck(ctx, caller)
			cancel()
			if err != nil {
				g.Hub.logf("feishu events: closing session %s's event socket: %v", caller.SessionID, err)
				_ = socket.Close()
				return
			}
		}
	}
}

type servedSocket struct {
	socket    *websocket.Conn
	serviceID int32
	writing   sync.Mutex
	seq       uint64
}

func (s *servedSocket) write(frame larkws.Frame) error {
	raw, err := frame.Marshal()
	if err != nil {
		return err
	}
	s.writing.Lock()
	defer s.writing.Unlock()
	_ = s.socket.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return s.socket.WriteMessage(websocket.BinaryMessage, raw)
}

// read answers pings until the client goes away. Acks need no answer.
func (s *servedSocket) read() {
	for {
		_ = s.socket.SetReadDeadline(time.Now().Add(3 * socketPingInterval * time.Second))
		kind, raw, err := s.socket.ReadMessage()
		if err != nil {
			return
		}
		var frame larkws.Frame
		if kind != websocket.BinaryMessage || frame.Unmarshal(raw) != nil {
			continue
		}
		if larkws.FrameType(frame.Method) == larkws.FrameTypeControl && frameType(frame) == string(larkws.MessageTypePing) {
			if s.write(pongFrame(s.serviceID, &larkws.ClientConfig{PingInterval: socketPingInterval})) != nil {
				return
			}
		}
	}
}

// stream writes the subscription's events as Feishu would, until the
// subscription ends, a write fails, or the reader is done.
func (s *servedSocket) stream(subscription *Subscription, done <-chan struct{}) {
	for {
		batch, wake, closed := subscription.take(nil, MaxEventsPerPoll)
		for _, event := range batch.Events {
			s.seq++
			messageID := event.ID
			if messageID == "" {
				messageID = newID("msg_")
			}
			if s.write(eventFrame(s.seq, s.serviceID, messageID, event.Payload)) != nil {
				return
			}
		}
		if batch.More {
			continue
		}
		if closed {
			return
		}
		select {
		case <-done:
			return
		case <-wake:
		}
	}
}
