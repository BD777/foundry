package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/wirerecord"
	"github.com/gorilla/websocket"
)

type DaemonHub struct {
	// What the hub tells browsers of what devices report.
	daemonNotifiers
	onEvidenceConnected func(context.Context, string)
	// assistantRun is what a run of the session needs as the person's
	// assistant (assistant.Service.RunFor); ok is false for any other
	// session.
	assistantRun func(ctx context.Context, session store.AgentSession) (run assistant.Run, ok bool, err error)
	// settleIssueSession hands what an Issue's session produced, once it
	// ended, to the Issue (issues.Service.Settle).
	settleIssueSession func(ctx context.Context, session store.AgentSession, execution *store.CompleteIssueInput, clarification *store.ClarificationResponse)
	// retrySessionFailure turns a model rate-limit failure into a durable
	// retry instead of a terminal turn. It reports whether it did.
	retrySessionFailure func(ctx context.Context, session store.AgentSession, failure string) (bool, error)
	sessionRetryStarted func(ctx context.Context, session store.AgentSession)
	sessionRetryDone    func(ctx context.Context, session store.AgentSession, failed bool)
	skillWarmMu         sync.Mutex
	skillWarmDirty      bool
	skillWarmRunning    bool
	skillScans          map[string]*skillScan
	skillScansMu        sync.Mutex
	// skillScanAnswers keeps each device's last scan answer (skills.go).
	skillScanAnswers keptSkillScans
	// onDeviceConnected runs once per daemon hello, until that socket closes.
	onDeviceConnected func(ctx context.Context, deviceID string)
	// onWorkerUpdateStatus receives an update failure a worker reports
	// without being asked.
	onWorkerUpdateStatus func(deviceID string, status wsWorkerUpdateStatus)
	// migrations runs workspace moves to other devices
	// (workspace_migration_driver.go).
	migrations workspaceMigrationRuntime
	// onDeviceRunner receives a worker's news of its session runner.
	onDeviceRunner func(c *daemonConnection, deviceID string, runner store.DeviceRunner)
	connections    map[string]*daemonConnection
	// reconnects keeps the grace window after each device connection ended.
	reconnects map[string]*deviceReconnect
	// claims keeps when each device last claimed each session it runs
	// (session_claims.go).
	claims *sessionClaims
	store  Backend
	// usageStats records usage facts from session events and terminal turns.
	usageStats usageRecorder
	// connectors decides what a session may use of each connector (connectors.go).
	connectors *connectors.Module
	// resources keeps what devices report of their resources (resources.go).
	resources *resources.Service
	// inboxConsumed settles a session message its worker reports read and
	// reports whether the event was that report (session_inbox.go).
	inboxConsumed func(ctx context.Context, event store.AgentSessionEvent) bool
	// awaitSessionStart waits for whoever is still starting the session
	// (sessions.Service.AwaitStart).
	awaitSessionStart func(sessionID string) bool
	// questionSettled closes what waited on a question its worker reports
	// settled and reports whether the event was that report (pending_items.go).
	questionSettled func(ctx context.Context, event store.AgentSessionEvent) bool
	// leases follow devices going and coming (resource_leases.go).
	leases *resources.Leases
	// live tracks every upgraded socket, including ones that never sent
	// hello and so never landed in connections. Shutdown needs all of them.
	live         map[*daemonConnection]struct{}
	mu           sync.Mutex
	shuttingDown bool
	// work is what the hub and the server start beside requests and
	// connections; Shutdown waits for it, so none of it outlives the store.
	work     *workGroup
	upgrader websocket.Upgrader
	// wire samples envelopes both ways when the server records device
	// traffic (wire_record.go); nil records nothing.
	wire *wirerecord.Recorder
	// disconnects keeps each device's last drop for the device page.
	disconnects deviceDisconnects
	// subagents caches each session's subagent list as its device read it.
	subagents *subagentListCache
	// sections keeps what devices registered, so a registration can leave
	// out what did not change (registration_sections.go).
	sections registrationSections
	// readTimeout is how long a connection may receive nothing at all from
	// its device (no pong, no part of a message) before it is dropped.
	readTimeout time.Duration
	// connectorProgress: running connector installs, as devices report them.
	connectorProgress connectorProgressBoard
	// probeAfter and probeWindow override daemonProbeAfter/Window in tests.
	probeAfter, probeWindow time.Duration
}

// daemonReadTimeout is the default readTimeout: two missed 30s pings.
const daemonReadTimeout = 70 * time.Second

func NewDaemonHub(store Backend, notifiers daemonNotifiers, allowedOrigin string) *DaemonHub {
	return &DaemonHub{
		daemonNotifiers: notifiers,
		connections:     make(map[string]*daemonConnection),
		reconnects:      make(map[string]*deviceReconnect),
		claims:          newSessionClaims(time.Now()),
		live:            make(map[*daemonConnection]struct{}),
		work:            newWorkGroup(nil),
		store:           store,
		subagents:       newSubagentListCache(),
		readTimeout:     daemonReadTimeout,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return webSocketOriginAllowed(allowedOrigin, r)
			},
			// permessage-deflate, when the device offers it: registrations,
			// scans and session events are JSON that shrinks several times,
			// and a device's uplink can be slow and lossy. Only "no context
			// takeover" is supported (each message compressed on its own),
			// so no connection keeps a compression window between messages;
			// the flate writers and readers are pooled. A worker that offers
			// nothing keeps sending plain frames.
			EnableCompression: true,
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

// Shutdown refuses new daemon upgrades, tears down every live socket and
// stops the work started beside them (h.work). It is idempotent and safe to
// call concurrently: repeat calls re-close connections that are already
// closed, which is a no-op. It returns once every connection goroutine and
// every piece of that work has returned, or ctx expires first.
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
			_ = h.work.Stop(ctx)
			return ctx.Err()
		}
	}
	return h.work.Stop(ctx)
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

// closeRemovedDevice permanently drops the live connection of a removed
// device with the device_removed close frame; its worker parks and stops what
// it runs. An offline worker is refused by the tombstone when it returns.
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

// registerDaemon stores a device's report and announces what it changed
// that no other event carries (device_status_changed carries the device).
func (h *DaemonHub) registerDaemon(ctx context.Context, registration store.DaemonRegistration) (store.DaemonChanges, error) {
	if h.connectors != nil {
		connectors, extensionErrors := h.connectors.SanitizeDeviceConnectors(registration.Device.Connectors)
		registration.Device.Connectors = connectors
		registration.Device.ExtensionErrors = extensionErrors
		for _, refused := range extensionErrors {
			h.connectors.ServerHeld.Logf("refused connector extension descriptor device=%s extension=%s kind=%s reason=%s",
				registration.Device.ID, refused.ExtensionID, refused.Kind, refused.Reason)
		}
	} else {
		registration.Device.Connectors = nil
		registration.Device.ExtensionErrors = nil
	}
	changes, err := h.store.RegisterDaemonChanges(ctx, registration)
	if err != nil {
		return store.DaemonChanges{}, err
	}
	h.devices.reported(ctx, registration.Device.ID, changes)
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
	// Before anything is logged or stored: a registration missing sections
	// is sent again in full, with the same reports.
	if err := c.hub.sections.fill(registration.Device.ID, &registration); err != nil {
		return err
	}
	logWorkerStalls(registration)
	c.hub.logWorkerConnections(registration)
	c.hub.recordAccountIdentity(registration)
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
	c.hub.connectionResuming(registration.Device.ID)
	c.hub.sections.keep(registration.Device.ID, registration)
	if changes.DeletedWorkspace != "" {
		// The person deleted this workspace from the device; the device
		// still serves its folder. Only the device's news counts, and the
		// device is told again to forget the folder.
		deviceID, workspace := registration.Device.ID, registration.Workspace
		c.hub.work.Go(func() { c.forgetDeletedWorkspace(deviceID, workspace) })
		registration.Workspace = store.WorkspaceProjection{}
	}
	if changes.MovedWorkspace != "" {
		// The workspace moved to another device and this one has not retired
		// it yet: only the device's news counts, and its move goes on.
		registration.Workspace = store.WorkspaceProjection{}
		c.hub.migrations.kick()
	}
	c.hub.devices.registrationChanged(registration)
	c.replaceActiveSessions(registration.ActiveSessionIDs)
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
	c.confirmActiveSessions()

	deviceID := registration.Device.ID
	// Publish the connection and re-check the tombstone inside ONE critical
	// section. RemoveDevice commits its tombstone first and only then takes
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
	c.hub.connectionEstablished(deviceID)
	if c.hub.onEvidenceConnected != nil && registration.Workspace.ID != "" {
		c.hub.work.Go(func() {
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
		})
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
	c.hub.work.Go(func() { c.dispatchQueuedAgentSessions(registration.Workspace.ID) })
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

	connection.registrationMu.Lock()
	registrations := make([]store.DaemonRegistration, 0, len(connection.registrations))
	for _, registration := range connection.registrations {
		registrations = append(registrations, registration)
	}
	// A device with no workspace yet (one just paired) registered itself
	// alone: its device-only registration is what marks it offline, or it
	// kept reading Online after it dropped (DEV-088).
	deviceOnly := false
	if len(registrations) == 0 && connection.registration.Device.ID == deviceID {
		registrations = append(registrations, connection.registration)
		deviceOnly = connection.registration.Workspace.ID == ""
	}
	connection.registrationMu.Unlock()
	h.startDeviceReconnect(deviceID, registrations, deviceOnly)
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
