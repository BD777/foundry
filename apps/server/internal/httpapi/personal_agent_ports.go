package httpapi

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/run"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The personal agent's ports (personalagent/run, knowledge, assistant)
// over the server: the accounts a workspace offers, its devices, the
// workspace lifecycle, Feishu and the session service.

// runAccounts is run.Accounts over the workspaces' accounts
// (session_accounts.go).
type runAccounts struct{ s *Server }

func (a runAccounts) WorkspaceAccounts(ctx context.Context, workspace store.WorkspaceProjection, userID string) ([]run.Account, error) {
	accounts, err := a.s.workspaceAccounts(ctx, workspace, userID)
	if err != nil {
		return nil, err
	}
	out := make([]run.Account, len(accounts))
	for i, account := range accounts {
		out[i] = runAccount(account)
	}
	return out, nil
}

func (runAccounts) Pick(accounts []run.Account, runtime, preferred string) (run.Account, bool) {
	listed := make([]workspaceAccount, len(accounts))
	for i, account := range accounts {
		listed[i] = workspaceAccount{
			ProfileID: account.ProfileID, Name: account.Name, Runtime: account.Runtime, Kind: account.Kind, Usable: account.Usable,
			Problem: account.Problem, Detail: account.Detail, LastWorkedAt: account.LastWorkedAt, agent: account.Agent,
		}
	}
	picked, ok := pickAccount(listed, runtime, preferred)
	return runAccount(picked), ok
}

func runAccount(account workspaceAccount) run.Account {
	return run.Account{
		ProfileID: account.ProfileID, Name: account.Name, Runtime: account.Runtime, Kind: account.Kind, Usable: account.Usable,
		Problem: account.Problem, Detail: account.Detail, LastWorkedAt: account.LastWorkedAt, Agent: account.agent,
	}
}

// knowledgeDevices is knowledge.Devices over the device hub.
type knowledgeDevices struct{ s *Server }

func (d knowledgeDevices) KnowledgeCommand(ctx context.Context, workspace store.WorkspaceProjection, command store.KnowledgeCommand) (store.KnowledgeReply, error) {
	return d.s.hub.knowledgeCommand(ctx, workspace, command)
}

// paWorkspaces is personalagent.Workspaces over the workspace lifecycle
// (workspace_lifecycle.go) the REST routes call; tests replace it through
// lifecycleFor.
type paWorkspaces struct{ s *Server }

func workspaceActor(actor personalagent.WorkspaceActor) WorkspaceActor {
	return WorkspaceActor{UserID: actor.UserID, SessionID: actor.SessionID}
}

func (p paWorkspaces) CreateWorkspace(ctx context.Context, actor personalagent.WorkspaceActor, request personalagent.NewWorkspace) (store.WorkspaceProjection, error) {
	create := WorkspaceCreateRequest{
		DeviceID: request.DeviceID, Path: request.Path, FolderName: request.FolderName,
		Name: request.Name, Purpose: request.Purpose, Kind: request.Kind,
	}
	if source := request.Create; source != nil {
		create.Create = &WorkspaceCreateSource{Kind: source.Kind, URL: source.URL, GitInit: source.GitInit}
		for _, file := range source.Files {
			create.Create.Files = append(create.Create.Files, WorkspaceFile{Path: file.Path, Content: file.Content})
		}
	}
	return lifecycleFor(p.s).CreateWorkspace(ctx, workspaceActor(actor), create)
}

func (p paWorkspaces) UpdateWorkspaceDetails(ctx context.Context, actor personalagent.WorkspaceActor, workspaceID string, details personalagent.WorkspaceDetails) (store.WorkspaceProjection, error) {
	return lifecycleFor(p.s).UpdateWorkspaceDetails(ctx, workspaceActor(actor), workspaceID, WorkspaceDetails{Name: details.Name, Purpose: details.Purpose})
}

func (p paWorkspaces) ChangeWorkspaceSkills(ctx context.Context, actor personalagent.WorkspaceActor, workspaceID string, add, remove []string) ([]store.WorkspaceSkillBinding, error) {
	return lifecycleFor(p.s).ChangeWorkspaceSkills(ctx, workspaceActor(actor), workspaceID, add, remove)
}

func (p paWorkspaces) ChangeWorkspaceConnectors(ctx context.Context, actor personalagent.WorkspaceActor, workspaceID string, add, remove []string) (store.WorkspaceExternalAccounts, error) {
	return lifecycleFor(p.s).ChangeWorkspaceConnectors(ctx, workspaceActor(actor), workspaceID, add, remove)
}

func (p paWorkspaces) ArchiveWorkspace(ctx context.Context, actor personalagent.WorkspaceActor, workspaceID string) (store.WorkspaceProjection, error) {
	return lifecycleFor(p.s).ArchiveWorkspace(ctx, workspaceActor(actor), workspaceID)
}

func (p paWorkspaces) RestoreWorkspace(ctx context.Context, actor personalagent.WorkspaceActor, workspaceID string) (store.WorkspaceProjection, error) {
	return lifecycleFor(p.s).RestoreWorkspace(ctx, workspaceActor(actor), workspaceID)
}

func (p paWorkspaces) NewFolderPath(deviceID, folder string) (string, bool, error) {
	connection := p.s.hub.connectionFor(deviceID)
	if connection == nil {
		return "", false, nil
	}
	_, registration := connection.registrationSnapshot()
	path, err := managedWorkspacePath(registration.Device.ManagedRoots, "", folder)
	return path, true, err
}

// assistantDevices is assistant.Devices over the device hub and what the
// server knows of devices.
type assistantDevices struct{ s *Server }

func (d assistantDevices) Connected(deviceID string) bool { return d.s.hub.HasConnection(deviceID) }

func (d assistantDevices) Connection(deviceID string) assistant.Connection {
	if connection := d.s.hub.connectionFor(deviceID); connection != nil {
		return deviceConnectionCapabilities{connection}
	}
	return nil
}

// deviceConnectionCapabilities is assistant.Connection over a hub connection.
type deviceConnectionCapabilities struct{ connection *daemonConnection }

func (c deviceConnectionCapabilities) HasCapability(capability string) bool {
	return c.connection.hasCapability(capability)
}

func (d assistantDevices) Label(ctx context.Context, deviceID string) string {
	return d.s.deviceLabel(ctx, deviceID)
}

func (d assistantDevices) Labels(ctx context.Context) map[string]string { return d.s.deviceLabels(ctx) }

func (d assistantDevices) SharedAccounts(ctx context.Context) map[string][]string {
	return d.s.sharedAccountDevices(ctx)
}

func (d assistantDevices) Placements(ctx context.Context, devices []store.DeviceProjection, now time.Time) (map[string]store.DevicePlacement, error) {
	return d.s.devicePlacements(ctx, devices, now)
}

// ManagedRootFolders names the folders in the device's first managed root;
// none while it is offline or the root does not exist yet.
func (d assistantDevices) ManagedRootFolders(ctx context.Context, deviceID string) []string {
	connection := d.s.hub.connectionFor(deviceID)
	if connection == nil {
		return nil
	}
	_, registration := connection.registrationSnapshot()
	if len(registration.Device.ManagedRoots) == 0 {
		return nil
	}
	listCtx, cancel := context.WithTimeout(ctx, deviceFileRequestTimeout)
	defer cancel()
	entries, err := d.s.hub.ListSubdirectories(listCtx, deviceID, registration.Device.ManagedRoots[0])
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, cmp.Or(entry.Name, store.LastDevicePathElement(entry.Path)))
	}
	return names
}

func (d assistantDevices) ReadWorkspaceFile(ctx context.Context, workspace store.WorkspaceProjection, path string) (store.WorkspaceFileRead, error) {
	return d.s.hub.ReadWorkspaceFile(ctx, workspace, path)
}

func (d assistantDevices) ListWorkspaceTree(ctx context.Context, workspace store.WorkspaceProjection, path string) ([]store.WorkspaceTreeEntry, error) {
	return d.s.hub.ListWorkspaceTree(ctx, workspace, path)
}

// WorkspaceGit is the git state of the workspace as its device inspects it
// without a rescan.
func (d assistantDevices) WorkspaceGit(ctx context.Context, workspace store.WorkspaceProjection) (json.RawMessage, bool) {
	connection := d.s.hub.connectionFor(workspace.DeviceID)
	if connection == nil {
		return nil, false
	}
	inspectCtx, cancel := context.WithTimeout(ctx, sessions.ControlTimeout)
	defer cancel()
	payload, _ := json.Marshal(map[string]any{"workspaceId": workspace.ID, "rescan": false})
	if result, err := daemonRequest[wsWorkspaceInspectionResult](inspectCtx, connection, wsInspectWorkspaceType, payload); err == nil && result.Error == "" {
		var inspection map[string]json.RawMessage
		if json.Unmarshal(result.Inspection, &inspection) == nil && inspection["git"] != nil {
			return inspection["git"], true
		}
	}
	return nil, false
}

func (d assistantDevices) ContextPatch(ctx context.Context, workspace store.WorkspaceProjection, command store.ContextPatchCommand) (store.ContextPatchReply, error) {
	return d.s.hub.contextPatch(ctx, workspace, command)
}

func (d assistantDevices) CancelExactInput(ctx context.Context, session store.AgentSession) (string, bool, error) {
	receipt, err := d.s.hub.cancelExactAssistantInput(ctx, session)
	return receipt.InputID, receipt.Stopped, err
}

func (d assistantDevices) AwayFor(deviceID string, now time.Time) (time.Duration, string, bool) {
	return d.s.hub.awayFor(deviceID, now)
}

func (d assistantDevices) InputTokens(ctx context.Context, session store.AgentSession) (int64, bool, error) {
	return d.s.observeAssistantInputTokens(ctx, session)
}

// awayFor is how long the computer was away before its current connection,
// from its last drop as the server saw it or, later, as its worker
// reported it; ok is false when no drop is known. The drop's id tells one
// absence from another.
func (h *DaemonHub) awayFor(deviceID string, now time.Time) (away time.Duration, dropID string, ok bool) {
	entry, known := h.disconnects.lookup(deviceID)
	if !known {
		return 0, "", false
	}
	dropped, parsed := parsePATime(entry.At)
	if entry.Worker != nil {
		if closed, ok := parsePATime(entry.Worker.ClosedAt); ok && (!parsed || closed.After(dropped)) {
			dropped, parsed = closed, true
		}
	}
	if !parsed {
		return 0, "", false
	}
	return now.Sub(dropped), dropped.UTC().Format(time.RFC3339Nano), true
}

type wsContextPatchReply struct{ store.ContextPatchReply }

func (p wsContextPatchReply) refusal() error {
	if p.Error != "" {
		return fmt.Errorf("%s: %s", p.Code, p.Error)
	}
	return nil
}

func (h *DaemonHub) contextPatch(ctx context.Context, w store.WorkspaceProjection, cmd store.ContextPatchCommand) (store.ContextPatchReply, error) {
	c := h.connectionFor(w.DeviceID)
	if c == nil {
		return store.ContextPatchReply{}, fmt.Errorf("device_offline")
	}
	reply, err := callDevice[wsContextPatchReply](ctx, c, wsContextPatchType, cmd)
	return reply.ContextPatchReply, err
}

// Native logs include cache tokens in InputTokens. This is an observed main
// runtime budget, not a provider billing cap: reporting and in-flight requests
// may overshoot it. The device-local time ceiling remains effective offline.
func (s *Server) observeAssistantInputTokens(ctx context.Context, session store.AgentSession) (int64, bool, error) {
	connection := s.hub.connectionFor(session.DeviceID)
	if connection == nil || session.NativeSessionID == "" {
		return 0, false, nil
	}
	usage, err := connection.readSessionUsage(ctx, session.Provider, []string{session.NativeSessionID})
	if err != nil {
		return 0, false, err
	}
	start, err := time.Parse(time.RFC3339Nano, session.Input.At)
	if err != nil {
		return 0, false, err
	}
	var latest *nativeTurnUsage
	for _, turn := range usage.Turns {
		at := parseEventTime(turn.StartedAt)
		ended := parseEventTime(turn.EndedAt)
		if at.Before(start.Add(-usageTolerance)) || ended.Before(start) {
			continue
		}
		if latest == nil || at.After(parseEventTime(latest.StartedAt)) {
			copy := turn
			latest = &copy
		}
	}
	if latest == nil {
		return 0, false, nil
	}
	if latest.InputTokens < 0 || latest.OutputTokens < 0 {
		return 0, false, fmt.Errorf("native usage was invalid")
	}
	return latest.InputTokens + latest.OutputTokens, true, nil
}

func parsePATime(value string) (time.Time, bool) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return parsed, err == nil
}

// assistantChannel is assistant.Channel over the Feishu bots.
type assistantChannel struct{ s *Server }

func (c assistantChannel) PersonalAgentProposalCreated(proposal store.PersonalAgentProposal) {
	c.s.feishu.PersonalAgentProposalCreated(proposal)
}

func (c assistantChannel) PersonalAgentProposalChanged(proposal store.PersonalAgentProposal) {
	c.s.feishu.PersonalAgentProposalChanged(proposal)
}

func (c assistantChannel) PrepareAssistantInbox(ctx context.Context, entry store.PersonalAgentInboxEntry, workspaceID string) (string, []store.ChatAttachment, error) {
	return c.s.feishu.PrepareAssistantInbox(ctx, entry, workspaceID)
}

func (c assistantChannel) FollowAssistantInbox(ctx context.Context, entry store.PersonalAgentInboxEntry, workspaceID, sessionID string) error {
	return c.s.feishu.FollowAssistantInbox(ctx, entry, workspaceID, sessionID)
}

func (c assistantChannel) DeliverAssistantInboxResult(ctx context.Context, entry store.PersonalAgentInboxEntry, workspaceID, sessionURL string) error {
	return c.s.feishu.DeliverAssistantInboxResult(ctx, entry, workspaceID, sessionURL)
}

// assistantAccounts is assistant.Accounts: runAccounts and the tools'
// answer of them.
type assistantAccounts struct{ runAccounts }

func (a assistantAccounts) Answer(ctx context.Context, workspace store.WorkspaceProjection, userID string) map[string]any {
	return a.s.accountsAnswer(ctx, workspace, userID)
}

// assistantDigests is assistant.Digests over the workspace digests
// (workspace_digests.go).
type assistantDigests struct{ s *Server }

func (d assistantDigests) Sync(ctx context.Context, userID string) ([]store.WorkspaceDigestRecord, error) {
	return d.s.workspaceDigests().Sync(ctx, userID)
}

func (d assistantDigests) Devices(ctx context.Context, userID string) ([]store.DeviceDigest, error) {
	return d.s.workspaceDigests().Devices(ctx, userID)
}

func (d assistantDigests) Digest(ctx context.Context, userID, workspaceID string) (store.WorkspaceDigest, error) {
	return d.s.workspaceDigests().Digest(ctx, userID, workspaceID)
}

func (d assistantDigests) Refresh(ctx context.Context, workspaceID string) {
	d.s.refreshWorkspaceDigests(ctx, workspaceID)
}

func (d assistantDigests) Prime(ctx context.Context, userID string) {
	d.s.primeAssistantDigests(ctx, userID)
}

// assistantServer is assistant.Server: the access rules, verifier
// sandboxes, built-in skills and the workspace viewers.
type assistantServer struct{ s *Server }

func (a assistantServer) CanReadSession(ctx context.Context, user store.User, session store.AgentSession) bool {
	return a.s.canReadSession(ctx, Actor{Kind: ActorAccount, Account: &user}, session)
}

func (a assistantServer) CanControlSession(ctx context.Context, user store.User, session store.AgentSession) bool {
	return a.s.canControlSession(ctx, Actor{Kind: ActorAccount, Account: &user}, session)
}

func (a assistantServer) RequireVerifierDevice(ctx context.Context, input store.CreateAgentSessionInput) error {
	return a.s.requireVerifierDevice(ctx, input)
}

func (assistantServer) BuiltinSkills() []string {
	names := []string{}
	for _, skill := range builtinSkillProjections() {
		names = append(names, skill.Name)
	}
	return names
}

func (a assistantServer) WorkspacesChanged() { a.s.projectionsChanged("", fieldWorkspaces) }

// newAssistant is the server's personal agent at work, over the ports
// above; its tasks' sessions are told to events.
func newAssistant(s *Server, events sessions.ChangeNotifier) *assistant.Service {
	return assistant.New(s.store, events, assistant.Ports{
		Sessions: s.sessionService, Devices: assistantDevices{s}, Channel: assistantChannel{s},
		Workspaces: paWorkspaces{s}, Accounts: assistantAccounts{runAccounts{s}}, Digests: assistantDigests{s},
		Server: assistantServer{s}, Runs: s.runs, Knowledge: s.knowledge, ArchiveSessions: s.planArchiveSession,
		Origin: s.options.AllowedOrigin, FileTimeout: deviceFileRequestTimeout,
	})
}
