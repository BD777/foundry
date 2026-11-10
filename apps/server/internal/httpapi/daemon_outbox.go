package httpapi

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// workerOutbox is how far behind a worker's session outbox is, as its
// heartbeat reports it.
type workerOutbox struct {
	// Queued messages wait to be written to the socket; the oldest for
	// OldestQueuedMs.
	Queued         int   `json:"queued"`
	OldestQueuedMs int64 `json:"oldestQueuedMs"`
	// Unacknowledged messages were sent or wait for the server's answer.
	Unacknowledged int `json:"unacknowledged"`
	// AckLatencyMs is how long the latest acknowledged message took from
	// being sent to its acknowledgement (0: none lately).
	AckLatencyMs  int64 `json:"ackLatencyMs"`
	BufferedBytes int64 `json:"bufferedBytes"`
}

// lag is how late what the worker sends reaches the server: what still waits
// on the worker, or what the latest answer took. An answer that never came
// says nothing about the link and is not counted.
func (o workerOutbox) lag() time.Duration {
	return time.Duration(max(o.OldestQueuedMs, o.AckLatencyMs)) * time.Millisecond
}

type wsHeartbeatPayload struct {
	Outbox *workerOutbox `json:"outbox,omitempty"`
	// ActiveSessionIDs are the sessions the daemon process runs now, as in
	// its registration; nil from a worker that does not send them.
	ActiveSessionIDs *[]string `json:"activeSessionIds,omitempty"`
	// NativeWorkSessionIDs are the sessions whose agents still work on
	// their own in this daemon's processes past a Foundry turn (background
	// tasks, timers, a turn the agent continues, a kept Codex app-server);
	// they keep the sessions' connector grants live (gateway.SessionLive).
	NativeWorkSessionIDs []string `json:"nativeWorkSessionIds,omitempty"`
	// RuntimeState is the worker's latest admission decision and resource
	// sample. The server stores it as reported.
	RuntimeState *store.DeviceRuntimeState `json:"runtimeState,omitempty"`
}

const (
	// workerOutboxBehind is the lag worth a line in the log, at most once
	// per workerOutboxLogInterval per connection.
	workerOutboxBehind      = time.Minute
	workerOutboxLogInterval = 5 * time.Minute
	// workerOutboxReportFresh is how long a heartbeat's report stands; a
	// worker sends one every 25 s.
	workerOutboxReportFresh = 2 * time.Minute
)

type workerOutboxReport struct {
	mu     sync.Mutex
	outbox workerOutbox
	at     time.Time
	logged time.Time
}

// noteHeartbeat keeps what a heartbeat says about the sessions the worker
// runs and about its outbox. A heartbeat without a report, or one this
// server cannot read, is still a heartbeat.
func (c *daemonConnection) noteHeartbeat(payload json.RawMessage) {
	var heartbeat wsHeartbeatPayload
	if len(payload) > 0 && json.Unmarshal(payload, &heartbeat) != nil {
		heartbeat = wsHeartbeatPayload{}
	}
	c.noteHeartbeatClaims(heartbeat.ActiveSessionIDs)
	c.confirmNativeWork(heartbeat.NativeWorkSessionIDs)
	if heartbeat.RuntimeState != nil {
		deviceID, _ := c.registrationSnapshot()
		if deviceID != "" {
			if recorder, ok := c.hub.store.(store.DeviceRuntimeStateStore); ok {
				if err := recorder.SaveDeviceRuntimeState(
					context.Background(),
					deviceID,
					*heartbeat.RuntimeState,
				); err != nil {
					log.Printf("daemon %s runtime state not kept: %v", deviceID, err)
				}
			}
		}
	}
	if heartbeat.Outbox == nil {
		return
	}
	outbox := *heartbeat.Outbox
	now := time.Now()
	lag := outbox.lag()
	c.outbox.mu.Lock()
	c.outbox.outbox, c.outbox.at = outbox, now
	report := lag >= workerOutboxBehind && now.Sub(c.outbox.logged) >= workerOutboxLogInterval
	if report {
		c.outbox.logged = now
	}
	c.outbox.mu.Unlock()
	if report {
		deviceID, _ := c.registrationSnapshot()
		log.Printf("daemon %s is behind: its session messages arrive %s late; %d not yet written, %d unacknowledged, %d bytes on its socket",
			deviceID, lag.Round(time.Second), outbox.Queued, outbox.Unacknowledged, outbox.BufferedBytes)
	}
}

// noteHeartbeatClaims takes the sessions a heartbeat says the daemon runs,
// when it says (an older worker does not), and records that the device
// claims every session this connection holds now: a session silent for a
// long tool call stays claimed (session_claims.go).
func (c *daemonConnection) noteHeartbeatClaims(sessionIDs *[]string) {
	if sessionIDs != nil {
		c.replaceActiveSessions(*sessionIDs)
	}
	c.confirmActiveSessions()
}

// outboxLag is how late the worker's session messages reach the server, by
// its latest heartbeat; zero when it reports none.
func (c *daemonConnection) outboxLag() time.Duration {
	c.outbox.mu.Lock()
	defer c.outbox.mu.Unlock()
	if c.outbox.at.IsZero() || time.Since(c.outbox.at) > workerOutboxReportFresh {
		return 0
	}
	return c.outbox.outbox.lag()
}

// connectedDevice is a connected device's label, how late its session
// messages arrive and when its connection opened; ok is false while it is
// not connected.
func (h *DaemonHub) connectedDevice(deviceID string) (label string, lag time.Duration, connectedAt time.Time, ok bool) {
	if !h.HasConnection(deviceID) {
		return "", 0, time.Time{}, false
	}
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return "", 0, time.Time{}, false
	}
	return connection.deviceLabel(), connection.outboxLag(), connection.connectedAt, true
}

// recordSessionEvent stores a device's session event and reports whether it
// changed anything: an event sent again unchanged does not.
func (c *daemonConnection) recordSessionEvent(ctx context.Context, event store.AgentSessionEvent) (bool, error) {
	return c.hub.store.RecordAgentSessionEvent(ctx, event)
}
