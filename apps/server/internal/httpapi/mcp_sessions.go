package httpapi

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Sessions as the Foundry tools name and list them: a tool that acts on a
// session finds it like inspection does (an id, a link, or a native chat a
// session took over), and lists show each session in one line.

// sessionTarget is the Foundry session a tool names. A session the caller
// cannot read answers not found, like a missing one, so reach is not
// disclosed; a device's native chat can only be read.
func (s *Server) sessionTarget(ctx context.Context, actor Actor, raw, verb string) (store.AgentSession, error) {
	target, err := s.resolveInspectTarget(ctx, actor, raw, false)
	if err != nil {
		return store.AgentSession{}, err
	}
	if target.session == nil {
		return store.AgentSession{}, &statusError{http.StatusBadRequest, errors.New(target.chat.ID + " is a native chat on its device, not a Foundry session: read it with read_context; Foundry cannot " + verb + " it")}
	}
	return *target.session, nil
}

// controlledSession is a session the caller may also steer, cancel and
// rename. One it reads but may not control says why.
func (s *Server) controlledSession(ctx context.Context, actor Actor, raw, verb string) (store.AgentSession, error) {
	session, err := s.sessionTarget(ctx, actor, raw, verb)
	if err != nil {
		return store.AgentSession{}, err
	}
	if !s.canControlSession(ctx, actor, session) {
		return store.AgentSession{}, &statusError{http.StatusForbidden, fmt.Errorf("cannot %s %s: %s", verb, session.ID, s.controlRefusal(ctx, actor, session))}
	}
	return session, nil
}

// controlRefusal explains why canControlSession refused a readable session.
func (s *Server) controlRefusal(ctx context.Context, actor Actor, target store.AgentSession) string {
	scope, err := s.contextScope(ctx, actor)
	switch {
	case err != nil:
		return "its access could not be resolved"
	case actor.Agent() && scope.issueID != "" && target.IssueID != scope.issueID:
		return "a session working in an Issue controls only that Issue's sessions"
	case !scope.can(target.WorkspaceID, store.WorkspaceRoleMember):
		return "you reach its workspace as " + roleLabel(scope.role(target.WorkspaceID)) + ", and controlling a session needs Member"
	case actor.Agent():
		return "an agent controls only the sessions its person started, and those their agents started"
	default:
		return "a Member controls the sessions they started; a Maintainer controls any"
	}
}

// mcpSessionItem is one session in a list: what tells sessions apart and
// where they run. read_context reads the rest.
type mcpSessionItem struct {
	ID              string `json:"id"`
	Kind            string `json:"kind,omitempty"`
	Title           string `json:"title"`
	Status          string `json:"status"`
	Runtime         string `json:"runtime,omitempty"`
	Profile         string `json:"profile,omitempty"`
	ProfileID       string `json:"profileId,omitempty"`
	Device          string `json:"device,omitempty"`
	DeviceID        string `json:"deviceId,omitempty"`
	WorkspaceID     string `json:"workspaceId"`
	ParentSessionID string `json:"parentSessionId,omitempty"`
	IssueID         string `json:"issueId,omitempty"`
	Role            string `json:"role,omitempty"`
	Source          string `json:"source,omitempty"`
	ActivityAt      string `json:"activityAt,omitempty"`
}

func (s *Server) deviceLabels(ctx context.Context) map[string]string {
	labels := map[string]string{}
	if devices, err := s.store.ListDevices(ctx); err == nil {
		for _, device := range devices {
			labels[device.ID] = device.Label
		}
	}
	return labels
}

func sessionListItem(item store.SessionListItem, devices map[string]string) mcpSessionItem {
	source := item.Source
	if source == "chat" {
		source = ""
	}
	return mcpSessionItem{
		ID: item.ID, Title: item.Title, Status: item.Status,
		Runtime: item.Provider, Profile: item.ProfileLabel, ProfileID: item.ProfileID,
		Device: devices[item.DeviceID], DeviceID: item.DeviceID, WorkspaceID: item.WorkspaceID,
		ParentSessionID: item.ParentSessionID, IssueID: item.IssueID, Role: item.Role, Source: source,
		ActivityAt: item.ActivityAt,
	}
}

func (s *Server) listSessionsForMCP(call mcpCall) (string, error) {
	ctx, actor, args := call.r.Context(), call.actor, call.args
	query := store.SessionListQuery{
		WorkspaceID: call.workspace,
		Cursor:      mcpArgString(args, "cursor"),
		Limit:       mcpArgNumber(args, "limit", 0),
	}
	if mcpArgBool(args, "parentOnly") {
		if !actor.Agent() {
			return "", &statusError{http.StatusBadRequest, errors.New("parentOnly lists the sessions the calling session created: it needs a session token")}
		}
		query.ParentSessionID = actor.Identity.SessionID
	}
	if raw := mcpArgString(args, "parentSessionId"); raw != "" {
		// A session's children are listed in its own workspace unless the
		// caller names another (a child started elsewhere lives there).
		parent, err := s.sessionTarget(ctx, actor, raw, "list the sessions of")
		if err != nil {
			return "", err
		}
		query.ParentSessionID = parent.ID
		if mcpArgString(args, "workspaceId") == "" {
			query.WorkspaceID = parent.WorkspaceID
		}
	}
	page, err := s.store.ListSessionPage(ctx, query)
	if errors.Is(err, store.ErrSessionListCursor) {
		return "", &statusError{http.StatusBadRequest, errors.New("unknown cursor: pass the nextCursor a previous list_sessions call returned")}
	}
	if err != nil {
		return "", err
	}
	devices := s.deviceLabels(ctx)
	items := make([]mcpSessionItem, len(page.Sessions))
	for index, item := range page.Sessions {
		items[index] = sessionListItem(item, devices)
	}
	fields := []string{`"sessions": ` + encodeLines(items)}
	if page.NextCursor != "" {
		cursor, _ := json.Marshal(page.NextCursor)
		fields = append(fields, `"nextCursor": `+string(cursor))
	}
	return "{\n  " + strings.Join(fields, ",\n  ") + "\n}", nil
}

// listGroupSessionsForMCP lists a group's chats in list order: sessions in
// the list form, a device's native chats beside them.
func (s *Server) listGroupSessionsForMCP(call mcpCall) (string, error) {
	ctx, workspace, groupID := call.r.Context(), call.workspace, mcpArgString(call.args, "groupId")
	if groupID == "" {
		return "", &statusError{http.StatusBadRequest, errors.New("groupId is required: read_context's summary names a session's group")}
	}
	layout, err := s.store.GetChatLayout(ctx, workspace)
	if err != nil {
		return "", err
	}
	var group *store.ChatLayoutGroup
	for index := range layout.Groups {
		if layout.Groups[index].ID == groupID {
			group = &layout.Groups[index]
		}
	}
	if group == nil {
		return "", &statusError{http.StatusNotFound, errors.New("no group " + groupID + " in workspace " + workspace + ": name the group's workspace with workspaceId")}
	}
	ids, sessionIDs := []string{}, []string{}
	for _, position := range layout.Positions {
		if position.GroupID != groupID {
			continue
		}
		ids = append(ids, position.ChatID)
		if !strings.HasPrefix(position.ChatID, "native_") {
			sessionIDs = append(sessionIDs, position.ChatID)
		}
	}
	page, err := s.store.ListSessionPage(ctx, store.SessionListQuery{WorkspaceID: workspace, IDs: sessionIDs})
	if err != nil {
		return "", err
	}
	devices := s.deviceLabels(ctx)
	sessions := map[string]mcpSessionItem{}
	for _, item := range page.Sessions {
		sessions[item.ID] = sessionListItem(item, devices)
	}
	items := []mcpSessionItem{}
	for _, id := range ids {
		if item, ok := sessions[id]; ok {
			items = append(items, item)
			continue
		}
		chat, err := s.store.GetChat(ctx, id)
		if err != nil || chat.WorkspaceID != workspace {
			continue
		}
		items = append(items, mcpSessionItem{
			ID: chat.ID, Kind: "native_chat", Title: chat.Title, Status: chat.Status,
			Runtime: chat.Provider, Profile: chat.ProfileLabel, WorkspaceID: chat.WorkspaceID, ActivityAt: chat.UpdatedAt,
		})
	}
	head, _ := json.Marshal(group)
	return "{\n  \"group\": " + string(head) + ",\n  \"sessions\": " + encodeLines(items) + "\n}", nil
}

// createSessionForMCP starts a session (create_session).
func (s *Server) createSessionForMCP(call mcpCall) (string, error) {
	args := call.args
	// It once passed an undocumented nativeSessionId through, which could
	// adopt a person's native chat or fork a session the caller cannot
	// read. No caller sent it; forkSessionId and send_message cover both.
	if mcpArgString(args, "nativeSessionId") != "" {
		return "", &statusError{http.StatusBadRequest, errors.New("nativeSessionId is not accepted: continue a Foundry session with send_message, start from a copy of its transcript with forkSessionId, or read a native chat with read_context")}
	}
	input := store.CreateAgentSessionInput{
		WorkspaceID:          call.workspace,
		Provider:             mcpArgString(args, "provider"),
		ProfileID:            mcpArgString(args, "profileId"),
		Model:                mcpArgString(args, "model"),
		ClaudeEffort:         mcpArgString(args, "claudeEffort"),
		ClaudePermissionMode: mcpArgString(args, "claudePermissionMode"),
		CodexReasoningEffort: mcpArgString(args, "codexReasoningEffort"),
		CodexSandboxMode:     mcpArgString(args, "codexSandboxMode"),
		CodexApprovalPolicy:  mcpArgString(args, "codexApprovalPolicy"),
		CodexSpeed:           mcpArgString(args, "codexSpeed"),
		ImportedContext:      mcpArgString(args, "importedContext"),
		Prompt:               mcpArgString(args, "prompt"),
		Title:                mcpArgString(args, "title"),
		IssueID:              mcpArgString(args, "issueId"),
		ForkSessionID:        mcpSessionID(args, "forkSessionId"),
		Verification:         mcpArgBool(args, "verification"),
		Source:               "chat",
	}
	if !call.actor.Agent() && input.WorkspaceID == "" && input.ForkSessionID == "" {
		return "", &statusError{http.StatusBadRequest, errors.New("workspaceId is required")}
	}
	session, delivered, err := s.startMCPSession(call.r, call.actor, input, mcpArgList(args, "attachments"), mcpArgBool(args, "wait"), mcpWaitMs(args))
	if err != nil {
		return "", err
	}
	return encodeJSON(s.mcpSessionAnswer(call.r.Context(), session, delivered))
}

// handoffSessionForMCP is a factual handoff: only the goal, last result and
// status carry over, never the contaminated transcript. An agent hands off
// only a session it controls: the replacement takes that session's work
// over.
func (s *Server) handoffSessionForMCP(call mcpCall) (string, error) {
	ctx, actor, args := call.r.Context(), call.actor, call.args
	lookup := s.sessionTarget
	if actor.Agent() {
		lookup = s.controlledSession
	}
	target, err := lookup(ctx, actor, mcpArgAlias(args, "sessionId", "fromSessionId"), "hand off")
	if err != nil {
		return "", err
	}
	source, err := store.AgentSessionRecord(ctx, s.store, target.ID)
	if err != nil {
		return "", err
	}
	input := store.CreateAgentSessionInput{
		WorkspaceID: cmp.Or(mcpArgString(args, "workspaceId"), source.WorkspaceID),
		ProfileID:   mcpArgString(args, "profileId"),
		IssueID:     mcpArgString(args, "issueId"),
		Prompt:      handoffPrompt(source, mcpArgString(args, "prompt")),
		Source:      "chat",
	}
	// Without a choice, the replacement runs like the session it
	// continues: its profile on the same device (profiles belong to a
	// device) while that account still works there, else its runtime under
	// an account that does (chooseSessionAccount).
	if input.ProfileID == "" {
		input.Provider = source.Provider
		if destination, err := s.store.GetWorkspace(ctx, input.WorkspaceID); err == nil && destination.DeviceID == source.DeviceID &&
			s.accountUsable(ctx, destination, source.ProfileID) {
			input.ProfileID = source.ProfileID
		}
	}
	session, _, err := s.startMCPSession(call.r, actor, input, nil, false, 0)
	if err != nil {
		return "", err
	}
	return encodeJSON(session)
}

// handoffPrompt carries a session's facts, not its transcript, into a new one.
func handoffPrompt(source store.AgentSession, prompt string) string {
	facts := []string{fmt.Sprintf("Handoff from session %s (\"%s\", status: %s).", source.ID, source.Title, source.Status)}
	if source.Prompt != "" {
		facts = append(facts, "Original goal:\n"+source.Prompt)
	}
	if source.Response != "" {
		facts = append(facts, "Last recorded result:\n"+source.Response)
	}
	return strings.Join(append(facts, prompt), "\n\n")
}

// startMCPSession applies the caller's lineage and defaults, then creates,
// dispatches and optionally waits for a session. attachments name files of
// the caller's to hand over (mcpAttachments); the ones it delivered come
// back with the session.
func (s *Server) startMCPSession(r *http.Request, actor Actor, input store.CreateAgentSessionInput, attachments []string, wait bool, timeoutMs int) (store.AgentSession, []store.ChatAttachment, error) {
	if actor.Agent() {
		if err := s.keepAgentInIssue(r.Context(), actor, &input); err != nil {
			return store.AgentSession{}, nil, &statusError{http.StatusForbidden, err}
		}
		input.ParentSessionID = actor.Identity.SessionID
		input.Source = "agent"
		// Without a choice, a child runs like its parent in the same
		// workspace. Elsewhere profiles belong to another device, whose own
		// logins may not be signed in: the session runs under an account
		// that works there (chooseSessionAccount).
		if input.ProfileID == "" && input.Provider == "" {
			if parent, err := s.store.GetAgentSessionSummary(r.Context(), input.ParentSessionID); err == nil && input.WorkspaceID == parent.WorkspaceID {
				input.Provider, input.ProfileID = parent.Provider, parent.ProfileID
			}
		}
	}
	if input.Verification {
		input.Source = verificationSource
	}
	if strings.TrimSpace(input.ForkSessionID) != "" {
		if err := s.applySessionFork(r, &input, actor); err != nil {
			return store.AgentSession{}, nil, err
		}
	}
	session, delivered, err := s.createAndDispatchForMCP(r, actor, input, attachments)
	// One waiting for its offline device answers now, saying so.
	if err != nil || !wait || s.waitsForDevice(session) {
		return session, delivered, err
	}
	session, err = s.waitMCPTerminal(r.Context(), session.ID, timeoutMs)
	return session, delivered, err
}

// createAndDispatchForMCP mirrors handleCreateAgentSession's resolution and
// dispatch without an HTTP body, including post-create group naming. Files
// it hands over are published only once the store took the session.
func (s *Server) createAndDispatchForMCP(r *http.Request, actor Actor, input store.CreateAgentSessionInput, attachments []string) (store.AgentSession, []store.ChatAttachment, error) {
	ctx := r.Context()
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return store.AgentSession{}, nil, err
	}
	if !scope.can(input.WorkspaceID, store.WorkspaceRoleMember) {
		return store.AgentSession{}, nil, &statusError{http.StatusNotFound, errors.New("workspace not found")}
	}
	if !actor.Agent() {
		input.CreatedByUserID = actor.AccountID()
	}
	if err := s.chooseSessionAccount(ctx, &input); err != nil {
		return store.AgentSession{}, nil, err
	}
	if err := s.resolveSessionDevice(ctx, &input); err != nil {
		return store.AgentSession{}, nil, err
	}
	if err := s.requireVerifierDevice(ctx, input); err != nil {
		return store.AgentSession{}, nil, err
	}
	handed, err := s.mcpAttachments(ctx, actor, input.WorkspaceID, attachments)
	if err != nil {
		return store.AgentSession{}, nil, err
	}
	defer s.discardHandedOver(ctx, handed)
	input.Attachments = handed.list()
	session, err := s.createAndDispatchWith(ctx, input, false, s.publishHandedOver(handed))
	if errors.Is(err, ErrLocalDaemonNotConnected) {
		return session, handed.list(), &statusError{http.StatusConflict, err}
	}
	return session, handed.list(), err
}

func (s *Server) sendMessageForMCP(call mcpCall) (string, error) {
	ctx, args := call.r.Context(), call.args
	target, err := s.controlledSession(ctx, call.actor, mcpArgString(args, "sessionId"), "message")
	if err != nil {
		return "", err
	}
	attachments, err := s.mcpAttachments(ctx, call.actor, target.WorkspaceID, mcpArgList(args, "attachments"))
	if err != nil {
		return "", err
	}
	defer s.discardHandedOver(ctx, attachments)
	// Before the message starts it: the task's news goes to this
	// conversation from its first event on.
	s.adoptAssistantTask(ctx, call.actor, target)
	session, err := s.sendSessionMessageWith(ctx, target.ID, store.SendAgentSessionInput{
		Prompt:          mcpArgAlias(args, "prompt", "message"),
		Attachments:     attachments.list(),
		ProfileID:       mcpArgString(args, "profileId"),
		Provider:        mcpArgString(args, "provider"),
		Model:           mcpArgString(args, "model"),
		SentBySessionID: messageSender(call.actor),
	}, s.publishHandedOver(attachments))
	if err != nil {
		return "", err
	}
	if mcpArgBool(args, "wait") && !s.waitsForDevice(session) {
		if session, err = s.waitMCPTerminal(ctx, session.ID, mcpWaitMs(args)); err != nil {
			return "", err
		}
	}
	return encodeJSON(s.mcpSessionAnswer(ctx, slimAgentSession(session), attachments.list()))
}

func (s *Server) cancelSessionForMCP(call mcpCall) (string, error) {
	target, err := s.controlledSession(call.r.Context(), call.actor, mcpArgString(call.args, "sessionId"), "cancel")
	if err != nil {
		return "", err
	}
	session, err := s.cancelSession(call.r.Context(), call.actor, target.ID)
	if err != nil {
		return "", err
	}
	return encodeJSON(slimAgentSession(session))
}

func (s *Server) waitSessionForMCP(call mcpCall) (string, error) {
	session, err := s.sessionTarget(call.r.Context(), call.actor, mcpArgString(call.args, "sessionId"), "wait on")
	if err != nil {
		return "", err
	}
	var until []string
	if raw, ok := call.args["until"]; ok {
		_ = json.Unmarshal(raw, &until)
	}
	if len(until) == 0 {
		until = []string{"completed", "failed", "canceled"}
	}
	waited, err := s.waitMCPStatuses(call.r.Context(), session.ID, until, mcpWaitMs(call.args))
	if err != nil {
		return "", err
	}
	return encodeJSON(waited)
}

func (s *Server) renameSessionForMCP(call mcpCall) (string, error) {
	target, err := s.controlledSession(call.r.Context(), call.actor, mcpArgString(call.args, "sessionId"), "rename")
	if err != nil {
		return "", err
	}
	updated, err := s.store.RenameChat(call.r.Context(), target.ID, store.RenameChatInput{
		WorkspaceID: target.WorkspaceID,
		Title:       mcpArgString(call.args, "title"),
	})
	if err != nil {
		return "", err
	}
	s.chats.announceTitles(target.WorkspaceID, updated.ChatID)
	return encodeJSON(updated)
}

func (s *Server) waitMCPTerminal(ctx context.Context, id string, timeoutMs int) (store.AgentSession, error) {
	return s.waitMCPStatuses(ctx, id, []string{"completed", "failed", "canceled"}, timeoutMs)
}

func (s *Server) waitMCPStatuses(ctx context.Context, id string, statuses []string, timeoutMs int) (store.AgentSession, error) {
	wanted := map[string]bool{}
	for _, status := range statuses {
		wanted[status] = true
	}
	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	ticker := time.NewTicker(1500 * time.Millisecond)
	defer ticker.Stop()
	for {
		session, err := s.store.GetAgentSessionSummary(ctx, id)
		if err != nil {
			return store.AgentSession{}, err
		}
		if wanted[session.Status] {
			return s.mcpSessionResult(ctx, session)
		}
		if time.Now().After(deadline) {
			return store.AgentSession{}, &statusError{http.StatusConflict, fmt.Errorf("timed out waiting for %s", id)}
		}
		select {
		case <-ctx.Done():
			return store.AgentSession{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

// mcpSessionResult adds the final response to a settled session, which the
// summary omits, so waiting on a child returns what it answered. Events stay
// out; read_context serves the transcript.
func (s *Server) mcpSessionResult(ctx context.Context, summary store.AgentSession) (store.AgentSession, error) {
	switch summary.Status {
	case "completed", "failed", "canceled":
	default:
		return summary, nil
	}
	full, err := store.AgentSessionRecord(ctx, s.store, summary.ID)
	if err != nil {
		return summary, nil
	}
	summary.Response = full.Response
	summary.Error = full.Error
	return summary, nil
}

// encodeLines writes a list one item per line: valid JSON that stays cheap
// to read.
func encodeLines[T any](items []T) string {
	if len(items) == 0 {
		return "[]"
	}
	lines := make([]string, len(items))
	for index, item := range items {
		raw, _ := json.Marshal(item)
		lines[index] = "    " + string(raw)
	}
	return "[\n" + strings.Join(lines, ",\n") + "\n  ]"
}
