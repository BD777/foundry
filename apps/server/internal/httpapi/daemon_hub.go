package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

type DaemonHub struct {
	// What the hub tells browsers of what devices report.
	daemonNotifiers
	onEvidenceConnected func(context.Context, string)
	skillScans          map[string]*skillScan
	skillScansMu        sync.Mutex
	// onDeviceConnected runs once per daemon hello, until that socket closes.
	onDeviceConnected func(ctx context.Context, deviceID string, capabilities []string)
	// onWorkerUpdateStatus receives an update failure a worker reports
	// without being asked.
	onWorkerUpdateStatus func(deviceID string, status wsWorkerUpdateStatus)
	connections          map[string]*daemonConnection
	store                Backend
	// externalAccounts mints what a session may act as (external_accounts.go).
	externalAccounts *externalaccounts.Service
	// resources keeps what devices report of their resources (resources.go).
	resources *resources.Service
	// leases follow devices going and coming (resource_leases.go).
	leases *resources.Leases
	// live tracks every upgraded socket, including ones that never sent
	// hello and so never landed in connections. Shutdown needs all of them.
	live         map[*daemonConnection]struct{}
	mu           sync.Mutex
	shuttingDown bool
	upgrader     websocket.Upgrader
	// disconnects keeps each device's last drop for the device page.
	disconnects deviceDisconnects
	// subagents caches each session's subagent list as its device read it.
	subagents *subagentListCache
	// readTimeout is how long a connection may receive nothing at all from
	// its device (no pong, no part of a message) before it is dropped.
	readTimeout time.Duration
}

// daemonReadTimeout is the default readTimeout: two missed 30s pings.
const daemonReadTimeout = 70 * time.Second

func NewDaemonHub(store Backend, notifiers daemonNotifiers, allowedOrigin string) *DaemonHub {
	return &DaemonHub{
		daemonNotifiers: notifiers,
		connections:     make(map[string]*daemonConnection),
		live:            make(map[*daemonConnection]struct{}),
		store:           store,
		subagents:       newSubagentListCache(),
		readTimeout:     daemonReadTimeout,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return webSocketOriginAllowed(allowedOrigin, r)
			},
		},
	}
}

func (h *DaemonHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.isShuttingDown() {
		http.Error(w, "server is shutting down", http.StatusServiceUnavailable)
		return
	}
	if actorFromContext(r.Context()).Kind != ActorDaemon {
		http.Error(w, "device credential required", http.StatusUnauthorized)
		return
	}

	socket, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("daemon websocket upgrade failed: %v", err)
		return
	}

	connection := newDaemonConnection(h, socket)
	connection.actor = actorFromContext(r.Context())
	if !h.track(connection) {
		// Shutdown started between the guard above and the upgrade. Nothing
		// is pending yet, so dropping the socket is the whole teardown.
		_ = socket.Close()
		return
	}

	connection.writeStarted.Store(true)
	go connection.writeLoop()
	connection.readLoop(r.Context())
}

// Shutdown refuses new daemon upgrades and tears down every live socket.
// It is idempotent and safe to call concurrently: repeat calls re-close
// connections that are already closed, which is a no-op. It returns once
// every connection goroutine has returned, or ctx expires first.
func (h *DaemonHub) Shutdown(ctx context.Context) error {
	h.mu.Lock()
	h.shuttingDown = true
	live := make([]*daemonConnection, 0, len(h.live))
	for connection := range h.live {
		live = append(live, connection)
	}
	h.mu.Unlock()

	// close() may spend closeFrameGrace waiting for its writer to emit a close
	// frame. Start every close concurrently so shutdown latency is bounded by
	// one grace window rather than connection-count × grace window.
	for _, connection := range live {
		go connection.closeWith(closeServerShutdown)
	}
	for _, connection := range live {
		select {
		case <-connection.finished:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (h *DaemonHub) isShuttingDown() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.shuttingDown
}

// track registers a live socket unless shutdown already started.
func (h *DaemonHub) track(connection *daemonConnection) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.shuttingDown {
		return false
	}
	h.live[connection] = struct{}{}
	return true
}

func (h *DaemonHub) untrack(connection *daemonConnection) {
	h.mu.Lock()
	delete(h.live, connection)
	h.mu.Unlock()
}

func (h *DaemonHub) HasConnection(deviceID string) bool {
	h.mu.Lock()
	connection := h.connections[deviceID]
	h.mu.Unlock()
	if connection == nil {
		return false
	}
	select {
	case <-connection.done:
		return false
	default:
		return true
	}
}

// HasActiveSession reports whether the current connection for a device is a
// reconnect of the daemon process that actually owns this session. Device
// presence alone is insufficient: a restarted daemon reuses the device ID but
// cannot continue an in-memory SDK execution from the previous process.
func (h *DaemonHub) HasActiveSession(deviceID string, sessionID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	connection := h.connections[deviceID]
	if connection == nil {
		return false
	}
	select {
	case <-connection.done:
		return false
	default:
		return connection.hasActiveSession(sessionID)
	}
}

// connectionFor finds the live connection of exactly this device. There is
// no "any connected device" fallback: with several owners that would route a
// request to someone else's machine.
func (h *DaemonHub) connectionFor(deviceID string) *daemonConnection {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.connections[deviceID]
}

// closeRemovedDevice permanently drops the live connection for a soft-removed
// device with the device_removed close frame. It is best effort: an offline
// daemon is refused by the tombstone the next time it registers. The device is
// guaranteed idle here because SoftRemoveDevice rejects active work.
func (h *DaemonHub) closeRemovedDevice(deviceID string) {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return
	}
	h.mu.Lock()
	connection := h.connections[deviceID]
	h.mu.Unlock()
	if connection != nil {
		connection.closeRemoved()
	}
}

// closeDevice drops a device's live connection without the permanent
// removal code, e.g. after its credential was rotated by a new pairing.
func (h *DaemonHub) closeDevice(deviceID string) {
	h.mu.Lock()
	connection := h.connections[deviceID]
	h.mu.Unlock()
	if connection != nil {
		connection.closeWith(closeDevicePairedAgain)
	}
}

func (h *DaemonHub) workspaceOnDevice(ctx context.Context, workspaceID, deviceID string) bool {
	if workspaceID == "" {
		return false
	}
	workspace, err := h.store.GetWorkspace(ctx, workspaceID)
	return err == nil && workspace.DeviceID == deviceID
}

func (h *DaemonHub) issueOnDevice(ctx context.Context, issueID, deviceID string) bool {
	issue, err := h.store.GetIssue(ctx, issueID)
	return err == nil && h.workspaceOnDevice(ctx, issue.WorkspaceID, deviceID)
}

func (h *DaemonHub) syncRegistration(registration store.DaemonRegistration) error {
	if registration.Device.ID == "" {
		return errors.New("daemon registration requires device.id")
	}
	registration.Device.Status = "connected"
	registration.Device.LastSeenLabel = "online"
	registration.Device.Capabilities = registration.Capabilities
	_, err := h.registerDaemon(context.Background(), registration)
	return err
}

// registerDaemon stores a device's report and announces what it changed
// that no other event carries (device_status_changed carries the device).
func (h *DaemonHub) registerDaemon(ctx context.Context, registration store.DaemonRegistration) (store.DaemonChanges, error) {
	changes, err := h.store.RegisterDaemonChanges(ctx, registration)
	if err != nil {
		return store.DaemonChanges{}, err
	}
	h.devices.reported(changes)
	return changes, nil
}

// syncChats stores a device's native chats, sends viewers what changed in
// their chat lists, and returns the chats this server never keeps (see
// store.DaemonChanges.RefusedChats).
func (h *DaemonHub) syncChats(ctx context.Context, input store.SyncChatsInput) ([]string, error) {
	changes, err := h.store.SyncChatsChanges(ctx, input)
	if err != nil {
		return nil, err
	}
	h.chats.chatsSynced(ctx, input, changes)
	return changes.RefusedChats, nil
}

func (c *daemonConnection) syncRegistration(registration store.DaemonRegistration) error {
	if registration.Device.ID == "" {
		return errors.New("daemon registration requires device.id")
	}
	if !c.actor.ActsAsDevice(registration.Device.ID) {
		return errors.New("daemon registration device does not match its credential")
	}
	logWorkerStalls(registration)
	c.hub.logWorkerConnections(registration)
	// A device with no workspace yet registers itself alone; its workspaces
	// arrive later as the person adds them.
	registration.Device.Status = "connected"
	registration.Device.LastSeenLabel = "online"
	registration.Device.Capabilities = registration.Capabilities
	changes, err := c.hub.registerDaemon(context.Background(), registration)
	if err != nil {
		if errors.Is(err, store.ErrDeviceRemoved) {
			// Permanent refusal: emit the application close frame so the worker
			// stops reconnecting and waits for an explicit re-pair.
			c.closePermanent(wsDeviceRemovedCloseCode, wsDeviceRemovedReason)
		}
		return err
	}
	if changes.DeletedWorkspace != "" {
		// The person deleted this workspace from the device; the device
		// still serves its folder. Only the device's news counts, and the
		// device is told again to forget the folder.
		go c.forgetDeletedWorkspace(registration.Device.ID, registration.Workspace)
		registration.Workspace = store.WorkspaceProjection{}
	}
	c.hub.devices.registrationChanged(registration)
	if registration.ActiveSessionIDs != nil {
		c.replaceActiveSessions(registration.ActiveSessionIDs)
	}
	c.registrationMu.Lock()
	if registration.Workspace.ID != "" {
		c.registrations[registration.Workspace.ID] = registration
		c.registration = registration
	} else {
		// Device-only news must not cost the connection the workspace it
		// claims Issues for.
		c.registration.Device = registration.Device
		c.registration.Capabilities = registration.Capabilities
		c.registration.ProviderHealth = registration.ProviderHealth
		c.registration.AgentProfiles = registration.AgentProfiles
	}
	c.deviceID = registration.Device.ID
	c.registrationMu.Unlock()

	deviceID := registration.Device.ID
	// Publish the connection and re-check the tombstone inside ONE critical
	// section. SoftRemoveDevice commits its tombstone first and only then takes
	// this lock to drop the connection, so the two orderings are exhaustive:
	// either the removal's critical section sees this connection and closes it,
	// or the check here sees the committed tombstone and refuses the socket.
	// There is no window in which a removed device holds a live connection.
	c.hub.mu.Lock()
	previous := c.hub.connections[deviceID]
	c.hub.connections[deviceID] = c
	removed, removedErr := c.hub.store.DeviceRemoved(context.Background(), deviceID)
	if removedErr == nil && removed && c.hub.connections[deviceID] == c {
		delete(c.hub.connections, deviceID)
	}
	c.hub.mu.Unlock()
	// close() can wait for the WebSocket writer's grace window. Do not hold the
	// hub-wide connection lock while replacing an old socket for this device.
	if previous != nil && previous != c {
		previous.closeWith(closeReplaced)
	}
	if removedErr != nil {
		c.closeWith(closeRegistrationUnchecked)
		return removedErr
	}
	if removed {
		c.closePermanent(wsDeviceRemovedCloseCode, wsDeviceRemovedReason)
		return store.ErrDeviceRemoved
	}
	if c.hub.onEvidenceConnected != nil && registration.Workspace.ID != "" {
		go func() {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			go func() {
				select {
				case <-c.done:
					cancel()
				case <-ctx.Done():
				}
			}()
			c.hub.onEvidenceConnected(ctx, registration.Workspace.ID)
		}()
	}
	return nil
}

// registrationAnswered takes the registration a device sent with an answer,
// if any, and sends the device the sessions queued in its workspace.
func (c *daemonConnection) registrationAnswered(registration store.DaemonRegistration) error {
	if registration.Device.ID == "" {
		return nil
	}
	if err := c.syncRegistration(registration); err != nil {
		return err
	}
	go c.dispatchQueuedAgentSessions(registration.Workspace.ID)
	return nil
}

func (h *DaemonHub) unregister(connection *daemonConnection) {
	deviceID, _ := connection.registrationSnapshot()
	if deviceID == "" {
		return
	}

	h.mu.Lock()
	current := h.connections[deviceID]
	if current == connection {
		delete(h.connections, deviceID)
	}
	h.mu.Unlock()

	if current != connection {
		return
	}
	h.resourcesOffline(deviceID)

	connection.registrationMu.Lock()
	registrations := make([]store.DaemonRegistration, 0, len(connection.registrations))
	for _, registration := range connection.registrations {
		registrations = append(registrations, registration)
	}
	if len(registrations) == 0 && connection.registration.Workspace.ID != "" {
		registrations = append(registrations, connection.registration)
	}
	connection.registrationMu.Unlock()
	if len(registrations) == 0 {
		// A device without a workspace has no row to mark offline; its
		// disconnect record (lastDisconnect) is still news, and no device
		// event reaches its viewers without a workspace.
		h.dataChanges.changed("", fieldDevices)
		return
	}
	for _, registration := range registrations {
		registration.Device.Status = "disconnected"
		registration.Device.LastSeenLabel = "offline"
		if _, err := h.registerDaemon(context.Background(), registration); err == nil {
			h.devices.registrationChanged(registration)
		} else {
			// A soft-removed device is expected to fail the offline upsert;
			// its connection was dropped on purpose, so this is not worth a
			// log line on every teardown.
			if !errors.Is(err, store.ErrDeviceRemoved) {
				log.Printf("daemon websocket offline update failed for %s: %v", deviceID, err)
			}
		}
	}
}

// logWorkerStalls writes the event-loop stalls a worker reported: a stall
// long enough misses the heartbeat and costs the device its connection, and
// the log names what the worker was doing.
func logWorkerStalls(registration store.DaemonRegistration) {
	label := registration.Device.Label
	if label == "" {
		label = registration.Device.ID
	}
	for _, stall := range registration.Stalls {
		activity := strings.Join(stall.Activities, ", ")
		if activity == "" {
			activity = "no marked activity"
		}
		log.Printf("device %s worker stalled %.1fs during %s at %s", label, float64(stall.LagMs)/1000, activity, stall.At)
	}
}
