package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

const (
	wsAckType                           = "ack"
	wsErrorType                         = "error"
	wsHelloType                         = "hello"
	wsHeartbeatType                     = "heartbeat"
	wsReadFileType                      = "read_file"
	wsFileReadType                      = "file_read"
	wsReadSubagentTranscriptType        = "read_subagent_transcript"
	wsSubagentTranscriptReadType        = "subagent_transcript_read"
	wsListSubagentsType                 = "list_subagents"
	wsSubagentsListedType               = "subagents_listed"
	wsListDirectoriesType               = "list_directories"
	wsDirectoriesListedType             = "directories_listed"
	wsListWorkspaceTreeType             = "list_workspace_tree"
	wsWorkspaceTreeListedType           = "workspace_tree_listed"
	wsInspectWorkspaceType              = "inspect_workspace"
	wsInspectNativeAccountType          = "inspect_native_account"
	wsNativeAccountInspectedType        = "native_account_inspected"
	wsWorkspaceInspectedType            = "workspace_inspected"
	wsSetupWorkspaceType                = "setup_workspace"
	wsWorkspaceReadyType                = "workspace_ready"
	wsForgetWorkspaceType               = "forget_workspace"
	wsWorkspaceForgottenType            = "workspace_forgotten"
	wsUpsertAgentProfileType            = "upsert_agent_profile"
	wsAgentProfileUpsertedType          = "agent_profile_upserted"
	wsUpsertRuntimeSettingsType         = "upsert_agent_runtime_settings"
	wsRuntimeSettingsUpsertedType       = "agent_runtime_settings_upserted"
	wsListAgentModelsType               = "list_agent_models"
	wsAgentModelsListedType             = "agent_models_listed"
	wsReadProfileCredentialType         = "read_profile_credential"
	wsProfileCredentialReadType         = "profile_credential_read"
	wsScanSkillsType                    = "scan_skills"
	wsSkillsScannedType                 = "skills_scanned"
	wsReadSkillContentType              = "read_skill_content"
	wsReadSkillFileType                 = "read_skill_file"
	wsSkillFileReadType                 = "skill_file_read"
	wsSkillContentReadType              = "skill_content_read"
	wsStartProfileAuthorizationType     = "start_profile_authorization"
	wsProfileAuthorizationStartedType   = "profile_authorization_started"
	wsCompleteProfileAuthorizationType  = "complete_profile_authorization"
	wsProfileAuthorizationCompletedType = "profile_authorization_completed"
	wsRegisteredType                    = "registered"
	wsRunIssueType                      = "run_issue"
	wsRunStartedType                    = "run_started"
	wsRunEventType                      = "run_event"
	wsIssueCompletedType                = "issue_completed"
	wsIssueEnvironmentType              = "issue_environment"
	wsIssueEnvironmentResultType        = "issue_environment_result"
	wsEvidenceRequestType               = "evidence_request"
	wsEvidenceResultType                = "evidence_result"
	wsReadyForIssueType                 = "ready_for_issue"
	wsRunSessionType                    = "run_session"
	wsSteerSessionType                  = "steer_session"
	wsSessionSteeredType                = "session_steered"
	wsCancelSessionType                 = "cancel_session"
	wsSessionCanceledType               = "session_canceled"
	wsSessionStartedType                = "session_started"
	wsSessionEventType                  = "session_event"
	wsSessionBlockedType                = "session_blocked"
	wsSessionResumedType                = "session_resumed"
	wsSessionNativeSessionIDType        = "session_native_session_id"
	wsSessionCompleteType               = "session_completed"
)

type DaemonHub struct {
	onSessionCompleted  func(context.Context, store.AgentSession)
	onEvidenceConnected func(context.Context, string)
	connections         map[string]*daemonConnection
	events              *browserEventHub
	store               store.Store
	secrets             secretKeeper
	// live tracks every upgraded socket, including ones that never sent
	// hello and so never landed in connections. Shutdown needs all of them.
	live         map[*daemonConnection]struct{}
	mu           sync.Mutex
	shuttingDown bool
	upgrader     websocket.Upgrader
}

// daemonDisconnectedReason is the deterministic error surfaced to callers
// whose daemon RPC never gets an answer because the socket went away.
const daemonDisconnectedReason = "local daemon disconnected"

// closeFrameGrace bounds how long a teardown waits for the write loop to emit
// a normal close frame before the socket is dropped underneath it.
const closeFrameGrace = 250 * time.Millisecond

// wsDeviceRemovedCloseCode is the permanent close sent to a daemon whose
// device was soft-removed. 4xxx is the application-defined range; the worker
// treats this code and the "device_removed" reason as "stop reconnecting and
// wait for an explicit re-pair", never as a transient network drop.
const wsDeviceRemovedCloseCode = 4001
const wsDeviceRemovedReason = "device_removed"

type daemonConnection struct {
	claimMu        sync.Mutex
	claimCursor    int
	activeSessions map[string]bool
	activeMu       sync.Mutex
	deviceID       string
	// actor is the device credential behind the socket; every registration
	// on it must name that device.
	actor Actor
	// sessionWorkspaces caches the workspace of streamed session events.
	sessionWorkspaces   map[string]string
	sessionWorkspacesMu sync.Mutex
	done                chan struct{}
	finished            chan struct{}
	hub                 *DaemonHub
	rpc                 *daemonRPC
	registration        store.DaemonRegistration
	registrations       map[string]store.DaemonRegistration
	registrationMu      sync.Mutex
	// dispatchedSessions guards re-dispatching a session this connection was
	// already handed; it is bookkeeping, not request correlation.
	dispatchedSessions map[string]bool
	dispatchedMu       sync.Mutex
	send               chan wsEnvelope
	socket             *websocket.Conn
	closeOnce          sync.Once
	writeStarted       atomic.Bool
	writeFinished      chan struct{}
}

type wsEnvelope struct {
	Error   string          `json:"error,omitempty"`
	ID      string          `json:"id,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Type    string          `json:"type"`
}

type wsRunIssuePayload struct {
	Issue     store.Issue             `json:"issue"`
	SkillRefs []store.SessionSkillRef `json:"skillRefs,omitempty"`
	// UserFiles lets the Issue's processes read the device owner's own files
	// and credentials. Only an Issue the device owner started may; anyone
	// else's Issue must not act with the owner's credentials.
	UserFiles string `json:"userFiles"`
}

type wsRunStartedPayload struct {
	IssueID string    `json:"issueId"`
	Run     store.Run `json:"run"`
}

type wsRunEventPayload struct {
	Event store.RunEvent `json:"event"`
}

type wsIssueCompletedPayload struct {
	Canceled            bool                     `json:"canceled,omitempty"`
	Response            string                   `json:"response,omitempty"`
	EnvironmentID       string                   `json:"environmentId,omitempty"`
	EnvironmentRevision int                      `json:"environmentRevision,omitempty"`
	ExecutionCwd        string                   `json:"executionCwd,omitempty"`
	Error               string                   `json:"error,omitempty"`
	Artifact            store.AcceptanceArtifact `json:"artifact"`
	Checks              []string                 `json:"checks"`
	IssueID             string                   `json:"issueId"`
	RunID               string                   `json:"runId"`
}

type wsReadFilePayload struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
}

type wsFileReadPayload struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
	Content     string `json:"content"`
	Truncated   bool   `json:"truncated"`
	Error       string `json:"error,omitempty"`
}

type wsReadSubagentTranscriptPayload struct {
	WorkspaceID string `json:"workspaceId"`
	SessionID   string `json:"sessionId"`
	TaskID      string `json:"taskId"`
}

type wsSubagentTranscriptReadPayload struct {
	store.AgentSubagentTranscript
	Error string `json:"error,omitempty"`
}

type wsListSubagentsPayload struct {
	WorkspaceID string `json:"workspaceId"`
	SessionID   string `json:"sessionId"`
}

type wsSubagentsListedPayload struct {
	SessionID string                       `json:"sessionId"`
	Subagents []store.AgentSubagentSummary `json:"subagents"`
	Error     string                       `json:"error,omitempty"`
}

type wsListDirectoriesPayload struct {
	Path string `json:"path"`
}

type wsDirectoriesListedPayload struct {
	Path        string                          `json:"path"`
	Directories []store.WorkspaceDirectoryEntry `json:"directories"`
	Error       string                          `json:"error,omitempty"`
}

type wsListWorkspaceTreePayload struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
}

type wsWorkspaceTreeListedPayload struct {
	WorkspaceID string                     `json:"workspaceId"`
	Path        string                     `json:"path"`
	Entries     []store.WorkspaceTreeEntry `json:"entries"`
	Error       string                     `json:"error,omitempty"`
}

type wsSetupWorkspacePayload struct {
	Path string `json:"path"`
}

type wsWorkspaceReadyPayload struct {
	Registration store.DaemonRegistration `json:"registration"`
	Error        string                   `json:"error,omitempty"`
}

type wsForgetWorkspacePayload struct {
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
}

type wsWorkspaceForgottenPayload struct {
	WorkspaceID string `json:"workspaceId"`
	Error       string `json:"error,omitempty"`
}

type wsUpsertAgentProfilePayload struct {
	Profile store.CreateAgentProfileInput `json:"profile"`
}

type wsAgentProfileUpsertedPayload struct {
	Registration store.DaemonRegistration     `json:"registration"`
	Profile      store.AgentProfileProjection `json:"profile"`
	Error        string                       `json:"error,omitempty"`
}

type wsUpsertAgentRuntimeSettingsPayload struct {
	Settings store.AgentRuntimeSettings `json:"settings"`
}

type wsAgentRuntimeSettingsUpsertedPayload struct {
	Registration store.DaemonRegistration   `json:"registration"`
	Settings     store.AgentRuntimeSettings `json:"settings"`
	Error        string                     `json:"error,omitempty"`
}

type wsListAgentModelsPayload struct {
	Profile store.CreateAgentProfileInput `json:"profile"`
}

type wsAgentModelsListedPayload struct {
	Models []store.AgentModelOption `json:"models"`
	Error  string                   `json:"error,omitempty"`
}

type wsStartProfileAuthorizationPayload struct {
	ProfileID string `json:"profileId"`
	Runtime   string `json:"runtime"`
}

type wsProfileAuthorizationStartedPayload struct {
	Authorization store.ProfileAuthorization `json:"authorization"`
	Error         string                     `json:"error,omitempty"`
}

type wsCompleteProfileAuthorizationPayload struct {
	FlowID              string `json:"flowId"`
	AuthorizationResult string `json:"authorizationResult,omitempty"`
}

type wsProfileAuthorizationCompletedPayload struct {
	Authorization store.ProfileAuthorization `json:"authorization"`
	Registration  store.DaemonRegistration   `json:"registration"`
	Error         string                     `json:"error,omitempty"`
}

// wsReadProfileCredentialPayload asks the daemon for a credential that has so
// far never left the machine, so promotion can seal it server-side. The value
// comes back in wsProfileCredentialReadPayload and is never logged.
type wsReadProfileCredentialPayload struct {
	ProfileID string `json:"profileId"`
}

type wsProfileCredentialReadPayload struct {
	Credential string `json:"credential,omitempty"`
	Error      string `json:"error,omitempty"`
}

type wsRunSessionPayload struct {
	Session store.AgentSession `json:"session"`
	// Profile is the authoritative server-owned definition for sessions that
	// run a server profile. Without it the daemon falls back to its local
	// profiles file, which would silently drop baseUrl and send the credential
	// to the vendor's public endpoint.
	Profile    *store.ProfileDefinition `json:"profile,omitempty"`
	Credential string                   `json:"credential,omitempty"`
	// SessionToken is the one-time bearer token the spawned agent presents to
	// the MCP/CLI surface. Minted per dispatch (so reconnects rotate it);
	// never persisted in plaintext.
	SessionToken string `json:"sessionToken,omitempty"`
}

type wsSteerSessionPayload struct {
	Message   string `json:"message"`
	SessionID string `json:"sessionId"`
}

type wsSessionSteeredPayload struct {
	Error     string `json:"error,omitempty"`
	SessionID string `json:"sessionId"`
}

type wsCancelSessionPayload struct {
	SessionID string `json:"sessionId"`
}

type wsSessionCanceledPayload struct {
	Error     string `json:"error,omitempty"`
	SessionID string `json:"sessionId"`
}

type wsSessionStartedPayload struct {
	SessionID string `json:"sessionId"`
}

type wsSessionEventPayload struct {
	Event store.AgentSessionEvent `json:"event"`
}

type wsSessionNativeSessionIDPayload struct {
	SessionID       string `json:"sessionId"`
	NativeSessionID string `json:"nativeSessionId"`
}

type wsSessionCompletedPayload struct {
	SessionID       string `json:"sessionId"`
	NativeSessionID string `json:"nativeSessionId,omitempty"`
	Response        string `json:"response,omitempty"`
	Error           string `json:"error,omitempty"`
}

func NewDaemonHub(store store.Store, events *browserEventHub, allowedOrigin string) *DaemonHub {
	return &DaemonHub{
		connections: make(map[string]*daemonConnection),
		events:      events,
		live:        make(map[*daemonConnection]struct{}),
		store:       store,
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

func newDaemonConnection(hub *DaemonHub, socket *websocket.Conn) *daemonConnection {
	return &daemonConnection{
		activeSessions:     make(map[string]bool),
		done:               make(chan struct{}),
		dispatchedSessions: make(map[string]bool),
		finished:           make(chan struct{}),
		hub:                hub,
		registrations:      make(map[string]store.DaemonRegistration),
		rpc:                newDaemonRPC(),
		send:               make(chan wsEnvelope, 128),
		socket:             socket,
		writeFinished:      make(chan struct{}),
	}
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
		go connection.close()
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

func (h *DaemonHub) DispatchReady() {
	h.mu.Lock()
	connections := make([]*daemonConnection, 0, len(h.connections))
	for _, connection := range h.connections {
		connections = append(connections, connection)
	}
	h.mu.Unlock()

	for _, connection := range connections {
		connection.claimAndSend()
	}
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

// connectionFor returns the daemon connection for the given device ID.
// When fallback is true and deviceID is empty, it returns the first
// available connection (used by endpoints that target "the" device
// rather than a specific one). Returns nil when no connection matches.
// connectionFor finds the live connection of exactly this device. There is
// no "any connected device" fallback: with several owners that would route a
// request to someone else's machine.
func (h *DaemonHub) connectionFor(deviceID string) *daemonConnection {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.connections[deviceID]
}

func (h *DaemonHub) DispatchAgentSession(session store.AgentSession) error {
	if recoveredSession, recovered, err := h.reconcileAgentSession(context.Background(), session); err != nil {
		return err
	} else if recovered || recoveredSession.Status != "queued" {
		return nil
	} else {
		session = recoveredSession
	}
	connection := h.connectionFor(session.DeviceID)
	if connection == nil {
		return store.ErrNotFound
	}
	return connection.dispatchAgentSession(session)
}

func (h *DaemonHub) SteerAgentSession(ctx context.Context, session store.AgentSession, message string) error {
	connection := h.connectionFor(session.DeviceID)
	if connection == nil {
		return store.ErrNotFound
	}
	return connection.steerAgentSession(ctx, session.ID, message)
}

func (h *DaemonHub) CancelAgentSession(ctx context.Context, session store.AgentSession) error {
	connection := h.connectionFor(session.DeviceID)
	if connection == nil {
		return store.ErrNotFound
	}
	return connection.cancelAgentSession(ctx, session.ID)
}

func (h *DaemonHub) ReadWorkspaceFile(ctx context.Context, workspace store.WorkspaceProjection, path string) (store.WorkspaceFileRead, error) {
	connection := h.connectionFor(workspace.DeviceID)
	if connection == nil {
		return store.WorkspaceFileRead{}, store.ErrNotFound
	}
	return connection.readWorkspaceFile(ctx, workspace.ID, path)
}

func (h *DaemonHub) ReadAgentSubagentTranscript(ctx context.Context, session store.AgentSession, taskID string) (store.AgentSubagentTranscript, error) {
	connection := h.connectionFor(session.DeviceID)
	if connection == nil {
		return store.AgentSubagentTranscript{}, store.ErrNotFound
	}
	return connection.readAgentSubagentTranscript(ctx, session.WorkspaceID, session.ID, taskID)
}

func (h *DaemonHub) ListAgentSubagents(ctx context.Context, session store.AgentSession) ([]store.AgentSubagentSummary, error) {
	connection := h.connectionFor(session.DeviceID)
	if connection == nil {
		return nil, store.ErrNotFound
	}
	return connection.listAgentSubagents(ctx, session.WorkspaceID, session.ID)
}

func (h *DaemonHub) SetupWorkspace(ctx context.Context, deviceID string, path string) (store.WorkspaceProjection, error) {
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return store.WorkspaceProjection{}, store.ErrNotFound
	}
	return connection.setupWorkspace(ctx, path)
}

func (h *DaemonHub) ForgetWorkspace(ctx context.Context, workspace store.WorkspaceProjection) error {
	connection := h.connectionFor(workspace.DeviceID)
	if connection == nil {
		return store.ErrNotFound
	}
	if err := connection.forgetWorkspace(ctx, workspace.ID, workspace.LocalPath); err != nil {
		return err
	}
	connection.registrationMu.Lock()
	if connection.registration.Workspace.ID == workspace.ID {
		connection.registration.Workspace = store.WorkspaceProjection{}
	}
	delete(connection.registrations, workspace.ID)
	connection.registrationMu.Unlock()
	return nil
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

// errForeignTarget refuses a message about an issue, run or session that
// belongs to another device.
var errForeignTarget = errors.New("message targets work of another device")

// authorizeTarget keeps a device's messages to its own issues, runs and
// sessions. Only package tests produce a daemon actor without a device id.
func (c *daemonConnection) authorizeTarget(ctx context.Context, envelope wsEnvelope) error {
	deviceID := c.actor.DeviceID
	if deviceID == "" {
		return nil
	}
	var probe struct {
		IssueID   string `json:"issueId"`
		SessionID string `json:"sessionId"`
		Event     struct {
			RunID     string `json:"runId"`
			SessionID string `json:"sessionId"`
		} `json:"event"`
	}
	switch envelope.Type {
	case wsRunStartedType, wsIssueCompletedType, wsRunEventType,
		wsSessionSteeredType, wsSessionCanceledType, wsSessionStartedType, wsSessionEventType,
		wsSessionBlockedType, wsSessionResumedType, wsSessionNativeSessionIDType, wsSessionCompleteType:
	default:
		return nil
	}
	if err := json.Unmarshal(envelope.Payload, &probe); err != nil {
		return err
	}
	switch envelope.Type {
	case wsRunStartedType, wsIssueCompletedType:
		if !c.hub.issueOnDevice(ctx, probe.IssueID, deviceID) {
			return errForeignTarget
		}
	case wsRunEventType:
		if !c.hub.workspaceOnDevice(ctx, c.hub.runWorkspace(ctx, probe.Event.RunID), deviceID) {
			return errForeignTarget
		}
	default:
		sessionID := probe.SessionID
		if envelope.Type == wsSessionEventType {
			sessionID = probe.Event.SessionID
		}
		session, err := c.hub.store.GetAgentSessionSummary(ctx, sessionID)
		if err != nil || session.DeviceID != deviceID {
			return errForeignTarget
		}
	}
	return nil
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

// runWorkspace finds a run's workspace so its events reach only viewers of
// that workspace; "" (delivered to nobody) when unknown.
func (h *DaemonHub) runWorkspace(ctx context.Context, runID string) string {
	ownership, ok := h.store.(store.OwnershipStore)
	if !ok {
		return ""
	}
	workspaceID, err := ownership.RunWorkspace(ctx, runID)
	if err != nil {
		return ""
	}
	return workspaceID
}

// sessionWorkspace resolves (and remembers) the workspace of a session whose
// events stream over this connection.
func (c *daemonConnection) sessionWorkspace(ctx context.Context, sessionID string) string {
	c.sessionWorkspacesMu.Lock()
	defer c.sessionWorkspacesMu.Unlock()
	if workspaceID, ok := c.sessionWorkspaces[sessionID]; ok {
		return workspaceID
	}
	session, err := c.hub.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil {
		return ""
	}
	if c.sessionWorkspaces == nil {
		c.sessionWorkspaces = map[string]string{}
	}
	c.sessionWorkspaces[sessionID] = session.WorkspaceID
	return session.WorkspaceID
}

// closeDevice drops a device's live connection without the permanent
// removal code, e.g. after its credential was rotated by a new pairing.
func (h *DaemonHub) closeDevice(deviceID string) {
	h.mu.Lock()
	connection := h.connections[deviceID]
	h.mu.Unlock()
	if connection != nil {
		connection.close()
	}
}

func (h *DaemonHub) ListSubdirectories(ctx context.Context, deviceID string, path string) ([]store.WorkspaceDirectoryEntry, error) {
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return nil, store.ErrNotFound
	}
	return connection.listSubdirectories(ctx, path)
}

func (h *DaemonHub) ListWorkspaceTree(ctx context.Context, workspace store.WorkspaceProjection, path string) ([]store.WorkspaceTreeEntry, error) {
	connection := h.connectionFor(workspace.DeviceID)
	if connection == nil {
		return nil, store.ErrNotFound
	}
	return connection.listWorkspaceTree(ctx, workspace.ID, path)
}

func (h *DaemonHub) UpsertAgentProfile(ctx context.Context, input store.CreateAgentProfileInput) (store.AgentProfileProjection, error) {
	connection := h.connectionFor(input.DeviceID)
	if connection == nil {
		return store.AgentProfileProjection{}, store.ErrNotFound
	}
	return connection.upsertAgentProfile(ctx, input)
}

func (h *DaemonHub) ListAgentModels(ctx context.Context, input store.CreateAgentProfileInput) ([]store.AgentModelOption, error) {
	connection := h.connectionFor(input.DeviceID)
	if connection == nil {
		return nil, store.ErrNotFound
	}
	return connection.listAgentModels(ctx, input)
}

func (h *DaemonHub) StartProfileAuthorization(ctx context.Context, deviceID string, profileID string, runtime string) (store.ProfileAuthorization, error) {
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return store.ProfileAuthorization{}, store.ErrNotFound
	}
	return connection.startProfileAuthorization(ctx, profileID, runtime)
}

func (h *DaemonHub) CompleteProfileAuthorization(ctx context.Context, deviceID string, flowID string, authorizationResult string) (store.ProfileAuthorization, error) {
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return store.ProfileAuthorization{}, store.ErrNotFound
	}
	return connection.completeProfileAuthorization(ctx, flowID, authorizationResult)
}

// ReadProfileCredential asks the device that owns a local profile for its
// credential, so promotion can seal it server-side. It targets one device
// explicitly: a credential is machine-local state and no other daemon can
// answer for it.
func (h *DaemonHub) ReadProfileCredential(ctx context.Context, deviceID string, profileID string) (string, error) {
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return "", store.ErrNotFound
	}
	return connection.readProfileCredential(ctx, profileID)
}

func (h *DaemonHub) UpsertAgentRuntimeSettings(ctx context.Context, input store.UpsertAgentRuntimeSettingsInput) (store.AgentRuntimeSettings, error) {
	connection := h.connectionFor(input.DeviceID)
	if connection == nil {
		return store.AgentRuntimeSettings{}, store.ErrNotFound
	}
	return connection.upsertAgentRuntimeSettings(ctx, input.Settings)
}

func (h *DaemonHub) register(connection *daemonConnection, registration store.DaemonRegistration) error {
	return connection.syncRegistration(registration)
}

func (h *DaemonHub) syncRegistration(registration store.DaemonRegistration) error {
	if registration.Device.ID == "" {
		return errors.New("daemon registration requires device.id")
	}
	if registration.Workspace.ID == "" {
		return errors.New("daemon registration requires workspace.id")
	}
	registration.Device.Status = "connected"
	registration.Device.LastSeenLabel = "online"
	return h.store.RegisterDaemon(context.Background(), registration)
}

func (c *daemonConnection) syncRegistration(registration store.DaemonRegistration) error {
	if registration.Device.ID == "" {
		return errors.New("daemon registration requires device.id")
	}
	if !c.actor.ActsAsDevice(registration.Device.ID) {
		return errors.New("daemon registration device does not match its credential")
	}
	if registration.Workspace.ID == "" {
		return errors.New("daemon registration requires workspace.id")
	}
	registration.Device.Status = "connected"
	registration.Device.LastSeenLabel = "online"
	if err := c.hub.store.RegisterDaemon(context.Background(), registration); err != nil {
		if errors.Is(err, store.ErrDeviceRemoved) {
			// Permanent refusal: emit the application close frame so the worker
			// stops reconnecting and waits for an explicit re-pair.
			c.closePermanent(wsDeviceRemovedCloseCode, wsDeviceRemovedReason)
		}
		return err
	}
	if registration.ActiveSessionIDs != nil {
		c.replaceActiveSessions(registration.ActiveSessionIDs)
	}
	c.registrationMu.Lock()
	c.registrations[registration.Workspace.ID] = registration
	c.registration = registration
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
		previous.close()
	}
	if removedErr != nil {
		c.close()
		return removedErr
	}
	if removed {
		c.closePermanent(wsDeviceRemovedCloseCode, wsDeviceRemovedReason)
		return store.ErrDeviceRemoved
	}
	if c.hub.onEvidenceConnected != nil {
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

func (c *daemonConnection) replaceActiveSessions(sessionIDs []string) {
	active := make(map[string]bool, len(sessionIDs))
	for _, sessionID := range sessionIDs {
		if sessionID != "" {
			active[sessionID] = true
		}
	}
	c.activeMu.Lock()
	c.activeSessions = active
	c.activeMu.Unlock()
}

func (c *daemonConnection) setActiveSession(sessionID string, active bool) {
	if sessionID == "" {
		return
	}
	c.activeMu.Lock()
	if active {
		if c.activeSessions == nil {
			c.activeSessions = make(map[string]bool)
		}
		c.activeSessions[sessionID] = true
	} else {
		delete(c.activeSessions, sessionID)
	}
	c.activeMu.Unlock()
}

func (c *daemonConnection) hasActiveSession(sessionID string) bool {
	c.activeMu.Lock()
	defer c.activeMu.Unlock()
	return c.activeSessions[sessionID]
}

// registrationSnapshot is the only read path for registration/device state.
// Workspace setup responses can update this state from an HTTP goroutine while
// the WebSocket read loop continues dispatching messages.
func (c *daemonConnection) registrationSnapshot() (string, store.DaemonRegistration) {
	c.registrationMu.Lock()
	defer c.registrationMu.Unlock()
	return c.deviceID, c.registration
}

func (c *daemonConnection) dispatchQueuedAgentSessions(workspaceID string) {
	deviceID, _ := c.registrationSnapshot()
	sessions, err := c.hub.store.ListAgentSessionSummaries(context.Background(), workspaceID)
	if err != nil {
		c.queue(wsEnvelope{Type: wsErrorType, Error: err.Error()})
		return
	}
	for _, session := range sessions {
		if session.Status != "queued" || session.DeviceID != deviceID {
			continue
		}
		reconciled, recovered, err := c.hub.reconcileAgentSession(context.Background(), session)
		if err != nil {
			c.queue(wsEnvelope{Type: wsErrorType, Error: err.Error()})
			return
		}
		if recovered || reconciled.Status != "queued" {
			continue
		}
		session = reconciled
		if c.sessionDispatched(session.ID) {
			continue
		}
		if err := c.dispatchAgentSession(session); err != nil {
			c.queue(wsEnvelope{Type: wsErrorType, Error: err.Error()})
			return
		}
	}
}

// reconcileRunningAgentSessions cleans up orphaned "running" sessions when a
// daemon (re)connects. When the WebSocket drops mid-session, the daemon's SDK
// process dies but the server still marks the session as "running". On
// reconnect, reconcile each running session for this device: recover
// completed ones from artifacts, and fail stale ones (no activity for the
// stale threshold) so the UI doesn't show a forever-running session.
func (c *daemonConnection) reconcileRunningAgentSessions(workspaceID string) {
	deviceID, _ := c.registrationSnapshot()
	sessions, err := c.hub.store.ListAgentSessionSummaries(context.Background(), workspaceID)
	if err != nil {
		c.queue(wsEnvelope{Type: wsErrorType, Error: err.Error()})
		return
	}
	for _, session := range sessions {
		if session.Status != "running" && session.Status != "blocked" || session.DeviceID != deviceID {
			continue
		}
		if _, recovered, err := c.hub.reconcileAgentSession(context.Background(), session); err != nil {
			c.queue(wsEnvelope{Type: wsErrorType, Error: err.Error()})
			return
		} else if recovered {
			log.Printf("reconciled orphaned running session %s on reconnect", session.ID)
		}
	}
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
	if len(registrations) == 0 && connection.registration.Workspace.ID != "" {
		registrations = append(registrations, connection.registration)
	}
	connection.registrationMu.Unlock()
	if len(registrations) == 0 {
		return
	}
	for _, registration := range registrations {
		registration.Device.Status = "disconnected"
		registration.Device.LastSeenLabel = "offline"
		if err := h.store.RegisterDaemon(context.Background(), registration); err != nil {
			// A soft-removed device is expected to fail the offline upsert;
			// its connection was dropped on purpose, so this is not worth a
			// log line on every teardown.
			if !errors.Is(err, store.ErrDeviceRemoved) {
				log.Printf("daemon websocket offline update failed for %s: %v", deviceID, err)
			}
		}
	}
}

func (c *daemonConnection) readLoop(ctx context.Context) {
	defer func() {
		c.hub.unregister(c)
		c.hub.untrack(c)
		c.close()
		close(c.finished)
	}()

	// A compressed skill package can be 64 MiB; base64 + JSON needs up to
	// 86 MiB. Keep this bounded while allowing the documented package size.
	c.socket.SetReadLimit(96 << 20)
	_ = c.socket.SetReadDeadline(time.Now().Add(70 * time.Second))
	c.socket.SetPongHandler(func(string) error {
		return c.socket.SetReadDeadline(time.Now().Add(70 * time.Second))
	})

	for {
		messageType, message, err := c.socket.ReadMessage()
		if err != nil {
			return
		}
		if messageType != websocket.TextMessage {
			return
		}
		var envelope wsEnvelope
		if err := decodeWebSocketEnvelope(message, &envelope); err != nil {
			return
		}
		if err := validateWebSocketEnvelope(envelope); err != nil {
			return
		}
		if err := c.handleEnvelope(ctx, envelope); err != nil {
			c.queue(wsEnvelope{Type: wsErrorType, ID: envelope.ID, Error: err.Error()})
		}
	}
}

func (c *daemonConnection) writeLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		close(c.writeFinished)
		_ = c.socket.Close()
	}()

	for {
		select {
		case <-c.done:
			// Best effort normal close: close() force-drops the socket once
			// closeFrameGrace expires, so a stalled peer cannot hold teardown.
			_ = c.socket.SetWriteDeadline(time.Now().Add(closeFrameGrace))
			_ = c.socket.WriteMessage(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseGoingAway, "server shutting down"),
			)
			return
		case envelope := <-c.send:
			if err := c.socket.WriteJSON(envelope); err != nil {
				log.Printf("daemon websocket write failed type=%s id=%s connection=%p: %v", envelope.Type, envelope.ID, c, err)
				return
			}
		case <-ticker.C:
			if err := c.socket.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *daemonConnection) handleEnvelope(ctx context.Context, envelope wsEnvelope) error {
	deviceID, _ := c.registrationSnapshot()
	if deviceID == "" && envelope.Type != wsHelloType {
		return errors.New("daemon websocket requires hello before other messages")
	}
	if deviceID != "" && envelope.Type == wsHelloType {
		return errors.New("daemon websocket is already registered")
	}
	if err := c.authorizeTarget(ctx, envelope); err != nil {
		return err
	}
	switch envelope.Type {
	case wsHelloType:
		var registration store.DaemonRegistration
		if err := decodeWebSocketPayload(envelope.Payload, &registration); err != nil {
			return err
		}
		if err := c.hub.register(c, registration); err != nil {
			return err
		}
		c.queue(wsEnvelope{Type: wsRegisteredType, ID: envelope.ID})
		go c.claimAndSend()
		go c.dispatchQueuedAgentSessions(registration.Workspace.ID)
		go c.reconcileRunningAgentSessions(registration.Workspace.ID)
		return nil
	case wsHeartbeatType:
		c.queue(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		return nil
	case wsReadyForIssueType:
		c.queue(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		go c.claimAndSend()
		return nil
	case wsRunStartedType:
		var payload wsRunStartedPayload
		if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
			return err
		}
		issue, err := c.hub.store.StartIssueRun(ctx, payload.IssueID, payload.Run)
		if err == nil {
			c.hub.events.Publish("issue_updated", issue)
			c.queue(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		}
		return err
	case wsRunEventType:
		var payload wsRunEventPayload
		if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
			return err
		}
		err := c.hub.store.AppendRunEvent(ctx, payload.Event)
		if err == nil {
			c.hub.events.PublishIn(c.hub.runWorkspace(ctx, payload.Event.RunID), "issue_run_event", payload.Event)
			c.queue(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		}
		return err
	case wsIssueCompletedType:
		var payload wsIssueCompletedPayload
		if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
			return err
		}
		issue, err := c.hub.store.CompleteIssue(ctx, payload.IssueID, store.CompleteIssueInput{
			Canceled:      payload.Canceled,
			Response:      payload.Response,
			EnvironmentID: payload.EnvironmentID, EnvironmentRevision: payload.EnvironmentRevision, ExecutionCwd: payload.ExecutionCwd, Error: payload.Error,
			RunID:    payload.RunID,
			Artifact: payload.Artifact,
			Checks:   payload.Checks,
		})
		if err == nil {
			c.hub.events.Publish("issue_updated", issue)
			c.queue(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		}
		return err
	case wsFileReadType:
		return deliverDaemonResponse[wsFileReadPayload](c, envelope, nil)
	case wsIssueEnvironmentResultType:
		return deliverDaemonResponse[wsIssueEnvironmentResult](c, envelope, nil)
	case wsEvidenceResultType:
		return deliverDaemonResponse[wsEvidenceResult](c, envelope, nil)
	case wsWorkspaceInspectedType:
		return deliverDaemonResponse[wsWorkspaceInspectionResult](c, envelope, nil)
	case wsNativeAccountInspectedType:
		return deliverDaemonResponse[wsNativeAccountInspectionResult](c, envelope, nil)
	case wsSubagentTranscriptReadType:
		return deliverDaemonResponse[wsSubagentTranscriptReadPayload](c, envelope, nil)
	case wsSubagentsListedType:
		return deliverDaemonResponse[wsSubagentsListedPayload](c, envelope, nil)
	case wsDirectoriesListedType:
		return deliverDaemonResponse[wsDirectoriesListedPayload](c, envelope, nil)
	case wsWorkspaceTreeListedType:
		return deliverDaemonResponse[wsWorkspaceTreeListedPayload](c, envelope, nil)
	case wsWorkspaceReadyType:
		return deliverDaemonResponse(c, envelope, func(payload wsWorkspaceReadyPayload) error {
			if payload.Error != "" {
				return errors.New(payload.Error)
			}
			if payload.Registration.Device.ID != "" {
				if err := c.syncRegistration(payload.Registration); err != nil {
					return err
				}
				c.queue(wsEnvelope{Type: wsRegisteredType, ID: envelope.ID})
				go c.dispatchQueuedAgentSessions(payload.Registration.Workspace.ID)
				go c.claimAndSend()
			}
			return nil
		})
	case wsWorkspaceForgottenType:
		return deliverDaemonResponse[wsWorkspaceForgottenPayload](c, envelope, nil)
	case wsAgentModelsListedType:
		return deliverDaemonResponse(c, envelope, func(payload wsAgentModelsListedPayload) error {
			if payload.Error != "" {
				return errors.New(payload.Error)
			}
			return nil
		})
	case wsProfileCredentialReadType:
		return deliverDaemonResponse(c, envelope, func(payload wsProfileCredentialReadPayload) error {
			if payload.Error != "" {
				return errors.New(payload.Error)
			}
			return nil
		})
	case wsSkillsScannedType:
		return deliverDaemonResponse(c, envelope, func(payload wsSkillsScannedPayload) error {
			if payload.Error != "" {
				return errors.New(payload.Error)
			}
			return nil
		})
	case wsSkillFileReadType:
		return deliverDaemonResponse(c, envelope, func(payload wsSkillFileReadPayload) error {
			if payload.Error != "" {
				return errors.New(payload.Error)
			}
			return nil
		})
	case wsSkillContentReadType:
		return deliverDaemonResponse(c, envelope, func(payload wsSkillContentReadPayload) error {
			if payload.Error != "" {
				return errors.New(payload.Error)
			}
			return nil
		})
	case wsProfileAuthorizationStartedType:
		return deliverDaemonResponse(c, envelope, func(payload wsProfileAuthorizationStartedPayload) error {
			if payload.Error != "" {
				return errors.New(payload.Error)
			}
			return nil
		})
	case wsProfileAuthorizationCompletedType:
		return deliverDaemonResponse(c, envelope, func(payload wsProfileAuthorizationCompletedPayload) error {
			if payload.Error != "" {
				return errors.New(payload.Error)
			}
			return nil
		})
	case wsAgentProfileUpsertedType:
		return deliverDaemonResponse(c, envelope, func(payload wsAgentProfileUpsertedPayload) error {
			if payload.Error != "" {
				return errors.New(payload.Error)
			}
			if payload.Registration.Device.ID != "" {
				if err := c.syncRegistration(payload.Registration); err != nil {
					return err
				}
				go c.dispatchQueuedAgentSessions(payload.Registration.Workspace.ID)
			}
			return nil
		})
	case wsRuntimeSettingsUpsertedType:
		return deliverDaemonResponse(c, envelope, func(payload wsAgentRuntimeSettingsUpsertedPayload) error {
			if payload.Error != "" {
				return errors.New(payload.Error)
			}
			if payload.Registration.Device.ID != "" {
				if err := c.syncRegistration(payload.Registration); err != nil {
					return err
				}
				go c.dispatchQueuedAgentSessions(payload.Registration.Workspace.ID)
			}
			return nil
		})
	case wsSessionSteeredType:
		return deliverDaemonResponse(c, envelope, func(payload wsSessionSteeredPayload) error {
			if payload.Error != "" {
				return errors.New(payload.Error)
			}
			return nil
		})
	case wsSessionCanceledType:
		return deliverDaemonResponse(c, envelope, func(payload wsSessionCanceledPayload) error {
			if payload.Error != "" {
				return errors.New(payload.Error)
			}
			c.setActiveSession(payload.SessionID, false)
			return nil
		})
	case wsSessionStartedType:
		var payload wsSessionStartedPayload
		if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
			return err
		}
		existing, existingErr := c.hub.store.GetAgentSession(ctx, payload.SessionID)
		if existingErr == nil && (existing.Status == "running" || !isRecoverableAgentSessionStatus(existing.Status)) {
			c.setActiveSession(payload.SessionID, existing.Status == "running")
			c.clearDispatchedSession(payload.SessionID)
			c.queue(wsEnvelope{Type: wsAckType, ID: envelope.ID})
			return nil
		}
		session, err := c.hub.store.StartAgentSession(ctx, payload.SessionID)
		if err == nil {
			c.setActiveSession(payload.SessionID, true)
			c.clearDispatchedSession(payload.SessionID)
			c.hub.events.Publish("agent_session_started", session)
			c.queue(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		}
		return err
	case wsSessionEventType:
		var payload wsSessionEventPayload
		if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
			return err
		}
		payload.Event.At = time.Now().UTC().Format(time.RFC3339Nano)
		err := c.hub.store.AppendAgentSessionEvent(ctx, payload.Event)
		if err == nil {
			c.hub.events.PublishIn(c.sessionWorkspace(ctx, payload.Event.SessionID), "agent_session_event", payload.Event)
			c.queue(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		}
		return err
	case wsSessionBlockedType:
		var payload struct {
			SessionID string `json:"sessionId"`
			Reason    string `json:"reason"`
		}
		if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
			return err
		}
		session, err := c.hub.store.BlockAgentSession(ctx, payload.SessionID, payload.Reason)
		if err == nil {
			c.hub.events.Publish("agent_session_blocked", session)
			c.queue(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		}
		return err
	case wsSessionResumedType:
		var payload struct {
			SessionID string `json:"sessionId"`
		}
		if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
			return err
		}
		session, err := c.hub.store.ResumeAgentSession(ctx, payload.SessionID)
		if err == nil {
			c.hub.events.Publish("agent_session_resumed", session)
			c.queue(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		}
		return err
	case wsSessionNativeSessionIDType:
		var payload wsSessionNativeSessionIDPayload
		if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
			return err
		}
		session, err := c.hub.store.SetAgentSessionNativeSessionID(ctx, payload.SessionID, payload.NativeSessionID)
		if err == nil {
			c.hub.events.Publish("agent_session_native_session_id", session)
			c.queue(wsEnvelope{Type: wsAckType, ID: envelope.ID})
		}
		return err
	case wsSessionCompleteType:
		var payload wsSessionCompletedPayload
		if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
			return err
		}
		existing, existingErr := c.hub.store.GetAgentSession(ctx, payload.SessionID)
		if existingErr == nil && !isRecoverableAgentSessionStatus(existing.Status) {
			c.setActiveSession(payload.SessionID, false)
			c.clearDispatchedSession(payload.SessionID)
			c.queue(wsEnvelope{Type: wsAckType, ID: envelope.ID})
			if c.hub.onSessionCompleted != nil {
				c.hub.onSessionCompleted(ctx, existing)
			}
			return nil
		}
		var (
			session store.AgentSession
			err     error
		)
		if payload.Error != "" {
			session, err = c.hub.store.FailAgentSession(ctx, payload.SessionID, payload.Error)
		} else {
			session, err = c.hub.store.CompleteAgentSession(ctx, payload.SessionID, payload.Response, payload.NativeSessionID)
		}
		if err == nil {
			c.setActiveSession(payload.SessionID, false)
			c.clearDispatchedSession(payload.SessionID)
			c.hub.events.Publish("agent_session_completed", session)
			c.queue(wsEnvelope{Type: wsAckType, ID: envelope.ID})
			if c.hub.onSessionCompleted != nil {
				c.hub.onSessionCompleted(ctx, session)
			}
		}
		return err
	default:
		return errors.New("unknown websocket message type: " + envelope.Type)
	}
}

func (c *daemonConnection) readWorkspaceFile(ctx context.Context, workspaceID string, path string) (store.WorkspaceFileRead, error) {
	payload, err := json.Marshal(wsReadFilePayload{WorkspaceID: workspaceID, Path: path})
	if err != nil {
		return store.WorkspaceFileRead{}, err
	}
	value, err := daemonRequest[wsFileReadPayload](ctx, c, wsReadFileType, payload)
	if err != nil {
		return store.WorkspaceFileRead{}, err
	}
	if value.Error != "" {
		return store.WorkspaceFileRead{}, errors.New(value.Error)
	}
	return store.WorkspaceFileRead{
		WorkspaceID: value.WorkspaceID,
		Path:        value.Path,
		Content:     value.Content,
		Truncated:   value.Truncated,
	}, nil
}

func (c *daemonConnection) readAgentSubagentTranscript(ctx context.Context, workspaceID string, sessionID string, taskID string) (store.AgentSubagentTranscript, error) {
	payload, err := json.Marshal(wsReadSubagentTranscriptPayload{
		WorkspaceID: workspaceID,
		SessionID:   sessionID,
		TaskID:      taskID,
	})
	if err != nil {
		return store.AgentSubagentTranscript{}, err
	}
	value, err := daemonRequest[wsSubagentTranscriptReadPayload](ctx, c, wsReadSubagentTranscriptType, payload)
	if err != nil {
		return store.AgentSubagentTranscript{}, err
	}
	if value.Error != "" {
		return store.AgentSubagentTranscript{}, errors.New(value.Error)
	}
	return value.AgentSubagentTranscript, nil
}

func (c *daemonConnection) listAgentSubagents(ctx context.Context, workspaceID string, sessionID string) ([]store.AgentSubagentSummary, error) {
	payload, err := json.Marshal(wsListSubagentsPayload{
		WorkspaceID: workspaceID,
		SessionID:   sessionID,
	})
	if err != nil {
		return nil, err
	}
	value, err := daemonRequest[wsSubagentsListedPayload](ctx, c, wsListSubagentsType, payload)
	if err != nil {
		return nil, err
	}
	if value.Error != "" {
		return nil, errors.New(value.Error)
	}
	return value.Subagents, nil
}

func (c *daemonConnection) steerAgentSession(ctx context.Context, sessionID string, message string) error {
	payload, err := json.Marshal(wsSteerSessionPayload{SessionID: sessionID, Message: message})
	if err != nil {
		return err
	}
	value, err := daemonRequest[wsSessionSteeredPayload](ctx, c, wsSteerSessionType, payload)
	if err != nil {
		return err
	}
	if value.Error != "" {
		return errors.New(value.Error)
	}
	return nil
}

func (c *daemonConnection) cancelAgentSession(ctx context.Context, sessionID string) error {
	payload, err := json.Marshal(wsCancelSessionPayload{SessionID: sessionID})
	if err != nil {
		return err
	}
	value, err := daemonRequest[wsSessionCanceledPayload](ctx, c, wsCancelSessionType, payload)
	if err != nil {
		return err
	}
	if value.Error != "" {
		return errors.New(value.Error)
	}
	return nil
}

func (c *daemonConnection) listSubdirectories(ctx context.Context, path string) ([]store.WorkspaceDirectoryEntry, error) {
	payload, err := json.Marshal(wsListDirectoriesPayload{Path: path})
	if err != nil {
		return nil, err
	}
	value, err := daemonRequest[wsDirectoriesListedPayload](ctx, c, wsListDirectoriesType, payload)
	if err != nil {
		return nil, err
	}
	if value.Error != "" {
		return nil, errors.New(value.Error)
	}
	return value.Directories, nil
}

func (c *daemonConnection) listWorkspaceTree(ctx context.Context, workspaceID string, path string) ([]store.WorkspaceTreeEntry, error) {
	payload, err := json.Marshal(wsListWorkspaceTreePayload{WorkspaceID: workspaceID, Path: path})
	if err != nil {
		return nil, err
	}
	value, err := daemonRequest[wsWorkspaceTreeListedPayload](ctx, c, wsListWorkspaceTreeType, payload)
	if err != nil {
		return nil, err
	}
	if value.Error != "" {
		return nil, errors.New(value.Error)
	}
	return value.Entries, nil
}

func (c *daemonConnection) setupWorkspace(ctx context.Context, path string) (store.WorkspaceProjection, error) {
	payload, err := json.Marshal(wsSetupWorkspacePayload{Path: path})
	if err != nil {
		return store.WorkspaceProjection{}, err
	}
	value, err := daemonRequest[wsWorkspaceReadyPayload](ctx, c, wsSetupWorkspaceType, payload)
	if err != nil {
		return store.WorkspaceProjection{}, err
	}
	if value.Error != "" {
		return store.WorkspaceProjection{}, errors.New(value.Error)
	}
	registration := value.Registration
	registration.Workspace.DeviceID = registration.Device.ID
	registration.Workspace.DeviceLabel = registration.Device.Label
	if err := c.syncRegistration(registration); err != nil {
		return store.WorkspaceProjection{}, err
	}
	go c.dispatchQueuedAgentSessions(registration.Workspace.ID)
	return registration.Workspace, nil
}

func (c *daemonConnection) forgetWorkspace(ctx context.Context, workspaceID string, path string) error {
	payload, err := json.Marshal(wsForgetWorkspacePayload{
		WorkspaceID: workspaceID,
		Path:        path,
	})
	if err != nil {
		return err
	}
	value, err := daemonRequest[wsWorkspaceForgottenPayload](ctx, c, wsForgetWorkspaceType, payload)
	if err != nil {
		return err
	}
	if value.Error != "" {
		return errors.New(value.Error)
	}
	return nil
}

func (c *daemonConnection) upsertAgentProfile(ctx context.Context, input store.CreateAgentProfileInput) (store.AgentProfileProjection, error) {
	payload, err := json.Marshal(wsUpsertAgentProfilePayload{Profile: input})
	if err != nil {
		return store.AgentProfileProjection{}, err
	}
	value, err := daemonRequest[wsAgentProfileUpsertedPayload](ctx, c, wsUpsertAgentProfileType, payload)
	if err != nil {
		return store.AgentProfileProjection{}, err
	}
	if value.Error != "" {
		return store.AgentProfileProjection{}, errors.New(value.Error)
	}
	if registration := value.Registration; registration.Device.ID != "" {
		if err := c.syncRegistration(registration); err != nil {
			return store.AgentProfileProjection{}, err
		}
		go c.dispatchQueuedAgentSessions(registration.Workspace.ID)
	}
	return value.Profile, nil
}

func (c *daemonConnection) listAgentModels(ctx context.Context, input store.CreateAgentProfileInput) ([]store.AgentModelOption, error) {
	payload, err := json.Marshal(wsListAgentModelsPayload{Profile: input})
	if err != nil {
		return nil, err
	}
	value, err := daemonRequest[wsAgentModelsListedPayload](ctx, c, wsListAgentModelsType, payload)
	if err != nil {
		return nil, err
	}
	if value.Error != "" {
		return nil, errors.New(value.Error)
	}
	return value.Models, nil
}

func (c *daemonConnection) startProfileAuthorization(ctx context.Context, profileID string, runtime string) (store.ProfileAuthorization, error) {
	payload, err := json.Marshal(wsStartProfileAuthorizationPayload{ProfileID: profileID, Runtime: runtime})
	if err != nil {
		return store.ProfileAuthorization{}, err
	}
	value, err := daemonRequest[wsProfileAuthorizationStartedPayload](ctx, c, wsStartProfileAuthorizationType, payload)
	if err != nil {
		return store.ProfileAuthorization{}, err
	}
	if value.Error != "" {
		return store.ProfileAuthorization{}, errors.New(value.Error)
	}
	return value.Authorization, nil
}

func (c *daemonConnection) completeProfileAuthorization(ctx context.Context, flowID string, authorizationResult string) (store.ProfileAuthorization, error) {
	payload, err := json.Marshal(wsCompleteProfileAuthorizationPayload{FlowID: flowID, AuthorizationResult: authorizationResult})
	if err != nil {
		return store.ProfileAuthorization{}, err
	}
	value, err := daemonRequest[wsProfileAuthorizationCompletedPayload](ctx, c, wsCompleteProfileAuthorizationType, payload)
	if err != nil {
		return store.ProfileAuthorization{}, err
	}
	if value.Error != "" {
		return store.ProfileAuthorization{}, errors.New(value.Error)
	}
	if value.Registration.Device.ID != "" {
		if err := c.syncRegistration(value.Registration); err != nil {
			return store.ProfileAuthorization{}, err
		}
	}
	return value.Authorization, nil
}

// readProfileCredential round-trips one credential the daemon holds locally.
// The value is returned to the caller for sealing and never logged, echoed in
// an error, or persisted anywhere but the secret store.
func (c *daemonConnection) readProfileCredential(ctx context.Context, profileID string) (string, error) {
	payload, err := json.Marshal(wsReadProfileCredentialPayload{ProfileID: profileID})
	if err != nil {
		return "", err
	}
	value, err := daemonRequest[wsProfileCredentialReadPayload](ctx, c, wsReadProfileCredentialType, payload)
	if err != nil {
		return "", err
	}
	if value.Error != "" {
		return "", errors.New(value.Error)
	}
	return value.Credential, nil
}

func (c *daemonConnection) upsertAgentRuntimeSettings(ctx context.Context, settings store.AgentRuntimeSettings) (store.AgentRuntimeSettings, error) {
	payload, err := json.Marshal(wsUpsertAgentRuntimeSettingsPayload{Settings: settings})
	if err != nil {
		return store.AgentRuntimeSettings{}, err
	}
	value, err := daemonRequest[wsAgentRuntimeSettingsUpsertedPayload](ctx, c, wsUpsertRuntimeSettingsType, payload)
	if err != nil {
		return store.AgentRuntimeSettings{}, err
	}
	if value.Error != "" {
		return store.AgentRuntimeSettings{}, errors.New(value.Error)
	}
	if value.Registration.Device.ID != "" {
		if err := c.syncRegistration(value.Registration); err != nil {
			return store.AgentRuntimeSettings{}, err
		}
		go c.dispatchQueuedAgentSessions(value.Registration.Workspace.ID)
	}
	return value.Settings, nil
}

func (c *daemonConnection) dispatchAgentSession(session store.AgentSession) error {
	ctx := context.Background()
	profile, err := c.hub.serverProfileForSession(ctx, session)
	if err != nil {
		return fmt.Errorf("resolve server profile: %w", err)
	}
	var credential string
	if profile != nil {
		credential, err = c.hub.serverProfileCredential(ctx, profile.ID)
	} else {
		credential, err = c.hub.dispatchCredential(ctx, session)
	}
	if err != nil {
		return fmt.Errorf("resolve server credential: %w", err)
	}
	// Resolve the workspace's skill selection to current latest revisions. An
	// empty slice is authoritative: the runtime exposes no skills at all.
	if refs, err := c.hub.store.ResolveSessionSkills(ctx, session.WorkspaceID); err != nil {
		return fmt.Errorf("resolve workspace skills: %w", err)
	} else {
		session.SkillRefs = refs
	}
	// Mint the session-scoped MCP token per dispatch. Failure does not block a
	// chat run (the web UI needs no token); the agent-facing surface simply
	// stays unavailable for this process until the next dispatch.
	sessionToken, tokenErr := c.hub.store.MintAgentSessionToken(ctx, session.ID)
	if tokenErr != nil {
		log.Printf("mint session token for %s: %v", session.ID, tokenErr)
		sessionToken = ""
	}
	payload, err := json.Marshal(wsRunSessionPayload{Session: session, Profile: profile, Credential: credential, SessionToken: sessionToken})
	if err != nil {
		return err
	}
	c.dispatchedMu.Lock()
	c.dispatchedSessions[session.ID] = true
	c.dispatchedMu.Unlock()
	if !c.queue(wsEnvelope{Type: wsRunSessionType, Payload: payload}) {
		c.clearDispatchedSession(session.ID)
		return store.ErrNotFound
	}
	return nil
}

func (c *daemonConnection) sessionDispatched(sessionID string) bool {
	c.dispatchedMu.Lock()
	defer c.dispatchedMu.Unlock()
	return c.dispatchedSessions[sessionID]
}

func (c *daemonConnection) clearDispatchedSession(sessionID string) {
	c.dispatchedMu.Lock()
	delete(c.dispatchedSessions, sessionID)
	c.dispatchedMu.Unlock()
}

func (c *daemonConnection) claimAndSend() {
	c.claimMu.Lock()
	defer c.claimMu.Unlock()
	deviceID, registration := c.registrationSnapshot()
	if deviceID == "" || registration.Workspace.ID == "" {
		return
	}
	c.registrationMu.Lock()
	ids := make([]string, 0, len(c.registrations))
	for id := range c.registrations {
		ids = append(ids, id)
	}
	c.registrationMu.Unlock()
	if len(ids) == 0 {
		ids = append(ids, registration.Workspace.ID)
	}
	sort.Strings(ids)
	capacity := 4
	if registration.Device.RuntimeSettings != nil && registration.Device.RuntimeSettings.MaxConcurrentTasks > 0 {
		capacity = registration.Device.RuntimeSettings.MaxConcurrentTasks
	}
	producing := 0
	for _, id := range ids {
		issues, err := c.hub.store.ListIssues(context.Background(), id)
		if err != nil {
			return
		}
		for _, issue := range issues {
			if issue.Status == "in_progress" {
				producing++
			}
		}
	}
	if producing >= capacity {
		return
	}
	var issue store.Issue
	var err error
	for offset := 0; offset < len(ids); offset++ {
		index := (c.claimCursor + offset) % len(ids)
		issue, err = c.hub.store.ClaimNextIssue(context.Background(), deviceID, ids[index])
		if !errors.Is(err, store.ErrNotFound) {
			c.claimCursor = (index + 1) % len(ids)
			break
		}
	}
	if errors.Is(err, store.ErrNotFound) {
		return
	}
	if err != nil {
		c.queue(wsEnvelope{Type: wsErrorType, Error: err.Error()})
		return
	}
	// Resolve the owning workspace's skill selection so Issues enforce the
	// same allowlist as Chats. An empty list means none are exposed.
	skillRefs := []store.SessionSkillRef{}
	if issue.WorkspaceID != "" {
		resolved, err := c.hub.store.ResolveSessionSkills(context.Background(), issue.WorkspaceID)
		if err != nil {
			c.queue(wsEnvelope{Type: wsErrorType, Error: err.Error()})
			return
		}
		skillRefs = resolved
	}
	payload, err := json.Marshal(wsRunIssuePayload{Issue: issue, SkillRefs: skillRefs, UserFiles: issueUserFiles(issue, c.actor)})
	if err != nil {
		c.queue(wsEnvelope{Type: wsErrorType, Error: err.Error()})
		return
	}
	if !c.queue(wsEnvelope{Type: wsRunIssueType, Payload: payload}) {
		_, _ = c.hub.store.UpdateIssueStatus(context.Background(), issue.ID, "pending")
	}
}

func (c *daemonConnection) queue(envelope wsEnvelope) bool {
	select {
	case <-c.done:
		// A caller can register its pending result between close() and this
		// send; sweep again so it fails fast instead of waiting on ctx.
		c.failAllPending()
		return false
	default:
	}

	// c.send is deliberately never closed: queue and close race by design, and
	// closing it would turn that race into a send-on-closed-channel panic.
	select {
	case <-c.done:
		c.failAllPending()
		return false
	case c.send <- envelope:
		return true
	default:
		// Backpressure on server-to-daemon traffic must not tear down a live
		// agent session. Callers can retry request/response RPC, while ACKs are
		// advisory and session events remain durable in the store.
		return false
	}
}

func (c *daemonConnection) close() {
	c.closeOnce.Do(func() {
		c.failAllPending()
		close(c.done)
		if c.writeStarted.Load() {
			// Let writeLoop emit a close frame before the socket disappears.
			timer := time.NewTimer(closeFrameGrace)
			select {
			case <-c.writeFinished:
			case <-timer.C:
			}
			timer.Stop()
		}
		if c.socket != nil {
			_ = c.socket.Close()
		}
	})
}

// closePermanent sends an application-defined close frame (used for the
// device_removed refusal) and then runs the ordinary teardown. The control
// message is written directly: the shutdown frame baked into writeLoop always
// carries "server shutting down", which the worker would treat as transient.
func (c *daemonConnection) closePermanent(code int, text string) {
	if c.socket != nil {
		deadline := time.Now().Add(closeFrameGrace)
		_ = c.socket.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(code, text),
			deadline,
		)
	}
	c.close()
}

// closeRemoved detaches the connection from the device lookup and sends the
// permanent device_removed close frame so the worker stops reconnecting.
func (c *daemonConnection) closeRemoved() {
	deviceID, _ := c.registrationSnapshot()
	if deviceID != "" {
		c.hub.mu.Lock()
		if c.hub.connections[deviceID] == c {
			delete(c.hub.connections, deviceID)
		}
		c.hub.mu.Unlock()
	}
	c.closePermanent(wsDeviceRemovedCloseCode, wsDeviceRemovedReason)
}

// failAllPending resolves every waiting daemon RPC with the disconnect error
// and latches the registry closed, so late registrations resolve too.
func (c *daemonConnection) failAllPending() {
	c.rpc.failAll()
}

// issueUserFiles decides whether an Issue may use the device owner's own
// files and credentials: only when the device owner started it.
func issueUserFiles(issue store.Issue, device Actor) string {
	if owner := device.AccountID(); owner != "" && issue.CreatedByUserID == owner {
		return "readable"
	}
	return "hidden"
}
