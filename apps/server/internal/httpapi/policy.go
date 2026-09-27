package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Policy for session-scoped actors. An agent acts inside its session's
// workspace, where it may read and control any session: the user names the
// target in conversation. Lineage is a record, never a permission. People are
// judged by their workspace role. All checks live here so handlers stay free
// of policy.

// agentRouteAllowed is the exact endpoint surface a session token may touch.
// Anything else returns 403 even before reaching a handler.
func agentRouteAllowed(method string, path string) bool {
	switch {
	case method == http.MethodGet && (path == "/api/agent-sessions" ||
		path == "/api/chats" ||
		path == "/api/chat-layout" ||
		path == "/api/chat-titles" ||
		path == "/api/agent-profiles" ||
		path == "/api/agents" ||
		path == "/api/foundry-data" ||
		path == "/api/events"):
		return true
	case method == http.MethodGet && strings.HasPrefix(path, "/api/agent-sessions/"):
		rest := strings.TrimPrefix(path, "/api/agent-sessions/")
		return rest != "" && !strings.Contains(rest, "/") ||
			strings.HasSuffix(rest, "/subagents") ||
			strings.Contains(rest, "/subagents/")
	case method == http.MethodGet && strings.HasPrefix(path, "/api/agent-session-threads/"):
		return strings.TrimPrefix(path, "/api/agent-session-threads/") != ""
	case method == http.MethodGet && strings.HasPrefix(path, "/api/chats/"):
		return strings.TrimPrefix(path, "/api/chats/") != ""
	case method == http.MethodPost && path == "/api/agent-sessions":
		return true
	case method == http.MethodPost && path == "/api/mcp":
		return true
	case method == http.MethodPost && strings.HasPrefix(path, "/api/agent-sessions/"):
		rest := strings.TrimPrefix(path, "/api/agent-sessions/")
		return strings.HasSuffix(rest, "/messages") || strings.HasSuffix(rest, "/cancel")
	case method == http.MethodPost && strings.HasPrefix(path, "/api/chats/"):
		return strings.HasSuffix(path, "/title")
	case method == http.MethodPost && path == "/api/agent-profiles/models":
		return true
	default:
		return false
	}
}

// enforceAgentRoute is middleware for the narrow session-token endpoint set.
func enforceAgentRoute(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		actor := actorFromContext(r.Context())
		if actor.Agent() && !agentRouteAllowed(r.Method, r.URL.Path) {
			writeForbidden(w, "session token cannot access this endpoint")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// effectiveWorkspace narrows a request's workspace to the actor's scope. An
// empty request takes the actor workspace; a different workspace is forbidden.
func effectiveWorkspace(actor Actor, requested string) (string, bool) {
	requested = strings.TrimSpace(requested)
	if !actor.Agent() {
		return requested, true
	}
	scope := actor.Identity.WorkspaceID
	if requested == "" || requested == scope {
		return scope, true
	}
	return "", false
}

func (s *Server) canReadSession(ctx context.Context, actor Actor, target store.AgentSession) bool {
	if actor.Agent() {
		return target.WorkspaceID == actor.Identity.WorkspaceID
	}
	scope, err := s.contextScope(ctx, actor)
	return err == nil && scope.can(target.WorkspaceID, store.WorkspaceRoleViewer)
}

// canControlSession: an agent controls any session of its workspace; people
// steer and cancel their own sessions as members and anyone's as maintainers.
func (s *Server) canControlSession(ctx context.Context, actor Actor, target store.AgentSession) bool {
	if actor.Agent() {
		return target.WorkspaceID == actor.Identity.WorkspaceID
	}
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return false
	}
	if target.CreatedByUserID != "" && target.CreatedByUserID == scope.userID {
		return scope.can(target.WorkspaceID, store.WorkspaceRoleMember)
	}
	return scope.can(target.WorkspaceID, store.WorkspaceRoleMaintainer)
}

// canReadNativeChat mirrors canReadSession for daemon-projected native chats.
func (s *Server) canReadNativeChat(ctx context.Context, actor Actor, workspaceID, chatID string) bool {
	if actor.Agent() {
		return workspaceID == actor.Identity.WorkspaceID
	}
	scope, err := s.contextScope(ctx, actor)
	return err == nil && scope.can(workspaceID, store.WorkspaceRoleViewer)
}
