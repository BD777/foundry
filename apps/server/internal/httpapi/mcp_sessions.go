package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
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
	ArchivedAt      string `json:"archivedAt,omitempty"`
	Archived        bool   `json:"archived,omitempty"`
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
	if source == store.SessionSourceChat {
		source = ""
	}
	return mcpSessionItem{
		ID: item.ID, Title: item.Title, Status: item.Status, ArchivedAt: item.ArchivedAt, Archived: item.ArchivedAt != "",
		Runtime: item.Provider, Profile: item.ProfileLabel, ProfileID: item.ProfileID,
		Device: devices[item.DeviceID], DeviceID: item.DeviceID, WorkspaceID: item.WorkspaceID,
		ParentSessionID: item.ParentSessionID, IssueID: item.IssueID, Role: item.Role, Source: source,
		ActivityAt: item.ActivityAt,
	}
}

func (s *Server) listSessionsForMCP(call mcpCall) (string, error) {
	ctx, actor, args := call.r.Context(), call.actor, call.args
	query := store.SessionListQuery{
		Archived:    mcpArgString(args, "archived"),
		WorkspaceID: call.workspace,
		Cursor:      mcpArgString(args, "cursor"),
		Limit:       mcpArgNumber(args, "limit", 0),
	}
	if query.Archived != "" && query.Archived != "exclude" && query.Archived != "include" && query.Archived != "only" {
		return "", invalid("archived must be exclude, only or include")
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
	page, err := s.store.ListSessionPage(ctx, store.SessionListQuery{WorkspaceID: workspace, IDs: sessionIDs, Archived: "include"})
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
			ArchivedAt: chat.ArchivedAt, Archived: chat.ArchivedAt != "", ID: chat.ID, Kind: "native_chat", Title: chat.Title, Status: chat.Status,
			Runtime: chat.Provider, Profile: chat.ProfileLabel, WorkspaceID: chat.WorkspaceID, ActivityAt: chat.UpdatedAt,
		})
	}
	head, _ := json.Marshal(group)
	return "{\n  \"group\": " + string(head) + ",\n  \"sessions\": " + encodeLines(items) + "\n}", nil
}

// createSessionForMCP starts a session (create_session) as REST does
// (resolveNewSession), running like its parent unless it names an account.
// The files it hands over (mcpAttachments) are published only once the
// store took the session; the ones it delivered come back with it.
func (s *Server) createSessionForMCP(call mcpCall) (string, error) {
	ctx, actor, args := call.r.Context(), call.actor, call.args
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
		Source:               store.SessionSourceChat,
	}
	if !actor.Agent() && input.WorkspaceID == "" && input.ForkSessionID == "" {
		return "", &statusError{http.StatusBadRequest, errors.New("workspaceId is required")}
	}
	if _, given := args["reportBack"]; given {
		reportBack := mcpArgBool(args, "reportBack")
		input.ReportBack = &reportBack
	}
	if err := s.resolveNewSession(ctx, actor, &input, true); err != nil {
		return "", err
	}
	handed, err := s.mcpAttachments(ctx, actor, input.WorkspaceID, mcpArgList(args, "attachments"))
	if err != nil {
		return "", err
	}
	defer s.discardHandedOver(ctx, handed)
	input.Attachments = handed.list()
	session, err := s.sessionService.DispatchNew(ctx, input, sessions.StartOptions{BeforeDispatch: s.publishHandedOver(handed)})
	if err != nil {
		return "", err
	}
	return encodeJSON(s.mcpSessionAnswer(ctx, session, handed.list()))
}

func (s *Server) sendMessageForMCP(call mcpCall) (string, error) {
	if _, err := s.paScope(call.r.Context(), call.actor); err == nil {
		return "", errAssistantStartsByDispatch
	}
	ctx, args := call.r.Context(), call.args
	target, err := s.controlledSession(ctx, call.actor, mcpArgString(args, "sessionId"), "message")
	if err != nil {
		return "", err
	}
	if target.ArchivedAt != "" {
		return "", store.ErrSessionArchived
	}
	attachments, err := s.mcpAttachments(ctx, call.actor, target.WorkspaceID, mcpArgList(args, "attachments"))
	if err != nil {
		return "", err
	}
	defer s.discardHandedOver(ctx, attachments)
	// A parent's message to a child waiting on its question answers it.
	if prompt := mcpArgString(args, "prompt"); prompt != "" {
		if answer := s.answerWaitingQuestion(ctx, messageSender(call.actor), target, prompt); answer != prompt {
			if raw, err := json.Marshal(answer); err == nil {
				args["prompt"] = raw
			}
		}
	}
	// Before the message starts it: the task's news goes to this
	// conversation from its first event on.
	if call.actor.Agent() {
		s.assistant.AdoptTask(ctx, call.actor.Identity.SessionID, target)
	}
	if sender := messageSender(call.actor); sender != "" && mcpArgString(args, "profileId") == "" && mcpArgString(args, "provider") == "" && mcpArgString(args, "model") == "" {
		return s.sendInboxMessageForMCP(call, target, sender, attachments)
	}
	session, err := s.sessionService.Send(ctx, target.ID, store.SendAgentSessionInput{
		Prompt:          mcpArgString(args, "prompt"),
		Attachments:     attachments.list(),
		ProfileID:       mcpArgString(args, "profileId"),
		Provider:        mcpArgString(args, "provider"),
		Model:           mcpArgString(args, "model"),
		SentBySessionID: messageSender(call.actor),
	}, s.publishHandedOver(attachments))
	if err != nil {
		return "", err
	}
	return encodeJSON(s.mcpSessionAnswer(ctx, sessions.Slim(session), attachments.list()))
}

// sendInboxMessageForMCP sends another session's message through the
// recipient's inbox and answers with the session and the message's receipt.
func (s *Server) sendInboxMessageForMCP(call mcpCall, target store.AgentSession, sender string, attachments *handedOver) (string, error) {
	ctx, args := call.r.Context(), call.args
	delivery := strings.TrimSpace(mcpArgString(args, "delivery"))
	if delivery == "" {
		delivery = store.DeliveryBoundary
	}
	if !store.ValidDelivery(delivery) {
		return "", invalid("delivery must be interrupt, boundary or turn_end")
	}
	inputID := strings.TrimSpace(mcpArgString(args, "inputId"))
	if inputID != "" && !store.ValidSessionInputID(inputID) {
		return "", invalid("inputId must be a lowercase UUID, such as one uuidgen prints")
	}
	session, receipt, err := s.sessionService.SendInboxMessage(ctx, target, inputID, sender, delivery, mcpArgString(args, "prompt"), attachments.list(), s.publishHandedOver(attachments))
	if err != nil {
		return "", err
	}
	answer, err := withInboxReceipt(s.mcpSessionAnswer(ctx, sessions.Slim(session), attachments.list()), receipt)
	if err != nil {
		return "", err
	}
	return encodeJSON(answer)
}

func (s *Server) cancelSessionForMCP(call mcpCall) (string, error) {
	target, err := s.controlledSession(call.r.Context(), call.actor, mcpArgString(call.args, "sessionId"), "cancel")
	if err != nil {
		return "", err
	}
	session, err := s.sessionService.Cancel(call.r.Context(), target.ID, messageSender(call.actor))
	if err != nil {
		return "", err
	}
	return encodeJSON(s.mcpSessionAnswer(call.r.Context(), session, nil))
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

// mcpSessionResult adds the final response to a settled session, which the
// summary omits, so waiting on a child returns what it answered. Events stay
// out; read_context serves the transcript.
func (s *Server) mcpSessionResult(ctx context.Context, summary store.AgentSession) (store.AgentSession, error) {
	switch summary.Status {
	case "completed", "failed", "canceled":
	default:
		return summary, nil
	}
	full, err := s.store.GetAgentSessionRecord(ctx, summary.ID)
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

// withInboxReceipt adds the message's receipt to a send_message answer.
func withInboxReceipt(answer any, receipt sessions.Receipt) (any, error) {
	encoded, err := json.Marshal(answer)
	if err != nil {
		return nil, err
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return nil, err
	}
	fields["message"] = receipt
	return fields, nil
}
