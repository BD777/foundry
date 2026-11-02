package httpapi

import (
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The Personal Agent's MCP tools (docs/personal-agent.md §5): each resolves
// the calling conversation's scope (paScope), hands its arguments to the
// assistant (personalagent/assistant) and answers what it returns.

// personalAgentMCPTools are the Personal Agent's own tools
// (docs/personal-agent.md §5): only a personal_agent session lists them.
var personalAgentMCPTools = map[string]bool{
	"find_workspace":       true,
	"get_workspace":        true,
	"create_workspace":     true,
	"update_workspace":     true,
	"archive_workspace":    true,
	"remember":             true,
	"update_rules":         true,
	"list_tasks":           true,
	"update_list":          true,
	"dispatch_item":        true,
	"cancel_item_dispatch": true,
	"read_list":            true,
}

// assistantWithheldMCPTools are tools the assistant does not get (§5): work
// needing a device's resources or Feishu events goes to a session in a
// project there.
var assistantWithheldMCPTools = map[string]bool{
	"acquire_resource": true, "operate_resource": true, "release_resource": true, "resource_status": true,
	"feishu_events": true,
}

// workspaceLifecycle is what the assistant's writes apply: the same
// service functions the REST routes call (workspace_lifecycle.go).
type workspaceLifecycle interface {
	CreateWorkspace(ctx context.Context, actor WorkspaceActor, request WorkspaceCreateRequest) (store.WorkspaceProjection, error)
	UpdateWorkspaceDetails(ctx context.Context, actor WorkspaceActor, workspaceID string, details WorkspaceDetails) (store.WorkspaceProjection, error)
	ChangeWorkspaceSkills(ctx context.Context, actor WorkspaceActor, workspaceID string, add, remove []string) ([]store.WorkspaceSkillBinding, error)
	ChangeWorkspaceConnectors(ctx context.Context, actor WorkspaceActor, workspaceID string, add, remove []string) (store.WorkspaceExternalAccounts, error)
	ArchiveWorkspace(ctx context.Context, actor WorkspaceActor, workspaceID string) (store.WorkspaceProjection, error)
	RestoreWorkspace(ctx context.Context, actor WorkspaceActor, workspaceID string) (store.WorkspaceProjection, error)
}

// lifecycleFor is the lifecycle a server applies; tests replace it.
var lifecycleFor = func(s *Server) workspaceLifecycle { return s }

// refuse is personalagent.Refuse: a refusal of kind with status.
func refuse(kind string, status int, format string, args ...any) error {
	return personalagent.Refuse(kind, status, format, args...)
}

// invalid refuses a request whose arguments are wrong (400).
func invalid(format string, args ...any) error { return personalagent.Invalid(format, args...) }

// assistantTool runs one of the assistant's write tools
// (assistant.RunWrite) for the calling conversation.
func (s *Server) assistantTool(call mcpCall, tool string) (string, error) {
	ctx := call.r.Context()
	scope, err := s.paScope(ctx, call.actor)
	if err != nil {
		return "", err
	}
	answer, err := s.assistant.RunTool(ctx, scope, tool, call.args)
	if err != nil {
		return "", err
	}
	return encodeJSON(answer)
}

func (s *Server) createWorkspaceForMCP(call mcpCall) (string, error) {
	return s.assistantTool(call, "create_workspace")
}

func (s *Server) updateWorkspaceForMCP(call mcpCall) (string, error) {
	return s.assistantTool(call, "update_workspace")
}

func (s *Server) archiveWorkspaceForMCP(call mcpCall) (string, error) {
	return s.assistantTool(call, "archive_workspace")
}

func (s *Server) rememberForMCP(call mcpCall) (string, error) {
	return s.assistantTool(call, "remember")
}

func (s *Server) updateRulesForMCP(call mcpCall) (string, error) {
	return s.assistantTool(call, "update_rules")
}

func (s *Server) updateListForMCP(call mcpCall) (string, error) {
	return s.assistantTool(call, "update_list")
}

func (s *Server) listTasksForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	scope, err := s.paScope(ctx, call.actor)
	if err != nil {
		return "", err
	}
	tasks, err := s.assistant.ListTasks(ctx, scope, mcpArgList(call.args, "status"))
	if err != nil {
		return "", err
	}
	return encodeJSON(tasks)
}

func (s *Server) findWorkspaceForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	scope, err := s.paScope(ctx, call.actor)
	if err != nil {
		return "", err
	}
	answer, err := s.assistant.FindWorkspace(ctx, scope, mcpArgString(call.args, "query"), mcpArgNumber(call.args, "limit", 3))
	if err != nil {
		return "", err
	}
	return encodeJSON(answer)
}

func (s *Server) getWorkspaceForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	scope, err := s.paScope(ctx, call.actor)
	if err != nil {
		return "", err
	}
	answer, err := s.assistant.GetWorkspace(ctx, scope, mcpArgString(call.args, "workspaceId"), mcpArgList(call.args, "include"))
	if err != nil {
		return "", err
	}
	return encodeJSON(answer)
}

// readListForMCP is read_list (assistant.ReadList).
func (s *Server) readListForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	scope, err := s.paScope(ctx, call.actor)
	if err != nil {
		return "", err
	}
	answer, err := s.assistant.ReadList(ctx, scope, mcpArgString(call.args, "closedSince"))
	if err != nil {
		return "", err
	}
	return encodeJSON(answer)
}

// dispatchItemForMCP is dispatch_item (assistant.DispatchItem): a session it
// names must be one the caller may control.
func (s *Server) dispatchItemForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	scope, err := s.paScope(ctx, call.actor)
	if err != nil {
		return "", err
	}
	op, err := s.assistant.DispatchItem(ctx, scope, call.args, func(sessionID string) (store.AgentSession, error) {
		return s.controlledSession(ctx, call.actor, sessionID, "continue")
	})
	if err != nil {
		return "", err
	}
	return encodeJSON(op)
}

func (s *Server) cancelPendingDispatchForMCP(call mcpCall) (string, error) {
	scope, e := s.paScope(call.r.Context(), call.actor)
	if e != nil {
		return "", e
	}
	var input struct {
		OperationID string `json:"operationId"`
		Revision    int64  `json:"revision"`
	}
	if e = assistant.DecodeArgs(call.args, &input); e != nil {
		return "", e
	}
	op, e := s.store.CancelPendingPersonalAgentOperation(call.r.Context(), scope.Agent.UserID, input.OperationID, input.Revision)
	if e != nil {
		return "", e
	}
	return encodeJSON(op)
}
