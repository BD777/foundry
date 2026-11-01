package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Policy for session-scoped actors. An agent reaches the workspaces its
// scope grants (agentScope, access.go): it reads any session there and
// controls the sessions its person started, which include every session
// their agents started (children inherit their parent's creator). Lineage
// is a record, never a permission. People are judged by their workspace
// role. All checks live here so handlers stay free of policy.

// onlyAgentRoutes refuses a session token any request that does not match a
// route marked agent in routeTable, before the route (or the mux) answers.
func onlyAgentRoutes(mux *http.ServeMux, agentRoutes map[string]bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if actorFromContext(r.Context()).Agent() {
			if _, pattern := mux.Handler(r); !agentRoutes[pattern] {
				writeForbidden(w, "session token cannot access this endpoint")
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

// requestedWorkspace is the workspace a request names; an agent that names
// none means its own. Whether the actor reaches it is the route's access rule.
func requestedWorkspace(actor Actor, requested string) string {
	requested = strings.TrimSpace(requested)
	if requested == "" && actor.Agent() {
		return actor.Identity.WorkspaceID
	}
	return requested
}

func (s *Server) canReadSession(ctx context.Context, actor Actor, target store.AgentSession) bool {
	scope, err := s.contextScope(ctx, actor)
	return err == nil && scope.can(target.WorkspaceID, store.WorkspaceRoleViewer)
}

// canControlSession: an agent controls its person's sessions where it
// reaches Member; people steer and cancel their own sessions as members and
// anyone's as maintainers.
func (s *Server) canControlSession(ctx context.Context, actor Actor, target store.AgentSession) bool {
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return false
	}
	// An agent controls the sessions its person started in a workspace it
	// reaches as a member, never more than that person could as a Member;
	// an agent working in an Issue, only that Issue's sessions.
	if actor.Agent() {
		return scope.can(target.WorkspaceID, store.WorkspaceRoleMember) &&
			(scope.issueID == "" || target.IssueID == scope.issueID) &&
			target.CreatedByUserID == scope.agentFor
	}
	if target.CreatedByUserID != "" && target.CreatedByUserID == scope.userID {
		return scope.can(target.WorkspaceID, store.WorkspaceRoleMember)
	}
	return scope.can(target.WorkspaceID, store.WorkspaceRoleMaintainer)
}

// errOutsideIssue refuses a session an Issue's agent would start elsewhere.
var errOutsideIssue = errors.New("an agent working in an Issue starts sessions only inside that Issue")

// keepAgentInIssue makes a session an Issue's agent starts work in the same
// Issue candidate and workspace; naming another Issue or workspace is refused.
func (s *Server) keepAgentInIssue(ctx context.Context, actor Actor, input *store.CreateAgentSessionInput) error {
	if !actor.Agent() {
		return nil
	}
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return err
	}
	if scope.issueID == "" {
		return nil
	}
	if (input.IssueID != "" && input.IssueID != scope.issueID) ||
		(input.WorkspaceID != "" && input.WorkspaceID != actor.Identity.WorkspaceID) {
		return errOutsideIssue
	}
	input.IssueID = scope.issueID
	input.WorkspaceID = actor.Identity.WorkspaceID
	return nil
}

// canReadNativeChat mirrors canReadSession for daemon-projected native chats.
func (s *Server) canReadNativeChat(ctx context.Context, actor Actor, workspaceID, chatID string) bool {
	scope, err := s.contextScope(ctx, actor)
	return err == nil && scope.can(workspaceID, store.WorkspaceRoleViewer)
}

// canArchiveNativeChat decides who archives or restores a native chat, which
// records no Foundry author. A person archives any chat of a workspace they
// reach as Member; an agent, outside an Issue, only the native chats of a
// workspace whose device its person paired.
func (s *Server) canArchiveNativeChat(ctx context.Context, actor Actor, workspaceID string) bool {
	scope, err := s.contextScope(ctx, actor)
	if err != nil || !scope.can(workspaceID, store.WorkspaceRoleMember) {
		return false
	}
	if !actor.Agent() {
		return true
	}
	if scope.issueID != "" || scope.agentFor == "" {
		return false
	}
	owner, err := s.workspaceDeviceOwner(ctx, workspaceID)
	return err == nil && owner == scope.agentFor
}
