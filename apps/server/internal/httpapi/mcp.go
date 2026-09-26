package httpapi

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Remote MCP surface (P2): the same orchestration tools as the stdio `foundry
// mcp`, served over Streamable HTTP so an agent outside the device can drive a
// public Foundry deployment behind TLS. Authentication is the existing Bearer
// chain (session token or browser control token); OAuth 2.1 arrives with the
// accounts system. Responses are plain JSON-RPC over HTTP — sufficient for the
// request/response tool set; long waits are bounded server-side polls.

const mcpProtocolVersion = "2025-06-18"

// mcpProtocolVersions are the Streamable HTTP revisions this endpoint serves;
// initialize echoes the client's requested one when it is listed here.
var mcpProtocolVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

type mcpRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// remoteMCPTools is the Foundry tool catalog: one definition with typed
// input schemas, kept beside the handlers that implement it.
//
//go:embed mcp_tools.json
var remoteMCPToolsJSON []byte

var remoteMCPTools = func() []json.RawMessage {
	var tools []json.RawMessage
	if err := json.Unmarshal(remoteMCPToolsJSON, &tools); err != nil {
		panic("mcp_tools.json: " + err.Error())
	}
	return tools
}()

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	// The session-token endpoint surface restriction does not apply to the
	// /api/mcp path itself; the tools below enforce the same policy using the
	// actor. Browser control tokens retain full access.
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var request mcpRequest
	if !decodeJSONRequest(w, r, &request) {
		return
	}
	// Notifications (no id) such as notifications/initialized take no reply.
	if len(request.ID) == 0 || string(request.ID) == "null" {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	switch request.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(request.Params, &params)
		version := mcpProtocolVersion
		for _, supported := range mcpProtocolVersions {
			if params.ProtocolVersion == supported {
				version = supported
			}
		}
		s.writeMCPResult(w, request.ID, map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "foundry", "version": "0.1.0"},
		})
	case "ping":
		s.writeMCPResult(w, request.ID, map[string]any{})
	case "tools/list":
		s.writeMCPResult(w, request.ID, map[string]any{"tools": remoteMCPTools})
	case "tools/call":
		var params struct {
			Name      string                     `json:"name"`
			Arguments map[string]json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(request.Params, &params); err != nil {
			s.writeMCPError(w, request.ID, -32602, "invalid params")
			return
		}
		result, err := s.executeMCPTool(r, params.Name, params.Arguments)
		if err != nil {
			status, message := http.StatusConflict, err.Error()
			if mcpErr, ok := err.(*mcpToolError); ok {
				status, message = mcpErr.status, mcpErr.message
			}
			if status == http.StatusUnauthorized || status == http.StatusForbidden {
				s.writeMCPError(w, request.ID, -32600, message)
				return
			}
			// A failed tool call is a result the agent can read and act on.
			s.writeMCPResult(w, request.ID, map[string]any{
				"content": []map[string]string{{"type": "text", "text": message}},
				"isError": true,
			})
			return
		}
		text := result
		s.writeMCPResult(w, request.ID, map[string]any{
			"content": []map[string]string{{"type": "text", "text": text}},
		})
	default:
		s.writeMCPError(w, request.ID, -32601, "method not found: "+request.Method)
	}
}

type mcpToolError struct {
	status  int
	message string
}

func (e *mcpToolError) Error() string { return e.message }

func mcpArgString(args map[string]json.RawMessage, key string) string {
	raw, ok := args[key]
	if !ok {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

func mcpArgBool(args map[string]json.RawMessage, key string) bool {
	raw, ok := args[key]
	if !ok {
		return false
	}
	var value bool
	if json.Unmarshal(raw, &value) == nil {
		return value
	}
	// Models sometimes send "true" for a boolean.
	var text string
	return json.Unmarshal(raw, &text) == nil && strings.EqualFold(strings.TrimSpace(text), "true")
}

func mcpArgNumber(args map[string]json.RawMessage, key string, fallback int) int {
	raw, ok := args[key]
	if !ok {
		return fallback
	}
	var value float64
	if json.Unmarshal(raw, &value) != nil {
		// Models sometimes send "60000" for a number.
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return fallback
		}
		parsed, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err != nil {
			return fallback
		}
		value = parsed
	}
	if value <= 0 {
		return fallback
	}
	return int(value)
}

func (s *Server) executeMCPTool(r *http.Request, name string, args map[string]json.RawMessage) (string, error) {
	actor := actorFromContext(r.Context())
	workspace := ""
	if actor.Agent() {
		workspace = actor.Identity.WorkspaceID
	} else if raw, ok := args["workspaceId"]; ok {
		_ = json.Unmarshal(raw, &workspace)
	}
	encode := func(value any) (string, error) {
		raw, err := json.MarshalIndent(value, "", "  ")
		return string(raw), err
	}
	if !actor.Agent() {
		if err := s.authorizeMCPTool(r, actor, name, workspace, args); err != nil {
			return "", err
		}
	}
	switch name {
	case "list_profiles":
		profiles, err := s.store.ListAgentProfiles(r.Context(), func() string {
			if actor.Agent() {
				return actor.Identity.DeviceID
			}
			return mcpArgString(args, "deviceId")
		}())
		if err != nil {
			return "", err
		}
		return encode(profiles)
	case "list_sessions":
		sessions, err := s.store.ListAgentSessionSummaries(r.Context(), workspace)
		if err != nil {
			return "", err
		}
		if mcpArgBool(args, "parentOnly") && actor.Agent() {
			filtered := sessions[:0]
			for _, session := range sessions {
				if session.ParentSessionID == actor.Identity.SessionID {
					filtered = append(filtered, session)
				}
			}
			sessions = filtered
		}
		return encode(sessions)
	case "list_group_sessions":
		groupID := mcpArgString(args, "groupId")
		ids, err := s.store.SessionsInGroup(r.Context(), workspace, groupID)
		if err != nil {
			return "", err
		}
		return encode(ids)
	case "get_session":
		session, err := s.store.GetAgentSession(r.Context(), mcpArgString(args, "sessionId"))
		if err != nil {
			return "", err
		}
		if !s.canReadSession(r.Context(), actor, session) {
			return "", &mcpToolError{http.StatusForbidden, "cannot read this session"}
		}
		return encode(session)
	case "read_context":
		id := mcpArgString(args, "sessionId")
		scope := mcpArgString(args, "scope")
		if scope == "" {
			scope = "summary"
		}
		maxBytes := mcpArgNumber(args, "maxBytes", 12_000)
		var value any
		switch scope {
		case "thread":
			items, err := s.store.ListAgentSessionThread(r.Context(), workspace, id)
			if err != nil {
				return "", err
			}
			anchor, err := s.store.GetAgentSessionSummary(r.Context(), id)
			if err != nil || !s.canReadSession(r.Context(), actor, anchor) {
				return "", &mcpToolError{http.StatusForbidden, "cannot read this thread"}
			}
			value = items
		case "transcript":
			chat, err := s.store.GetChat(r.Context(), id)
			if err != nil {
				return "", err
			}
			if !s.canReadNativeChat(r.Context(), actor, chat.WorkspaceID, chat.ID) {
				return "", &mcpToolError{http.StatusForbidden, "cannot read this chat"}
			}
			value = chat
		default:
			session, err := s.store.GetAgentSessionSummary(r.Context(), id)
			if err != nil {
				return "", err
			}
			if !s.canReadSession(r.Context(), actor, session) {
				return "", &mcpToolError{http.StatusForbidden, "cannot read this session"}
			}
			value = session
		}
		raw, _ := json.MarshalIndent(value, "", "  ")
		if len(raw) > maxBytes {
			raw = append(raw[:maxBytes], []byte("\n…[truncated]")...)
		}
		return string(raw), nil
	case "create_session":
		if !actor.Agent() && workspace == "" {
			workspace = mcpArgString(args, "workspaceId")
		}
		input := store.CreateAgentSessionInput{
			WorkspaceID:     workspace,
			Provider:        mcpArgString(args, "provider"),
			ProfileID:       mcpArgString(args, "profileId"),
			Model:           mcpArgString(args, "model"),
			Prompt:          mcpArgString(args, "prompt"),
			IssueID:         mcpArgString(args, "issueId"),
			NativeSessionID: mcpArgString(args, "nativeSessionId"),
			ForkSessionID:   mcpArgString(args, "forkSessionId"),
			Verification:    mcpArgBool(args, "verification"),
			Source:          "chat",
		}
		if !actor.Agent() && input.WorkspaceID == "" && input.ForkSessionID == "" {
			return "", &mcpToolError{http.StatusBadRequest, "workspaceId is required"}
		}
		if actor.Agent() {
			input.ParentSessionID = actor.Identity.SessionID
			input.Source = "agent"
			// Without a choice, a child runs like its parent.
			if input.ProfileID == "" && input.Provider == "" {
				if parent, err := s.store.GetAgentSessionSummary(r.Context(), input.ParentSessionID); err == nil {
					input.ProfileID, input.Provider = parent.ProfileID, parent.Provider
				}
			}
		}
		if input.Verification {
			input.Source = "verification"
		}
		if strings.TrimSpace(input.ForkSessionID) != "" {
			if status, forkErr := s.applySessionFork(r, &input, actor); forkErr != nil {
				return "", &mcpToolError{status, forkErr.Error()}
			}
		}
		session, err := s.createSessionForMCP(r, actor, input)
		if err != nil {
			return "", err
		}
		if mcpArgBool(args, "wait") {
			session, err = s.waitMCPTerminal(r.Context(), session.ID, mcpArgNumber(args, "timeoutMs", 600_000))
			if err != nil {
				return "", err
			}
		}
		return encode(session)
	case "steer_session":
		return s.controlMCP(r, actor, mcpArgString(args, "sessionId"), func(session store.AgentSession) error {
			return s.hub.SteerAgentSession(r.Context(), session, mcpArgString(args, "message"))
		})
	case "cancel_session":
		return s.controlMCP(r, actor, mcpArgString(args, "sessionId"), func(session store.AgentSession) error {
			return s.hub.CancelAgentSession(r.Context(), session)
		})
	case "wait_session":
		id := mcpArgString(args, "sessionId")
		session, err := s.store.GetAgentSessionSummary(r.Context(), id)
		if err != nil {
			return "", err
		}
		if !s.canReadSession(r.Context(), actor, session) {
			return "", &mcpToolError{http.StatusForbidden, "cannot wait on this session"}
		}
		timeout := mcpArgNumber(args, "timeoutMs", 600_000)
		var until []string
		if raw, ok := args["until"]; ok {
			_ = json.Unmarshal(raw, &until)
		}
		if len(until) == 0 {
			until = []string{"completed", "failed", "canceled"}
		}
		waited, err := s.waitMCPStatuses(r.Context(), id, until, timeout)
		if err != nil {
			return "", err
		}
		return encode(waited)
	case "rename_session":
		id := mcpArgString(args, "sessionId")
		target, err := s.store.GetAgentSessionSummary(r.Context(), id)
		if err != nil {
			return "", err
		}
		if !s.canControlSession(r.Context(), actor, target) {
			return "", &mcpToolError{http.StatusForbidden, "can only rename sessions you created"}
		}
		updated, err := s.store.RenameChat(r.Context(), id, store.RenameChatInput{
			WorkspaceID: target.WorkspaceID,
			Title:       mcpArgString(args, "title"),
		})
		if err != nil {
			return "", err
		}
		return encode(updated)
	default:
		return "", &mcpToolError{http.StatusBadRequest, "unknown tool: " + name}
	}
}

// createSessionForMCP mirrors handleCreateAgentSession without an HTTP body.
// createSessionForMCP mirrors handleCreateAgentSession's resolution and
// dispatch without an HTTP body, applying the same device confinement and
// post-create group naming.
// authorizeMCPTool applies workspace and device reach to people and devices;
// per-session tools are checked by canReadSession / canControlSession.
func (s *Server) authorizeMCPTool(r *http.Request, actor Actor, name, workspace string, args map[string]json.RawMessage) error {
	view, err := s.visibilityFor(r.Context(), actor)
	if err != nil {
		return err
	}
	switch name {
	case "list_profiles":
		if !view.seesDevice(mcpArgString(args, "deviceId")) {
			return &mcpToolError{http.StatusNotFound, "device not found"}
		}
	case "list_sessions", "list_group_sessions":
		if workspace == "" {
			return &mcpToolError{http.StatusBadRequest, "workspaceId is required"}
		}
		if !view.scope.can(workspace, store.WorkspaceRoleViewer) {
			return &mcpToolError{http.StatusNotFound, "workspace not found"}
		}
	}
	return nil
}

func (s *Server) createSessionForMCP(r *http.Request, actor Actor, input store.CreateAgentSessionInput) (store.AgentSession, error) {
	ctx := r.Context()
	if !actor.Agent() {
		scope, err := s.contextScope(ctx, actor)
		if err != nil {
			return store.AgentSession{}, err
		}
		if !scope.can(input.WorkspaceID, store.WorkspaceRoleMember) {
			return store.AgentSession{}, &mcpToolError{http.StatusNotFound, "workspace not found"}
		}
		input.CreatedByUserID = actor.AccountID()
	}
	agents, err := s.store.ListAgents(ctx, input.WorkspaceID, "")
	if err != nil {
		return store.AgentSession{}, err
	}
	deviceID := ""
	for _, agent := range agents {
		if input.AgentID != "" && agent.ID == input.AgentID {
			deviceID = agent.DeviceID
			break
		}
		if input.AgentID == "" && input.Provider != "" && agent.Provider == input.Provider {
			deviceID = agent.DeviceID
			break
		}
	}
	if deviceID == "" && input.AgentID != "" {
		if resolved, resolveErr := s.store.ResolveSessionAgent(ctx, input); resolveErr == nil {
			deviceID = resolved.DeviceID
		}
	}
	if deviceID == "" {
		return store.AgentSession{}, &mcpToolError{http.StatusBadRequest, "no agent is available for the selected runtime and profile"}
	}
	if actor.Agent() && deviceID != actor.Identity.DeviceID {
		return store.AgentSession{}, &mcpToolError{http.StatusForbidden, "session token can only start sessions on its own device"}
	}
	if !s.hub.HasConnection(deviceID) {
		return store.AgentSession{}, &mcpToolError{http.StatusConflict, "local daemon is not connected"}
	}
	session, err := s.store.CreateAgentSession(ctx, input)
	if err != nil {
		return store.AgentSession{}, err
	}
	s.events.Publish("agent_session_created", session)
	if groupID := strings.TrimSpace(session.CreatedGroupID); groupID != "" {
		go s.titles.StartGroupName(context.Background(), session.WorkspaceID, groupID, session.ParentSessionID)
	}
	if err := s.hub.DispatchAgentSession(session); err != nil {
		failed, _ := s.store.FailAgentSession(ctx, session.ID, "local daemon is not connected")
		return failed, &mcpToolError{http.StatusConflict, "local daemon is not connected"}
	}
	return session, nil
}

func (s *Server) controlMCP(r *http.Request, actor Actor, id string, action func(store.AgentSession) error) (string, error) {
	session, err := s.store.GetAgentSession(r.Context(), id)
	if err != nil {
		return "", err
	}
	if !s.canControlSession(r.Context(), actor, session) {
		return "", &mcpToolError{http.StatusForbidden, "can only control sessions you created"}
	}
	if !activeOrBlocked(session.Status) {
		return "", &mcpToolError{http.StatusConflict, "agent session is not active"}
	}
	if err := action(session); err != nil {
		return "", &mcpToolError{http.StatusConflict, err.Error()}
	}
	updated, err := s.store.GetAgentSessionSummary(r.Context(), id)
	if err != nil {
		return "", err
	}
	return encodeJSON(updated)
}

func encodeJSON(value any) (string, error) {
	raw, err := json.MarshalIndent(value, "", "  ")
	return string(raw), err
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
			return store.AgentSession{}, &mcpToolError{http.StatusConflict, fmt.Sprintf("timed out waiting for %s", id)}
		}
		select {
		case <-ctx.Done():
			return store.AgentSession{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (s *Server) writeMCPResult(w http.ResponseWriter, id json.RawMessage, result any) {
	writeJSON(w, http.StatusOK, map[string]any{"jsonrpc": "2.0", "id": rawJSON(id), "result": result})
}

func (s *Server) writeMCPError(w http.ResponseWriter, id json.RawMessage, code int, message string) {
	writeJSON(w, http.StatusOK, map[string]any{
		"jsonrpc": "2.0",
		"id":      rawJSON(id),
		"error":   map[string]any{"code": code, "message": message},
	})
}

func rawJSON(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
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
	full, err := s.store.GetAgentSession(ctx, summary.ID)
	if err != nil {
		return summary, nil
	}
	summary.Response = full.Response
	summary.Error = full.Error
	return summary, nil
}
