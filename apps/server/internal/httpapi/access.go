package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Workspace role order, least to most authority.
var workspaceRoleRank = map[string]int{
	store.WorkspaceRoleViewer:     1,
	store.WorkspaceRoleMember:     2,
	store.WorkspaceRoleMaintainer: 3,
	store.WorkspaceRoleOwner:      4,
}

func roleLabel(role string) string {
	if role == "" {
		return role
	}
	return strings.ToUpper(role[:1]) + role[1:]
}

func roleAtLeast(have, need string) bool {
	return workspaceRoleRank[have] >= workspaceRoleRank[need] && workspaceRoleRank[need] > 0
}

// accessScope is what one actor may reach: its workspace roles and the
// devices it owns. Permissions come only from workspace membership and device
// ownership; the instance admin role manages accounts, not other people's
// workspaces.
type accessScope struct {
	userID string
	admin  bool
	roles  map[string]string
	owned  map[string]bool
	// all is set only for package-test servers (testFullAccess).
	all bool
}

func (a accessScope) role(workspaceID string) string {
	if a.all {
		return store.WorkspaceRoleOwner
	}
	return a.roles[workspaceID]
}

func (a accessScope) can(workspaceID, need string) bool {
	return workspaceID != "" && roleAtLeast(a.role(workspaceID), need)
}

func (a accessScope) ownsDevice(deviceID string) bool {
	return deviceID != "" && (a.all || a.owned[deviceID])
}

// fingerprint changes whenever the reachable set changes, so cached
// projections never outlive a membership change.
func (a accessScope) fingerprint() string {
	parts := []string{a.userID}
	for workspaceID, role := range a.roles {
		parts = append(parts, "w:"+workspaceID+"="+role)
	}
	for deviceID := range a.owned {
		parts = append(parts, "d:"+deviceID)
	}
	sort.Strings(parts[1:])
	sum := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(sum[:8])
}

var errNoOwnershipStore = errors.New("this server's store does not support ownership")

// scopeFor computes the actor's access. A device credential acts as its
// owner, limited to the workspaces on that device. An agent acts as the
// account that started its session, limited to its own workspace and never
// above member.
func (s *Server) scopeFor(ctx context.Context, actor Actor) (accessScope, error) {
	ownership, ok := s.store.(store.OwnershipStore)
	if !ok {
		return accessScope{}, errNoOwnershipStore
	}
	switch actor.Kind {
	case ActorAgent:
		return s.agentScope(ctx, ownership, actor)
	case ActorAccount, ActorDaemon:
	default:
		return accessScope{roles: map[string]string{}, owned: map[string]bool{}}, nil
	}
	if actor.Account == nil {
		return accessScope{roles: map[string]string{}, owned: map[string]bool{}}, nil
	}
	if s.testFullAccess && s.testActor != nil && actor.Account == s.testActor.Account {
		return s.fullScopeForTests(ctx, actor.Account.ID)
	}
	scope := accessScope{userID: actor.Account.ID, admin: actor.Account.Role == store.RoleAdmin, owned: map[string]bool{}}
	roles, err := ownership.WorkspaceRolesForUser(ctx, scope.userID)
	if err != nil {
		return accessScope{}, err
	}
	scope.roles = roles
	devices, err := ownership.DevicesOwnedBy(ctx, scope.userID)
	if err != nil {
		return accessScope{}, err
	}
	for _, deviceID := range devices {
		scope.owned[deviceID] = true
	}
	if actor.Kind == ActorDaemon && actor.DeviceID != "" {
		if err := s.limitToDevice(ctx, &scope, actor.DeviceID); err != nil {
			return accessScope{}, err
		}
	}
	return scope, nil
}

func (s *Server) limitToDevice(ctx context.Context, scope *accessScope, deviceID string) error {
	workspaces, err := s.store.ListWorkspaces(ctx)
	if err != nil {
		return err
	}
	onDevice := map[string]bool{}
	for _, workspace := range workspaces {
		if workspace.DeviceID == deviceID {
			onDevice[workspace.ID] = true
		}
	}
	for workspaceID := range scope.roles {
		if !onDevice[workspaceID] {
			delete(scope.roles, workspaceID)
		}
	}
	scope.owned = map[string]bool{deviceID: scope.owned[deviceID]}
	scope.admin = false
	return nil
}

func (s *Server) agentScope(ctx context.Context, ownership store.OwnershipStore, actor Actor) (accessScope, error) {
	workspaceID := actor.Identity.WorkspaceID
	scope := accessScope{roles: map[string]string{}, owned: map[string]bool{}}
	session, err := s.store.GetAgentSession(ctx, actor.Identity.SessionID)
	if err != nil {
		return scope, nil
	}
	role := store.WorkspaceRoleMember
	testCreator := s.testFullAccess && s.testActor != nil && s.testActor.Account != nil &&
		session.CreatedByUserID == s.testActor.Account.ID
	if creator := session.CreatedByUserID; creator != "" && !testCreator {
		scope.userID = creator
		// A disabled account's agents lose access with it.
		if s.accounts != nil {
			if user, err := s.accounts.GetUser(ctx, creator); err != nil || !user.Active() {
				return scope, nil
			}
		}
		roles, err := ownership.WorkspaceRolesForUser(ctx, creator)
		if err != nil {
			return accessScope{}, err
		}
		role = roles[workspaceID]
		if roleAtLeast(role, store.WorkspaceRoleMaintainer) {
			role = store.WorkspaceRoleMember
		}
	}
	if role != "" {
		scope.roles[workspaceID] = role
	}
	return scope, nil
}

// requestScope computes the scope once per request.
func (s *Server) requestScope(r *http.Request) (accessScope, error) {
	if cached, ok := r.Context().Value(scopeContextKey{}).(accessScope); ok {
		return cached, nil
	}
	return s.scopeFor(r.Context(), actorFromContext(r.Context()))
}

type scopeContextKey struct{}

func contextWithScope(ctx context.Context, scope accessScope) context.Context {
	return context.WithValue(ctx, scopeContextKey{}, scope)
}

func (s *Server) contextScope(ctx context.Context, actor Actor) (accessScope, error) {
	if cached, ok := ctx.Value(scopeContextKey{}).(accessScope); ok {
		return cached, nil
	}
	return s.scopeFor(ctx, actor)
}

// requireWorkspace answers 404 when the workspace is not visible at all (so
// existence does not leak) and 403 when visible without the needed role.
func (s *Server) requireWorkspace(w http.ResponseWriter, r *http.Request, workspaceID, need string) bool {
	scope, err := s.requestScope(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve access")
		return false
	}
	have := scope.role(workspaceID)
	if actor := actorFromContext(r.Context()); actor.Agent() && workspaceID != actor.Identity.WorkspaceID {
		writeForbidden(w, "workspace is outside the token's scope")
		return false
	}
	if have == "" {
		writeError(w, http.StatusNotFound, "not found")
		return false
	}
	if !roleAtLeast(have, need) {
		writeForbidden(w, "You are a "+roleLabel(have)+" in this workspace; this action needs "+roleLabel(need)+" or higher.")
		return false
	}
	return true
}

// visibleDevices are the devices a scope may see: those it owns and those
// hosting a workspace it can view.
func (a accessScope) visibleDevices(workspaces []store.WorkspaceProjection) map[string]bool {
	visible := map[string]bool{}
	for deviceID := range a.owned {
		visible[deviceID] = true
	}
	for _, workspace := range workspaces {
		if workspace.DeviceID != "" && a.can(workspace.ID, store.WorkspaceRoleViewer) {
			visible[workspace.DeviceID] = true
		}
	}
	return visible
}

func (a accessScope) filterWorkspaces(workspaces []store.WorkspaceProjection) []store.WorkspaceProjection {
	visible := []store.WorkspaceProjection{}
	for _, workspace := range workspaces {
		if a.can(workspace.ID, store.WorkspaceRoleViewer) {
			workspace.AccessRole = a.role(workspace.ID)
			visible = append(visible, workspace)
		}
	}
	return visible
}
