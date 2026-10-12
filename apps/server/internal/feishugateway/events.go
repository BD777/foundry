package feishugateway

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Caller is the session a gateway request was authenticated for: a live
// grant, on the device that runs the session, for an account the session
// may still act as.
type Caller struct {
	SessionID   string
	WorkspaceID string
	DeviceID    string
	// UserID started the session and owns the account.
	UserID    string
	AccountID string
	// AppID is the external provider app (xapp_…); ClientID its Feishu app
	// id (cli_…), the app whose events the caller may receive.
	AppID    string
	ClientID string
}

// EventSubscriptions serves feishu-cli's event long connection
// (`feishu-cli event consume`) from the server's own connection to Feishu,
// so no device ever needs the app secret for events. The gateway
// authenticates both steps and hands over the Caller; the implementation
// (internal/feishuevents) decides what the caller receives.
type EventSubscriptions interface {
	// ServeEndpoint answers POST /callback/ws/endpoint, which feishu-cli's
	// SDK sends with {AppID, AppSecret} (the secret is the session's app
	// handle, already checked). The answer is Feishu's shape:
	//   {"code":0,"data":{"URL":"<connectURL>&device_id=…&service_id=…","ClientConfig":{…}}}
	// connectURL is the ws:// URL, through the device's loopback forwarder,
	// that leads back to ServeConnection for this caller; it already carries
	// a query (a single-use ticket, valid for a minute), so add parameters
	// with "&". The gateway ignores every parameter but its own.
	ServeEndpoint(w http.ResponseWriter, r *http.Request, caller Caller, connectURL string)
	// ServeConnection upgrades r and serves the event socket. The caller was
	// authorized again just now; Gateway.Authorized re-checks a caller later
	// (the session may end, the account may be stopped) so a long-lived
	// socket can close when access ends.
	ServeConnection(w http.ResponseWriter, r *http.Request, caller Caller)
}

// eventSocketPath is where connectURL points, below the gateway prefix.
const eventSocketPath = "/foundry/event-socket"

const eventTicketLifetime = time.Minute

// eventTickets are the single-use tickets connectURLs carry: they name the
// grant the endpoint request was authenticated with.
type eventTickets struct {
	mu      sync.Mutex
	tickets map[string]eventTicket
}

type eventTicket struct {
	grant   store.FeishuGatewayGrant
	expires time.Time
}

func (t *eventTickets) issue(grant store.FeishuGatewayGrant, now time.Time) string {
	raw := make([]byte, 24)
	_, _ = rand.Read(raw)
	ticket := base64.RawURLEncoding.EncodeToString(raw)
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tickets == nil {
		t.tickets = map[string]eventTicket{}
	}
	for key, entry := range t.tickets {
		if now.After(entry.expires) {
			delete(t.tickets, key)
		}
	}
	t.tickets[ticket] = eventTicket{grant: grant, expires: now.Add(eventTicketLifetime)}
	return ticket
}

// redeem spends a ticket and returns the grant it was issued for.
func (t *eventTickets) redeem(ticket string, now time.Time) (store.FeishuGatewayGrant, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	entry, ok := t.tickets[ticket]
	delete(t.tickets, ticket)
	if !ok || now.After(entry.expires) {
		return store.FeishuGatewayGrant{}, false
	}
	return entry.grant, true
}
