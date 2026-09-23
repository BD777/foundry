package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// workspaceMemberView is one member as the workspace's members see them.
type workspaceMemberView struct {
	UserID      string    `json:"userId"`
	Username    string    `json:"username"`
	DisplayName string    `json:"displayName"`
	Role        string    `json:"role"`
	Disabled    bool      `json:"disabled,omitempty"`
	DeviceOwner bool      `json:"deviceOwner,omitempty"`
	AddedAt     time.Time `json:"addedAt"`
}

type workspaceMembersUpdated struct {
	WorkspaceID string `json:"workspaceId"`
}

var (
	errDeviceOwnerStaysOwner = errors.New("the device owner always stays an Owner of its workspaces")
	errLastWorkspaceOwner    = errors.New("a workspace needs at least one Owner")
)

func (s *Server) ownershipStore(w http.ResponseWriter) (store.OwnershipStore, bool) {
	ownership, ok := s.store.(store.OwnershipStore)
	if !ok || s.accounts == nil {
		writeError(w, http.StatusServiceUnavailable, errNoOwnershipStore.Error())
		return nil, false
	}
	return ownership, true
}

func (s *Server) handleListWorkspaceMembers(w http.ResponseWriter, r *http.Request) {
	ownership, ok := s.ownershipStore(w)
	if !ok {
		return
	}
	workspaceID := r.PathValue("id")
	members, err := ownership.ListWorkspaceMembers(r.Context(), workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	deviceOwner, err := s.workspaceDeviceOwner(r.Context(), workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	views := make([]workspaceMemberView, 0, len(members))
	for _, member := range members {
		user, err := s.accounts.GetUser(r.Context(), member.UserID)
		if err != nil {
			continue
		}
		views = append(views, workspaceMemberView{
			UserID: user.ID, Username: user.Username, DisplayName: user.DisplayName,
			Role: member.Role, Disabled: !user.Active(), DeviceOwner: user.ID == deviceOwner,
			AddedAt: member.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, views)
}

func (s *Server) handleAddWorkspaceMember(w http.ResponseWriter, r *http.Request) {
	ownership, ok := s.ownershipStore(w)
	if !ok {
		return
	}
	var input struct {
		Username string `json:"username"`
		Role     string `json:"role"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !store.ValidWorkspaceRole(input.Role) {
		writeError(w, http.StatusBadRequest, "role must be viewer, member, maintainer or owner")
		return
	}
	username := strings.TrimSpace(input.Username)
	user, _, err := s.accounts.GetUserCredentials(r.Context(), username)
	if err != nil || !user.Active() {
		writeError(w, http.StatusNotFound, "No active account is named "+username+".")
		return
	}
	workspaceID := r.PathValue("id")
	current, err := s.memberRole(r.Context(), ownership, workspaceID, user.ID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if current != "" {
		writeError(w, http.StatusConflict, user.Username+" is already a member; change their role instead")
		return
	}
	actor := actorFromContext(r.Context())
	if err := ownership.SetWorkspaceMember(r.Context(), workspaceID, user.ID, input.Role, actor.AccountID()); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.afterMembershipChange(r.Context(), workspaceID, user.ID, input.Role)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUpdateWorkspaceMember(w http.ResponseWriter, r *http.Request) {
	ownership, ok := s.ownershipStore(w)
	if !ok {
		return
	}
	var input struct {
		Role string `json:"role"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !store.ValidWorkspaceRole(input.Role) {
		writeError(w, http.StatusBadRequest, "role must be viewer, member, maintainer or owner")
		return
	}
	workspaceID, userID := r.PathValue("id"), r.PathValue("userId")
	current, err := s.memberRole(r.Context(), ownership, workspaceID, userID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if current == "" {
		writeError(w, http.StatusNotFound, "not a member of this workspace")
		return
	}
	if input.Role != store.WorkspaceRoleOwner {
		if err := s.checkOwnerCanLeave(r.Context(), ownership, workspaceID, userID, current); err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
	}
	actor := actorFromContext(r.Context())
	if err := ownership.SetWorkspaceMember(r.Context(), workspaceID, userID, input.Role, actor.AccountID()); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.afterMembershipChange(r.Context(), workspaceID, userID, input.Role)
	w.WriteHeader(http.StatusNoContent)
}

// handleRemoveWorkspaceMember lets an Owner remove anyone and any member
// leave on their own.
func (s *Server) handleRemoveWorkspaceMember(w http.ResponseWriter, r *http.Request) {
	ownership, ok := s.ownershipStore(w)
	if !ok {
		return
	}
	workspaceID, userID := r.PathValue("id"), r.PathValue("userId")
	actor := actorFromContext(r.Context())
	need := store.WorkspaceRoleOwner
	if actor.Account != nil && actor.Kind == ActorAccount && actor.AccountID() == userID {
		need = store.WorkspaceRoleViewer
	}
	if !s.requireWorkspace(w, r, workspaceID, need) {
		return
	}
	current, err := s.memberRole(r.Context(), ownership, workspaceID, userID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if current == "" {
		writeError(w, http.StatusNotFound, "not a member of this workspace")
		return
	}
	if err := s.checkOwnerCanLeave(r.Context(), ownership, workspaceID, userID, current); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if err := ownership.RemoveWorkspaceMember(r.Context(), workspaceID, userID); err != nil {
		writeResult(w, nil, err)
		return
	}
	s.afterMembershipChange(r.Context(), workspaceID, userID, "")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) memberRole(ctx context.Context, ownership store.OwnershipStore, workspaceID, userID string) (string, error) {
	roles, err := ownership.WorkspaceRolesForUser(ctx, userID)
	if err != nil {
		return "", err
	}
	return roles[workspaceID], nil
}

// checkOwnerCanLeave keeps the ownership invariants when an Owner is demoted
// or removed: the device owner stays, and one Owner always remains.
func (s *Server) checkOwnerCanLeave(ctx context.Context, ownership store.OwnershipStore, workspaceID, userID, current string) error {
	if current != store.WorkspaceRoleOwner {
		return nil
	}
	deviceOwner, err := s.workspaceDeviceOwner(ctx, workspaceID)
	if err != nil {
		return err
	}
	if deviceOwner == userID {
		return errDeviceOwnerStaysOwner
	}
	members, err := ownership.ListWorkspaceMembers(ctx, workspaceID)
	if err != nil {
		return err
	}
	for _, member := range members {
		if member.UserID != userID && member.Role == store.WorkspaceRoleOwner {
			return nil
		}
	}
	return errLastWorkspaceOwner
}

func (s *Server) workspaceDeviceOwner(ctx context.Context, workspaceID string) (string, error) {
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	credentials, ok := s.store.(store.DeviceCredentialStore)
	if !ok || workspace.DeviceID == "" {
		return "", nil
	}
	return credentials.DeviceOwner(ctx, workspace.DeviceID)
}

// afterMembershipChange makes a new role take effect at once: the account's
// event streams reconnect with the new reach, and when it can no longer run
// in the workspace its running sessions there are canceled.
func (s *Server) afterMembershipChange(ctx context.Context, workspaceID, userID, role string) {
	s.events.Reauthorize(userID)
	if !roleAtLeast(role, store.WorkspaceRoleMember) {
		s.cancelSessionsStartedBy(ctx, workspaceID, userID, "Canceled: the account that started it can no longer run in this workspace")
	}
	s.events.Publish("workspace_members_updated", workspaceMembersUpdated{WorkspaceID: workspaceID})
}

// cancelAllSessionsStartedBy stops a disabled account's running sessions in
// every workspace it belongs to.
func (s *Server) cancelAllSessionsStartedBy(ctx context.Context, userID string) {
	ownership, ok := s.store.(store.OwnershipStore)
	if !ok {
		return
	}
	roles, err := ownership.WorkspaceRolesForUser(ctx, userID)
	if err != nil {
		log.Printf("cancel sessions of disabled account %s: %v", userID, err)
		return
	}
	for workspaceID := range roles {
		s.cancelSessionsStartedBy(ctx, workspaceID, userID, "Canceled: the account that started it was disabled")
	}
}

func (s *Server) cancelSessionsStartedBy(ctx context.Context, workspaceID, userID, reason string) {
	summaries, err := s.store.ListAgentSessionSummaries(ctx, workspaceID)
	if err != nil {
		log.Printf("cancel sessions of %s in %s: %v", userID, workspaceID, err)
		return
	}
	for _, summary := range summaries {
		if summary.CreatedByUserID != userID || !activeOrBlocked(summary.Status) {
			continue
		}
		session, err := s.store.GetAgentSession(ctx, summary.ID)
		if err != nil {
			log.Printf("cancel session %s: %v", summary.ID, err)
			continue
		}
		if s.hub.HasConnection(session.DeviceID) {
			cancelCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
			if err := s.hub.CancelAgentSession(cancelCtx, session); err != nil {
				log.Printf("stop session %s on its device: %v", session.ID, err)
			}
			cancel()
		}
		canceled, err := s.store.CancelAgentSession(ctx, session.ID, reason)
		if err != nil {
			log.Printf("cancel session %s: %v", session.ID, err)
			continue
		}
		s.events.Publish("agent_session_completed", canceled)
	}
}
