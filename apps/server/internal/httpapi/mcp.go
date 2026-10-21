package httpapi

import (
	"cmp"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The Foundry tools over MCP's Streamable HTTP (POST /api/mcp): one catalog
// (mcp_tools.json) and one policy for every caller, whether the stdio bridge
// `foundry mcp` and the `foundry` CLI on a device (packages/worker
// foundry-mcp.ts, foundry-client.ts) or a remote MCP client. Callers
// authenticate as on any route: a session token acts as the account that
// started its session, its role narrowing the tools (mcpToolAvailability);
// a device credential or a signed-in person acts as that account. Each tool
// checks the caller's reach itself. Responses are plain JSON-RPC over HTTP;
// long waits are server-side polls bounded by maxMCPWaitMs.

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
			role, verifier = s.sessionRole(ctx, session), session.Source == verificationSource
		}
	}
	return func(name string) error { return mcpToolAllowed(role, verifier, name) }
}

// mcpToolAllowed is the rule mcpToolAvailability applies to a session of
// one role ("" for a chat, the sessions agents start and people at a shell).
func mcpToolAllowed(role string, verifier bool, name string) error {
	if role == store.AgentSessionRoleIssueClarification && !clarificationMCPTools[name] {
		return &statusError{http.StatusForbidden, errors.New(name + " is not available to an Issue's clarification: it reads sessions with list_sessions and read_context")}
	}
	if verifier && !readOnlyMCPTool(name) {
		return &statusError{http.StatusForbidden, errors.New(name + " is not available to a verifier: it checks work with the Foundry tools that only read, and reports what it found to whoever started it")}
	}
	if name == "ask_person" && role != store.AgentSessionRoleIssueExecution {
		return &statusError{http.StatusForbidden, errors.New("only an Issue's execution can ask the person; say what you need in your reply to whoever started you")}
	}
	if personalAgentMCPTools[name] && role != store.AgentSessionRolePersonalAgent {
		return &statusError{http.StatusForbidden, errors.New(name + " is only available to the person's assistant")}
	}
	if assistantWithheldMCPTools[name] && role == store.AgentSessionRolePersonalAgent {
		return &statusError{http.StatusForbidden, errors.New(name + " is not available to the person's assistant: hand work that needs a device's resources or Feishu events to a session in a project there")}
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
	// Session tokens reach this route (agentRouteAllowed); each tool checks
	// the actor's reach itself.
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
		content, err := s.executeMCPToolContent(r, params.Name, params.Arguments)
		// A session holding resources hears what happens to them with
		// whatever tool it calls next.
		notices := s.resourceNoticeContent(r.Context(), actorFromContext(r.Context()))
		if err != nil {
			status, message := cmp.Or(errorStatus(err), http.StatusConflict), err.Error()
			var structured interface{ mcpText() string }
			if errors.As(err, &structured) {
				message = structured.mcpText()
			}
			if status == http.StatusUnauthorized || status == http.StatusForbidden {
				s.writeMCPError(w, request.ID, -32600, message)
				return
			}
			// A failed tool call is a result the agent can read and act on.
			s.writeMCPResult(w, request.ID, map[string]any{
				"content": append([]any{map[string]any{"type": "text", "text": message}}, notices...),
				"isError": true,
			})
			return
		}
		s.writeMCPResult(w, request.ID, map[string]any{"content": append(content, notices...)})
	default:
		s.writeMCPError(w, request.ID, -32601, "method not found: "+request.Method)
	}
}

// mcpCall is one tool call that passed preflight: the caller, the workspace
// the tool acts on and its arguments.
type mcpCall struct {
	r         *http.Request
	actor     Actor
	workspace string
	args      map[string]json.RawMessage
}

// mcpToolHandler runs a tool and answers its MCP content.
type mcpToolHandler func(s *Server, call mcpCall) ([]any, error)

// mcpTextTool is a tool that answers one text block.
func mcpTextTool(run func(s *Server, call mcpCall) (string, error)) mcpToolHandler {
	return func(s *Server, call mcpCall) ([]any, error) {
		text, err := run(s, call)
		if err != nil {
			return nil, err
		}
		return []any{map[string]any{"type": "text", "text": text}}, nil
	}
}

// mcpRequestTool is a text tool implemented on the request, the caller and
// the arguments.
func mcpRequestTool(run func(s *Server, r *http.Request, actor Actor, args map[string]json.RawMessage) (string, error)) mcpToolHandler {
	return mcpTextTool(func(s *Server, call mcpCall) (string, error) { return run(s, call.r, call.actor, call.args) })
}

// mcpToolHandlers implement the catalog in mcp_tools.json, one per tool.
var mcpToolHandlers = map[string]mcpToolHandler{
	"list_workspaces":  mcpTextTool((*Server).listWorkspacesForMCP),
	"list_resources":   mcpTextTool((*Server).listResourcesForMCP),
	"acquire_resource": mcpRequestTool((*Server).acquireResourceForMCP),
	"operate_resource": func(s *Server, call mcpCall) ([]any, error) {
		return s.operateResourceForMCP(call.r, call.actor, call.args)
	},
	"release_resource":    mcpRequestTool((*Server).releaseResourceForMCP),
	"resource_status":     mcpRequestTool((*Server).resourceStatusForMCP),
	"list_profiles":       mcpTextTool((*Server).listProfilesForMCP),
	"list_models":         mcpTextTool((*Server).listModelsForMCP),
	"create_session":      mcpTextTool((*Server).createSessionForMCP),
	"handoff_session":     mcpTextTool((*Server).handoffSessionForMCP),
	"list_sessions":       mcpTextTool((*Server).listSessionsForMCP),
	"list_group_sessions": mcpTextTool((*Server).listGroupSessionsForMCP),
	"get_session": mcpTextTool(func(s *Server, call mcpCall) (string, error) {
		return s.sessionDigestForMCP(call.r.Context(), call.actor, mcpArgString(call.args, "sessionId"))
	}),
	"read_context":             mcpTextTool((*Server).readContextForMCP),
	"refresh_workspace_skills": mcpTextTool((*Server).refreshWorkspaceSkillsForMCP),
	"list_session_work":        mcpTextTool((*Server).listWorkForMCP),
	"get_session_work":         mcpTextTool((*Server).listWorkForMCP),
	"control_session_work":     mcpTextTool((*Server).controlWorkForMCP),
	"create_scheduled_work":    mcpTextTool((*Server).createWorkForMCP),
	"list_issues": mcpTextTool(func(s *Server, call mcpCall) (string, error) {
		return s.listIssuesForMCP(call.r.Context(), call.actor, call.workspace, mcpArgList(call.args, "status"))
	}),
	"get_issue": mcpTextTool(func(s *Server, call mcpCall) (string, error) {
		return s.issueForMCP(call.r.Context(), call.actor, mcpArgString(call.args, "issueId"))
	}),
	"send_message":   mcpTextTool((*Server).sendMessageForMCP),
	"cancel_session": mcpTextTool((*Server).cancelSessionForMCP),
	"wait_session":   mcpTextTool((*Server).waitSessionForMCP),
	"rename_session": mcpTextTool((*Server).renameSessionForMCP),
	"ask_person":     mcpRequestTool((*Server).askPersonForMCP),
	"feishu_events":  mcpRequestTool((*Server).feishuEventsForMCP),
	// The Personal Agent's tools (mcp_personal_agent.go).
	"find_workspace":       mcpTextTool((*Server).findWorkspaceForMCP),
	"get_workspace":        mcpTextTool((*Server).getWorkspaceForMCP),
	"create_workspace":     mcpTextTool((*Server).createWorkspaceForMCP),
	"update_workspace":     mcpTextTool((*Server).updateWorkspaceForMCP),
	"archive_workspace":    mcpTextTool((*Server).archiveWorkspaceForMCP),
	"remember":             mcpTextTool((*Server).rememberForMCP),
	"update_rules":         mcpTextTool((*Server).updateRulesForMCP),
	"list_tasks":           mcpTextTool((*Server).listTasksForMCP),
	"read_knowledge":       mcpTextTool((*Server).readKnowledgeForMCP),
	"dispatch_item":        mcpTextTool((*Server).dispatchItemForMCP),
	"cancel_item_dispatch": mcpTextTool((*Server).cancelPendingDispatchForMCP),
	"update_list":          mcpTextTool((*Server).updateListForMCP),
	"read_list":            mcpTextTool((*Server).readListForMCP),
}

// executeMCPToolContent runs a tool and answers its MCP content: one text
// block, or for operate_resource text and images.
func (s *Server) executeMCPToolContent(r *http.Request, name string, args map[string]json.RawMessage) ([]any, error) {
	actor := actorFromContext(r.Context())
	workspace, err := s.mcpToolPreflight(r, actor, name, args)
	if err != nil {
		return nil, err
	}
	handler, ok := mcpToolHandlers[name]
	if !ok {
		return nil, &statusError{http.StatusBadRequest, errors.New("unknown tool: " + name)}
	}
	return handler(s, mcpCall{r, actor, workspace, args})
}

// mcpToolPreflight checks that a tool exists, the caller's role may call it
// and its reach covers what it names; it answers the workspace it acts on.
func (s *Server) mcpToolPreflight(r *http.Request, actor Actor, name string, args map[string]json.RawMessage) (string, error) {
	// A tool acts on the workspace it names; an agent's defaults to its own.
	workspace := mcpArgString(args, "workspaceId")
	if workspace == "" && actor.Agent() {
		workspace = actor.Identity.WorkspaceID
	}
	if !knownMCPTool(name) {
		return "", &statusError{http.StatusBadRequest, errors.New("unknown tool: " + name)}
	}
	if err := s.mcpToolAvailability(r.Context(), actor)(name); err != nil {
		return "", err
	}
	if err := s.authorizeMCPTool(r, actor, name, workspace, args); err != nil {
		return "", err
	}
	return workspace, nil
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
			return &statusError{http.StatusNotFound, errors.New("device not found")}
		}
	case "list_sessions", "list_group_sessions", "list_issues":
		if name == "list_sessions" && mcpArgString(args, "parentSessionId") != "" && mcpArgString(args, "workspaceId") == "" {
			// The parent's workspace, which reading the parent checks.
			return nil
		}
		if workspace == "" {
			return &statusError{http.StatusBadRequest, errors.New("workspaceId is required")}
		}
		if !view.scope.can(workspace, store.WorkspaceRoleViewer) {
			return &statusError{http.StatusNotFound, errors.New("workspace not found")}
		}
	}
	return nil
}

// encodeJSON is a tool's structured answer: indented JSON.
func encodeJSON(value any) (string, error) {
	raw, err := json.MarshalIndent(value, "", "  ")
	return string(raw), err
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
