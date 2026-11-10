package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

func (s *Server) workSession(call mcpCall, control bool) (store.AgentSession, error) {
	id := mcpArgString(call.args, "sessionId")
	if id == "" {
		id = call.actor.Identity.SessionID
	}
	if control {
		return s.controlledSession(call.r.Context(), call.actor, id, "control work of")
	}
	session, err := s.sessionTarget(call.r.Context(), call.actor, id, "read work of")
	if err == nil && !s.canControlSession(call.r.Context(), call.actor, session) {
		return session, &statusError{http.StatusForbidden, errors.New("membership required to inspect work commands")}
	}
	return session, err
}
func (s *Server) listWorkForMCP(call mcpCall) (string, error) {
	if workspaceID := mcpArgString(call.args, "workspaceId"); workspaceID != "" {
		scope, err := s.contextScope(call.r.Context(), call.actor)
		if err != nil || !scope.can(workspaceID, store.WorkspaceRoleMember) || scope.issueID != "" {
			return "", &statusError{http.StatusForbidden, errors.New("workspace service inventory requires workspace membership outside an Issue-scoped session")}
		}
		items, err := s.store.ListWorkspaceServices(call.r.Context(), workspaceID)
		if err != nil {
			return "", err
		}
		if id := mcpArgString(call.args, "id"); id != "" {
			for _, item := range items {
				if item.ID == id {
					runs, err := s.store.ListWorkRuns(call.r.Context(), id)
					if err != nil {
						return "", err
					}
					return encodeJSON(map[string]any{"item": item, "runs": runs})
				}
			}
			return "", &statusError{http.StatusNotFound, errors.New("service not found")}
		}
		items = filterSessionWorkItems(items, call.args)
		answer, err := pageSessionWorkItems(items, call.args, map[string]string{})
		if err != nil {
			return "", err
		}
		answer.Coverage = nil
		answer.Scope = "workspace_services"
		if mcpArgBool(call.args, "detail") {
			tunnels := []map[string]any{}
			registered, err := s.store.ListServiceTunnels(call.r.Context(), workspaceID)
			if err != nil {
				return "", err
			}
			userID := call.actor.AccountID()
			if call.actor.Agent() {
				userID = scope.agentFor
			}
			for _, item := range registered {
				if s.authorizeTunnel(call.r.Context(), item, userID) && scope.can(item.TargetWorkspaceID, store.WorkspaceRoleMember) {
					_, status := s.liveTunnel(item)
					tunnels = append(tunnels, map[string]any{"service": item, "url": s.tunnelURL(item), "status": status})
				}
			}
			answer.ServiceTunnels = tunnels
		}
		return encodeSessionWorkPage(answer)
	}
	session, err := s.workSession(call, false)
	if err != nil {
		return "", err
	}
	list, err := s.sessionWorkList(call.r.Context(), session)
	if err != nil {
		return "", err
	}
	if id := mcpArgString(call.args, "id"); id != "" {
		for _, item := range list.Items {
			if item.ID == id {
				runs, err := s.store.ListWorkRuns(call.r.Context(), id)
				if err != nil {
					return "", err
				}
				return encodeJSON(struct {
					Item store.SessionWork `json:"item"`
					Runs []store.WorkRun   `json:"runs"`
				}{item, runs})
			}
		}
		return "", &statusError{http.StatusNotFound, errors.New("work not found")}
	}
	return pageSessionWorkForMCP(list, call.args)
}

const (
	defaultSessionWorkLimit   = 20
	maxSessionWorkLimit       = 50
	maxSessionWorkDetailLimit = 5
)

type sessionWorkCompact struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Status  string `json:"status"`
	Title   string `json:"title,omitempty"`
	Command string `json:"command,omitempty"`
	Time    string `json:"time,omitempty"`
	// DesiredState is shown only when it differs from the observed status,
	// such as a stop that the device has not confirmed.
	DesiredState string `json:"desiredState,omitempty"`
}

type sessionWorkOperationCompact struct {
	ID        string `json:"id"`
	Action    string `json:"action"`
	State     string `json:"state"`
	CreatedAt string `json:"createdAt"`
}

type sessionWorkPageAnswer struct {
	Items          any               `json:"items"`
	Total          int               `json:"total"`
	Remaining      int               `json:"remaining"`
	NextCursor     string            `json:"nextCursor,omitempty"`
	Hint           string            `json:"hint,omitempty"`
	Coverage       map[string]string `json:"coverage,omitempty"`
	Barrier        bool              `json:"barrier,omitempty"`
	Operations     any               `json:"operations,omitempty"`
	ServiceTunnels []map[string]any  `json:"serviceTunnels,omitempty"`
	Scope          string            `json:"scope,omitempty"`
}

func pageSessionWorkForMCP(list store.SessionWorkList, args map[string]json.RawMessage) (string, error) {
	items := filterSessionWorkItems(list.Items, args)
	answer, err := pageSessionWorkItems(items, args, list.Coverage)
	if err != nil {
		return "", err
	}
	answer.Barrier = list.Barrier
	if mcpArgBool(args, "detail") {
		answer.Operations = list.Operations
	} else {
		operations := make([]sessionWorkOperationCompact, 0, min(len(list.Operations), 10))
		for _, operation := range list.Operations {
			if len(operations) == 10 {
				break
			}
			operations = append(operations, sessionWorkOperationCompact{
				ID: operation.ID, Action: operation.Action, State: operation.State, CreatedAt: operation.CreatedAt,
			})
		}
		if len(operations) > 0 {
			answer.Operations = operations
		}
	}
	return encodeSessionWorkPage(answer)
}

func encodeSessionWorkPage(answer sessionWorkPageAnswer) (string, error) {
	items, err := encodeSessionWorkLines(answer.Items)
	if err != nil {
		return "", err
	}
	operations, err := encodeSessionWorkLines(answer.Operations)
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(struct {
		Items          json.RawMessage   `json:"items"`
		Total          int               `json:"total"`
		Remaining      int               `json:"remaining"`
		NextCursor     string            `json:"nextCursor,omitempty"`
		Hint           string            `json:"hint,omitempty"`
		Coverage       map[string]string `json:"coverage,omitempty"`
		Barrier        bool              `json:"barrier,omitempty"`
		Operations     json.RawMessage   `json:"operations,omitempty"`
		ServiceTunnels []map[string]any  `json:"serviceTunnels,omitempty"`
		Scope          string            `json:"scope,omitempty"`
	}{
		Items: items, Total: answer.Total, Remaining: answer.Remaining,
		NextCursor: answer.NextCursor, Hint: answer.Hint, Coverage: answer.Coverage,
		Barrier: answer.Barrier, Operations: operations, ServiceTunnels: answer.ServiceTunnels, Scope: answer.Scope,
	})
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func encodeSessionWorkLines(value any) (json.RawMessage, error) {
	if value == nil {
		return nil, nil
	}
	switch items := value.(type) {
	case []sessionWorkCompact:
		return json.RawMessage(encodeLines(items)), nil
	case []store.SessionWork:
		return json.RawMessage(encodeLines(items)), nil
	case []sessionWorkOperationCompact:
		return json.RawMessage(encodeLines(items)), nil
	case []store.WorkOperation:
		return json.RawMessage(encodeLines(items)), nil
	default:
		raw, err := json.Marshal(value)
		return raw, err
	}
}

func filterSessionWorkItems(items []store.SessionWork, args map[string]json.RawMessage) []store.SessionWork {
	statuses := map[string]bool{}
	for _, status := range mcpArgList(args, "status") {
		if normalized := strings.ToLower(strings.TrimSpace(status)); normalized != "" {
			statuses[normalized] = true
		}
	}
	itemSessionID := strings.TrimSpace(mcpArgString(args, "itemSessionId"))
	filtered := make([]store.SessionWork, 0, len(items))
	for _, item := range items {
		if itemSessionID != "" && item.SessionID != itemSessionID && !workHasSession(item.RelatedSessionIDs, itemSessionID) {
			continue
		}
		if len(statuses) > 0 {
			status := strings.ToLower(item.Observation.Status)
			desired := strings.ToLower(item.DesiredState)
			if !statuses[status] && !statuses[desired] {
				continue
			}
		}
		filtered = append(filtered, item)
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		left, right := sessionWorkTime(filtered[i]), sessionWorkTime(filtered[j])
		if left == right {
			return filtered[i].ID < filtered[j].ID
		}
		return left > right
	})
	return filtered
}

func workHasSession(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func sessionWorkTime(item store.SessionWork) string {
	return cmpString(item.UpdatedAt, item.Observation.At, item.CreatedAt)
}

func cmpString(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func compactSessionWork(item store.SessionWork) sessionWorkCompact {
	status := item.Observation.Status
	if status == "" {
		status = item.DesiredState
	}
	compact := sessionWorkCompact{
		ID: item.ID, Kind: item.Kind, Status: status,
		Title: textcut.Excerpt(oneLine(item.Title, 80), 80),
		Time:  sessionWorkTime(item),
	}
	if command := textcut.Excerpt(oneLine(strings.Join(item.Spec.Argv, " "), 80), 80); compact.Title == "" {
		compact.Command = command
	}
	if item.DesiredState != "" && item.DesiredState != status {
		compact.DesiredState = item.DesiredState
	}
	return compact
}

func pageSessionWorkItems(items []store.SessionWork, args map[string]json.RawMessage, coverage map[string]string) (sessionWorkPageAnswer, error) {
	offset, err := sessionWorkOffset(args)
	if err != nil {
		return sessionWorkPageAnswer{}, err
	}
	limit := mcpArgNumber(args, "limit", defaultSessionWorkLimit)
	if limit == 0 {
		limit = defaultSessionWorkLimit
	}
	if limit < 0 {
		return sessionWorkPageAnswer{}, invalid("limit must be greater than zero")
	}
	limit = min(limit, maxSessionWorkLimit)
	if mcpArgBool(args, "detail") {
		limit = min(limit, maxSessionWorkDetailLimit)
	}
	total := len(items)
	if offset > total {
		offset = total
	}
	end := min(offset+limit, total)
	answer := sessionWorkPageAnswer{
		Items: []store.SessionWork{}, Total: total, Remaining: total - end, Coverage: coverage,
	}
	if mcpArgBool(args, "detail") {
		answer.Items = append([]store.SessionWork(nil), items[offset:end]...)
	} else {
		page := make([]sessionWorkCompact, 0, end-offset)
		for _, item := range items[offset:end] {
			page = append(page, compactSessionWork(item))
		}
		answer.Items = page
	}
	if end < total {
		answer.NextCursor = encodeSessionWorkOffset(end)
		answer.Hint = fmt.Sprintf("%d more items; pass nextCursor (or offset=%d) to continue.", total-end, end)
	}
	return answer, nil
}

func sessionWorkOffset(args map[string]json.RawMessage) (int, error) {
	offset := mcpArgNumber(args, "offset", 0)
	if offset < 0 {
		return 0, invalid("offset must be zero or greater")
	}
	cursor := strings.TrimSpace(mcpArgString(args, "cursor"))
	if cursor == "" {
		return offset, nil
	}
	if offset != 0 {
		return 0, invalid("use cursor or offset, not both")
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, invalid("unknown cursor: pass nextCursor from a previous list_session_work call")
	}
	decoded, err := strconv.Atoi(string(raw))
	if err != nil || decoded < 0 {
		return 0, invalid("unknown cursor: pass nextCursor from a previous list_session_work call")
	}
	return decoded, nil
}

func encodeSessionWorkOffset(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(offset)))
}
func (s *Server) controlWorkForMCP(call mcpCall) (string, error) {
	session, err := s.workSession(call, true)
	if err != nil {
		return "", err
	}
	input := store.WorkControlInput{ExpectedReferenceRevision: int64(mcpArgNumber(call.args, "expectedReferenceRevision", 0)), RelatedSessionID: mcpArgString(call.args, "relatedSessionId"), ID: mcpArgString(call.args, "id"), Action: mcpArgString(call.args, "action"), ExpectedRevision: int64(mcpArgNumber(call.args, "expectedRevision", 0)), IdempotencyKey: mcpArgString(call.args, "idempotencyKey")}
	op, err := s.controlWork(call.r.Context(), session, input)
	if err != nil {
		return "", err
	}
	return encodeJSON(op)
}
func (s *Server) createWorkForMCP(call mcpCall) (string, error) {
	session, err := s.workSession(call, true)
	if err != nil {
		return "", err
	}
	input := createWorkInput{Title: mcpArgString(call.args, "title"), IdempotencyKey: mcpArgString(call.args, "idempotencyKey"), Kind: mcpArgString(call.args, "kind")}
	if err := json.Unmarshal(call.args["spec"], &input.Spec); err != nil {
		return "", &statusError{http.StatusBadRequest, errors.New("spec is required")}
	}
	w, err := s.createWork(call.r.Context(), session, input)
	if err != nil {
		return "", err
	}
	return encodeJSON(w)
}
