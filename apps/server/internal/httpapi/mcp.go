package httpapi

import (
	"cmp"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
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

type mcpTool struct {
	name       string
	definition json.RawMessage
	// readOnly: the tool changes nothing (MCP's readOnlyHint annotation).
	readOnly bool
	// summary and limits tell people what the tool gives an agent (the
	// foundry skill's page); agents never see them.
	summary string
	limits  []string
}

// mcpToolPeopleFields are the catalog's fields for people, kept beside each
// definition and left out of what agents are sent.
var mcpToolPeopleFields = []string{"summary", "limits"}

var remoteMCPTools = func() []mcpTool {
	var definitions []json.RawMessage
	if err := json.Unmarshal(remoteMCPToolsJSON, &definitions); err != nil {
		panic("mcp_tools.json: " + err.Error())
	}
	tools := make([]mcpTool, len(definitions))
	for index, definition := range definitions {
		var named struct {
			Name        string `json:"name"`
			Annotations struct {
				ReadOnlyHint bool `json:"readOnlyHint"`
			} `json:"annotations"`
			Summary string   `json:"summary"`
			Limits  []string `json:"limits"`
		}
		if err := json.Unmarshal(definition, &named); err != nil || named.Name == "" {
			panic(fmt.Sprintf("mcp_tools.json: tool %d has no name", index))
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(definition, &fields); err != nil {
			panic("mcp_tools.json: " + named.Name + ": " + err.Error())
		}
		for _, field := range mcpToolPeopleFields {
			delete(fields, field)
		}
		forAgents, err := json.Marshal(fields)
		if err != nil {
			panic("mcp_tools.json: " + named.Name + ": " + err.Error())
		}
		tools[index] = mcpTool{named.Name, forAgents, named.Annotations.ReadOnlyHint, named.Summary, named.Limits}
	}
	return tools
}()

// clarificationMCPTools are the tools an Issue's clarification may call:
// it only reads sessions. The worker grants it the same ones
// (session-roles.ts clarificationFoundryTools).
var clarificationMCPTools = map[string]bool{"list_sessions": true, "read_context": true}

// mcpToolAvailability decides which tools a caller may call; tools/list
// shows exactly those. A session's role narrows its tools: an Issue's
// clarification only reads sessions, a verifier only calls the tools that
// change nothing, and only an Issue's execution asks the person. Reach is
// still checked per call.
func (s *Server) mcpToolAvailability(ctx context.Context, actor Actor) func(name string) error {
	role, verifier := "", false
	if actor.Agent() {
		if session, err := store.AgentSessionRecord(ctx, s.store, actor.Identity.SessionID); err == nil {
			role, verifier = session.Role, session.Source == verificationSource
		}
	}
	return func(name string) error { return mcpToolAllowed(role, verifier, name) }
}

// mcpToolAllowed is the rule mcpToolAvailability applies to a session of
// one role ("" for a chat, the sessions agents start and people at a shell).
func mcpToolAllowed(role string, verifier bool, name string) error {
	if role == store.AgentSessionRoleIssueClarification && !clarificationMCPTools[name] {
		return &mcpToolError{http.StatusForbidden, name + " is not available to an Issue's clarification: it reads sessions with list_sessions and read_context"}
	}
	if verifier && !readOnlyMCPTool(name) {
		return &mcpToolError{http.StatusForbidden, name + " is not available to a verifier: it checks work with the Foundry tools that only read, and reports what it found to whoever started it"}
	}
	if name == "ask_person" && role != store.AgentSessionRoleIssueExecution {
		return &mcpToolError{http.StatusForbidden, "only an Issue's execution can ask the person; say what you need in your reply to whoever started you"}
	}
	return nil
}

func (s *Server) mcpToolsFor(ctx context.Context, actor Actor) []json.RawMessage {
	available := s.mcpToolAvailability(ctx, actor)
	tools := []json.RawMessage{}
	for _, tool := range remoteMCPTools {
		if available(tool.name) == nil {
			tools = append(tools, tool.definition)
		}
	}
	return tools
}

func knownMCPTool(name string) bool {
	for _, tool := range remoteMCPTools {
		if tool.name == name {
			return true
		}
	}
	return false
}

func readOnlyMCPTool(name string) bool {
	for _, tool := range remoteMCPTools {
		if tool.name == name {
			return tool.readOnly
		}
	}
	return false
}

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
		s.writeMCPResult(w, request.ID, map[string]any{"tools": s.mcpToolsFor(r.Context(), actorFromContext(r.Context()))})
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

// mcpArgAlias reads an argument by its name, else by an older name that a
// session holding an earlier tool list may still send.
func mcpArgAlias(args map[string]json.RawMessage, key string, older ...string) string {
	for _, name := range append([]string{key}, older...) {
		if value := mcpArgString(args, name); value != "" {
			return value
		}
	}
	return ""
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
	// A tool acts on the workspace it names; an agent's defaults to its own.
	workspace := mcpArgString(args, "workspaceId")
	if workspace == "" && actor.Agent() {
		workspace = actor.Identity.WorkspaceID
	}
	encode := func(value any) (string, error) {
		raw, err := json.MarshalIndent(value, "", "  ")
		return string(raw), err
	}
	if !knownMCPTool(name) {
		return "", &mcpToolError{http.StatusBadRequest, "unknown tool: " + name}
	}
	if err := s.mcpToolAvailability(r.Context(), actor)(name); err != nil {
		return "", err
	}
	if err := s.authorizeMCPTool(r, actor, name, workspace, args); err != nil {
		return "", err
	}
	switch name {
	case "list_workspaces":
		view, err := s.visibilityFor(r.Context(), actor)
		if err != nil {
			return "", err
		}
		all, err := s.store.ListWorkspaces(r.Context())
		if err != nil {
			return "", err
		}
		// A removed device's workspaces are gone, as list_resources shows.
		devices, err := s.store.ListDevices(r.Context())
		if err != nil {
			return "", err
		}
		removed := map[string]bool{}
		for _, device := range devices {
			removed[device.ID] = device.Status == "removed"
		}
		type reachable struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			DeviceID    string `json:"deviceId,omitempty"`
			DeviceLabel string `json:"deviceLabel,omitempty"`
			AccessRole  string `json:"accessRole"`
			// Unavailable explains why sessions cannot run in it now.
			Unavailable string `json:"unavailable,omitempty"`
		}
		workspaces := []reachable{}
		for _, workspace := range view.scope.filterWorkspaces(all) {
			if removed[workspace.DeviceID] {
				continue
			}
			item := reachable{workspace.ID, workspace.Name, workspace.DeviceID, workspace.DeviceLabel, workspace.AccessRole, ""}
			if workspace.UnavailableOnDevice != nil {
				item.Unavailable = workspaceNotServedMessage(workspace)
			}
			workspaces = append(workspaces, item)
		}
		return encode(workspaces)
	case "list_resources":
		return s.listResourcesForMCP(r, actor, mcpArgString(args, "kind"))
	case "list_profiles":
		profiles, err := s.store.ListAgentProfiles(r.Context(), mcpDeviceID(actor, args))
		if err != nil {
			return "", err
		}
		if runtime := mcpArgString(args, "runtime"); runtime != "" {
			filtered := profiles[:0]
			for _, profile := range profiles {
				if profile.Runtime == runtime {
					filtered = append(filtered, profile)
				}
			}
			profiles = filtered
		}
		return encode(profiles)
	case "list_sessions":
		return s.listSessionsForMCP(r.Context(), actor, workspace, args)
	case "list_group_sessions":
		return s.listGroupSessionsForMCP(r.Context(), workspace, mcpArgString(args, "groupId"))
	case "get_session":
		return s.sessionDigestForMCP(r.Context(), actor, mcpArgString(args, "sessionId"))
	case "list_issues":
		return s.listIssuesForMCP(r.Context(), actor, workspace, mcpArgList(args, "status"))
	case "get_issue":
		return s.issueForMCP(r.Context(), actor, mcpArgString(args, "issueId"))
	case "read_context":
		id := mcpSessionID(args, "sessionId")
		scope := mcpArgString(args, "scope")
		maxBytes := mcpArgNumber(args, "maxBytes", 12_000)
		var value any
		switch scope {
		case "", "summary":
			return s.sessionDigestForMCP(r.Context(), actor, id)
		case "events":
			return s.sessionEventsForMCP(r.Context(), actor, args)
		case "thread":
			anchor, err := s.resolveInspectTarget(r.Context(), actor, id, false)
			if err != nil {
				return "", err
			}
			if anchor.session == nil {
				return "", &mcpToolError{http.StatusBadRequest, id + " is a native chat: read it with scope=transcript or events"}
			}
			items, err := s.store.ListAgentSessionThread(r.Context(), anchor.session.WorkspaceID, anchor.session.ID)
			if err != nil {
				return "", err
			}
			value = items
		case "transcript":
			chat, err := s.store.GetChat(r.Context(), id)
			if errors.Is(err, store.ErrNotFound) || (err == nil && !s.canReadNativeChat(r.Context(), actor, chat.WorkspaceID, chat.ID)) {
				return "", inspectNotFound(id)
			}
			if err != nil {
				return "", err
			}
			value = chat
		case "subagents":
			target, err := s.resolveInspectTarget(r.Context(), actor, id, false)
			if err != nil {
				return "", err
			}
			if target.session == nil {
				return "", &mcpToolError{http.StatusBadRequest, id + " is a native chat: it has no Foundry subagent records"}
			}
			session := *target.session
			ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
			defer cancel()
			if taskID := mcpArgString(args, "taskId"); taskID != "" {
				value, err = s.hub.ReadAgentSubagentTranscript(ctx, session, taskID)
			} else {
				value, err = s.hub.ListAgentSubagents(ctx, session)
			}
			if err != nil {
				return "", err
			}
		case "changes", "file", "background":
			return s.sessionOutputsForMCP(r.Context(), actor, scope, args)
		default:
			return "", &mcpToolError{http.StatusBadRequest, "unknown scope " + scope + ": use summary, events, thread, transcript, subagents, changes, file or background"}
		}
		raw, _ := json.MarshalIndent(value, "", "  ")
		if len(raw) > maxBytes {
			raw = append(raw[:maxBytes], []byte(fmt.Sprintf("\n…[truncated at maxBytes %d; scope=events reads events filtered and paged]", maxBytes))...)
		}
		return string(raw), nil
	case "create_session":
		// It once passed an undocumented nativeSessionId through, which could
		// adopt a person's native chat or fork a session the caller cannot
		// read. No caller sent it; forkSessionId and send_message cover both.
		if mcpArgString(args, "nativeSessionId") != "" {
			return "", &mcpToolError{http.StatusBadRequest, "nativeSessionId is not accepted: continue a Foundry session with send_message, start from a copy of its transcript with forkSessionId, or read a native chat with read_context"}
		}
		input := store.CreateAgentSessionInput{
			WorkspaceID:          workspace,
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
			IssueID:              mcpArgString(args, "issueId"),
			ForkSessionID:        mcpSessionID(args, "forkSessionId"),
			Verification:         mcpArgBool(args, "verification"),
			Source:               "chat",
		}
		if !actor.Agent() && input.WorkspaceID == "" && input.ForkSessionID == "" {
			return "", &mcpToolError{http.StatusBadRequest, "workspaceId is required"}
		}
		session, delivered, err := s.startMCPSession(r, actor, input, mcpArgList(args, "attachments"), mcpArgBool(args, "wait"), mcpWaitMs(args))
		if err != nil {
			return "", err
		}
		return encode(withDeliveredAttachments(session, delivered))
	case "handoff_session":
		// A factual handoff: only the goal, last result and status carry over,
		// never the contaminated transcript. An agent hands off only a
		// session it controls: the replacement takes that session's work over.
		lookup := s.sessionTarget
		if actor.Agent() {
			lookup = s.controlledSession
		}
		target, err := lookup(r.Context(), actor, mcpArgAlias(args, "sessionId", "fromSessionId"), "hand off")
		if err != nil {
			return "", err
		}
		source, err := store.AgentSessionRecord(r.Context(), s.store, target.ID)
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
		// device), elsewhere its runtime.
		if input.ProfileID == "" {
			input.Provider = source.Provider
			if destination, err := s.store.GetWorkspace(r.Context(), input.WorkspaceID); err == nil && destination.DeviceID == source.DeviceID {
				input.ProfileID = source.ProfileID
			}
		}
		session, _, err := s.startMCPSession(r, actor, input, nil, false, 0)
		if err != nil {
			return "", err
		}
		return encode(session)
	case "list_models":
		profiles, err := s.store.ListAgentProfiles(r.Context(), mcpDeviceID(actor, args))
		if err != nil {
			return "", err
		}
		profileID := mcpArgString(args, "profileId")
		for _, profile := range profiles {
			if profile.ID != profileID {
				continue
			}
			models, status, err := s.listAgentModels(r.Context(), actor, agentProfileInputFromProjection(profile))
			if err != nil {
				if status == 0 {
					return "", err
				}
				return "", &mcpToolError{status, err.Error()}
			}
			return encode(models)
		}
		return "", &mcpToolError{http.StatusNotFound, "unknown profile: " + profileID}
	case "send_message":
		target, err := s.controlledSession(r.Context(), actor, mcpArgString(args, "sessionId"), "message")
		if err != nil {
			return "", err
		}
		attachments, err := s.mcpAttachments(r.Context(), actor, target.WorkspaceID, mcpArgList(args, "attachments"))
		if err != nil {
			return "", err
		}
		defer s.discardHandedOver(r.Context(), attachments)
		session, status, err := s.sendSessionMessageWith(r.Context(), target.ID, store.SendAgentSessionInput{
			Prompt:      mcpArgAlias(args, "prompt", "message"),
			Attachments: attachments.list(),
			ProfileID:   mcpArgString(args, "profileId"),
			Provider:    mcpArgString(args, "provider"),
			Model:       mcpArgString(args, "model"),
		}, s.publishHandedOver(attachments))
		if err != nil {
			if status != 0 {
				return "", &mcpToolError{status, err.Error()}
			}
			return "", err
		}
		if mcpArgBool(args, "wait") {
			if session, err = s.waitMCPTerminal(r.Context(), session.ID, mcpWaitMs(args)); err != nil {
				return "", err
			}
		}
		return encode(withDeliveredAttachments(slimAgentSession(session), attachments.list()))
	case "ask_person":
		return s.askPersonForMCP(r, actor, args)
	case "cancel_session":
		target, err := s.controlledSession(r.Context(), actor, mcpArgString(args, "sessionId"), "cancel")
		if err != nil {
			return "", err
		}
		session, status, err := s.cancelSession(r.Context(), actor, target.ID)
		if err != nil {
			if status != 0 {
				return "", &mcpToolError{status, err.Error()}
			}
			return "", err
		}
		return encode(slimAgentSession(session))
	case "wait_session":
		session, err := s.sessionTarget(r.Context(), actor, mcpArgString(args, "sessionId"), "wait on")
		if err != nil {
			return "", err
		}
		id := session.ID
		timeout := mcpWaitMs(args)
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
	case "feishu_events":
		return s.feishuEventsForMCP(r, actor, args)
	case "rename_session":
		target, err := s.controlledSession(r.Context(), actor, mcpArgString(args, "sessionId"), "rename")
		if err != nil {
			return "", err
		}
		updated, err := s.store.RenameChat(r.Context(), target.ID, store.RenameChatInput{
			WorkspaceID: target.WorkspaceID,
			Title:       mcpArgString(args, "title"),
		})
		if err != nil {
			return "", err
		}
		s.chats.announceTitles(target.WorkspaceID, updated.ChatID)
		return encode(updated)
	default:
		return "", &mcpToolError{http.StatusBadRequest, "unknown tool: " + name}
	}
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
			return store.AgentSession{}, nil, &mcpToolError{http.StatusForbidden, err.Error()}
		}
		input.ParentSessionID = actor.Identity.SessionID
		input.Source = "agent"
		// Without a choice, a child runs like its parent: the same profile in
		// the same workspace; elsewhere only the same runtime, since profiles
		// belong to a device.
		if input.ProfileID == "" && input.Provider == "" {
			if parent, err := s.store.GetAgentSessionSummary(r.Context(), input.ParentSessionID); err == nil {
				input.Provider = parent.Provider
				if input.WorkspaceID == parent.WorkspaceID {
					input.ProfileID = parent.ProfileID
				}
			}
		}
	}
	if input.Verification {
		input.Source = verificationSource
	}
	if strings.TrimSpace(input.ForkSessionID) != "" {
		if status, forkErr := s.applySessionFork(r, &input, actor); forkErr != nil {
			return store.AgentSession{}, nil, &mcpToolError{status, forkErr.Error()}
		}
	}
	session, delivered, err := s.createSessionForMCP(r, actor, input, attachments)
	if err != nil || !wait {
		return session, delivered, err
	}
	session, err = s.waitMCPTerminal(r.Context(), session.ID, timeoutMs)
	return session, delivered, err
}

// mcpDeviceID is the device a profile tool reads: the named one, else the
// caller's own (a session token's device, or the calling device).
func mcpDeviceID(actor Actor, args map[string]json.RawMessage) string {
	if deviceID := mcpArgString(args, "deviceId"); deviceID != "" {
		return deviceID
	}
	if actor.Agent() {
		return actor.Identity.DeviceID
	}
	return actor.DeviceID
}

// authorizeMCPTool applies workspace and device reach to every actor;
// per-session tools are checked by canReadSession / canControlSession.
func (s *Server) authorizeMCPTool(r *http.Request, actor Actor, name, workspace string, args map[string]json.RawMessage) error {
	view, err := s.visibilityFor(r.Context(), actor)
	if err != nil {
		return err
	}
	switch name {
	case "list_profiles", "list_models":
		if !view.seesDevice(mcpDeviceID(actor, args)) {
			return &mcpToolError{http.StatusNotFound, "device not found"}
		}
	case "list_sessions", "list_group_sessions", "list_issues":
		if name == "list_sessions" && mcpArgString(args, "parentSessionId") != "" && mcpArgString(args, "workspaceId") == "" {
			// The parent's workspace, which reading the parent checks.
			return nil
		}
		if workspace == "" {
			return &mcpToolError{http.StatusBadRequest, "workspaceId is required"}
		}
		if !view.scope.can(workspace, store.WorkspaceRoleViewer) {
			return &mcpToolError{http.StatusNotFound, "workspace not found"}
		}
	}
	return nil
}

// createSessionForMCP mirrors handleCreateAgentSession's resolution and
// dispatch without an HTTP body, including post-create group naming. Files
// it hands over are published only once the store took the session.
func (s *Server) createSessionForMCP(r *http.Request, actor Actor, input store.CreateAgentSessionInput, attachments []string) (store.AgentSession, []store.ChatAttachment, error) {
	ctx := r.Context()
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return store.AgentSession{}, nil, err
	}
	if !scope.can(input.WorkspaceID, store.WorkspaceRoleMember) {
		return store.AgentSession{}, nil, &mcpToolError{http.StatusNotFound, "workspace not found"}
	}
	if !actor.Agent() {
		input.CreatedByUserID = actor.AccountID()
	}
	if status, err := s.resolveSessionDevice(ctx, &input); err != nil {
		if status == 0 {
			return store.AgentSession{}, nil, err
		}
		return store.AgentSession{}, nil, &mcpToolError{status, err.Error()}
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
		return session, handed.list(), &mcpToolError{http.StatusConflict, err.Error()}
	}
	return session, handed.list(), err
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
	full, err := store.AgentSessionRecord(ctx, s.store, summary.ID)
	if err != nil {
		return summary, nil
	}
	summary.Response = full.Response
	summary.Error = full.Error
	return summary, nil
}

// listResourcesForMCP is the Resource Pool directory as an agent sees it:
// every device it can reach, what each offers, whether it is online, and the
// workspaces on it where the agent may start a session.
func (s *Server) listResourcesForMCP(r *http.Request, actor Actor, kind string) (string, error) {
	view, err := s.visibilityFor(r.Context(), actor)
	if err != nil {
		return "", err
	}
	devices, err := s.store.ListDevices(r.Context())
	if err != nil {
		return "", err
	}
	all, err := s.store.ListWorkspaces(r.Context())
	if err != nil {
		return "", err
	}
	type workspaceOnDevice struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		AccessRole string `json:"accessRole"`
	}
	type deviceResources struct {
		DeviceID    string                 `json:"deviceId"`
		DeviceLabel string                 `json:"deviceLabel"`
		Online      bool                   `json:"online"`
		Workspaces  []workspaceOnDevice    `json:"workspaces"`
		Resources   []store.DeviceResource `json:"resources"`
	}
	reachable := view.scope.filterWorkspaces(all)
	result := []deviceResources{}
	for _, device := range view.filterDevices(devices) {
		if device.Status == "removed" {
			continue
		}
		entry := deviceResources{
			DeviceID: device.ID, DeviceLabel: device.Label, Online: s.hub.HasConnection(device.ID),
			Workspaces: []workspaceOnDevice{}, Resources: []store.DeviceResource{},
		}
		for _, workspace := range reachable {
			if workspace.DeviceID == device.ID {
				entry.Workspaces = append(entry.Workspaces, workspaceOnDevice{workspace.ID, workspace.Name, workspace.AccessRole})
			}
		}
		for _, resource := range device.Resources {
			if kind == "" || resource.Kind == kind {
				entry.Resources = append(entry.Resources, resource)
			}
		}
		result = append(result, entry)
	}
	raw, err := json.MarshalIndent(result, "", "  ")
	return string(raw), err
}

// maxMCPWaitMs bounds one waiting tool call. The worker gives the agent's MCP
// client a longer limit (foundryToolTimeoutMs), so the server always answers
// first; a caller that needs longer waits again.
const maxMCPWaitMs = 600_000

func mcpWaitMs(args map[string]json.RawMessage) int {
	wait := mcpArgNumber(args, "timeoutMs", maxMCPWaitMs)
	if wait <= 0 || wait > maxMCPWaitMs {
		return maxMCPWaitMs
	}
	return wait
}
