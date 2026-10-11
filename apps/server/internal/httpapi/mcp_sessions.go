package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

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
		return store.AgentSession{}, &mcpToolError{http.StatusBadRequest, target.chat.ID + " is a native chat on its device, not a Foundry session: read it with read_context; Foundry cannot " + verb + " it"}
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
		return store.AgentSession{}, &mcpToolError{http.StatusForbidden, fmt.Sprintf("cannot %s %s: %s", verb, session.ID, s.controlRefusal(ctx, actor, session))}
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

func (s *Server) sessionLister() (store.SessionInspectionStore, error) {
	lister, ok := s.store.(store.SessionInspectionStore)
	if !ok {
		return nil, errors.New("this server's store cannot list sessions")
	}
	return lister, nil
}

func (s *Server) listSessionsForMCP(ctx context.Context, actor Actor, workspace string, args map[string]json.RawMessage) (string, error) {
	lister, err := s.sessionLister()
	if err != nil {
		return "", err
	}
	query := store.SessionListQuery{
		WorkspaceID: workspace,
		Cursor:      mcpArgString(args, "cursor"),
		Limit:       mcpArgNumber(args, "limit", 0),
	}
	if mcpArgBool(args, "parentOnly") {
		if !actor.Agent() {
			return "", &mcpToolError{http.StatusBadRequest, "parentOnly lists the sessions the calling session created: it needs a session token"}
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
	page, err := lister.ListSessionPage(ctx, query)
	if errors.Is(err, store.ErrSessionListCursor) {
		return "", &mcpToolError{http.StatusBadRequest, "unknown cursor: pass the nextCursor a previous list_sessions call returned"}
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
func (s *Server) listGroupSessionsForMCP(ctx context.Context, workspace, groupID string) (string, error) {
	if groupID == "" {
		return "", &mcpToolError{http.StatusBadRequest, "groupId is required: read_context's summary names a session's group"}
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
		return "", &mcpToolError{http.StatusNotFound, "no group " + groupID + " in workspace " + workspace + ": name the group's workspace with workspaceId"}
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
	lister, err := s.sessionLister()
	if err != nil {
		return "", err
	}
	page, err := lister.ListSessionPage(ctx, store.SessionListQuery{WorkspaceID: workspace, IDs: sessionIDs})
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
