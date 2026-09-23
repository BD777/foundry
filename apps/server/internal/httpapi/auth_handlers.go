package httpapi

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type authStateResponse struct {
	NeedsSetup bool        `json:"needsSetup"`
	User       *store.User `json:"user,omitempty"`
}

func (s *Server) handleAuthState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, authStateResponse{
		NeedsSetup: s.setupPending(r.Context()),
		User:       actorFromContext(r.Context()).Account,
	})
}

type newAccountRequest struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Password    string `json:"password"`
}

func validateNewAccount(w http.ResponseWriter, input newAccountRequest) (store.NewUser, bool) {
	input.Username = strings.TrimSpace(input.Username)
	for _, err := range []error{
		accounts.ValidateUsername(input.Username),
		accounts.ValidateDisplayName(input.DisplayName),
		accounts.ValidatePassword(input.Password),
	} {
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return store.NewUser{}, false
		}
	}
	hash, err := accounts.HashPassword(input.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "hash password")
		return store.NewUser{}, false
	}
	return store.NewUser{Username: input.Username, DisplayName: strings.TrimSpace(input.DisplayName), PasswordHash: hash}, true
}

func writeAccountError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrUsernameTaken), errors.Is(err, store.ErrAccountsInitialized), errors.Is(err, store.ErrLastAdmin):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, store.ErrUserNotFound), errors.Is(err, store.ErrInviteNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, store.ErrInviteInvalid):
		writeError(w, http.StatusGone, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "account operation failed")
	}
}

func (s *Server) requireAccounts(w http.ResponseWriter) bool {
	if s.accounts == nil {
		writeError(w, http.StatusServiceUnavailable, "this server's store does not support accounts")
		return false
	}
	return true
}

func (s *Server) handleAuthSetup(w http.ResponseWriter, r *http.Request) {
	if !s.requireAccounts(w) {
		return
	}
	var input struct {
		newAccountRequest
		SetupCode string `json:"setupCode"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	ip := "setup-ip:" + clientIP(r)
	if s.loginLimiter.locked(ip) {
		writeError(w, http.StatusTooManyRequests, "too many attempts; try again later")
		return
	}
	s.setupMu.Lock()
	defer s.setupMu.Unlock()
	expected := s.setupCode
	if expected == "" {
		writeError(w, http.StatusConflict, store.ErrAccountsInitialized.Error())
		return
	}
	given := strings.ToUpper(strings.TrimSpace(input.SetupCode))
	if subtle.ConstantTimeCompare([]byte(given), []byte(expected)) != 1 {
		s.loginLimiter.fail(ip)
		writeError(w, http.StatusForbidden, "setup code is incorrect")
		return
	}
	newUser, ok := validateNewAccount(w, input.newAccountRequest)
	if !ok {
		return
	}
	user, err := s.accounts.CreateFirstOwner(r.Context(), newUser)
	if err != nil {
		writeAccountError(w, err)
		return
	}
	s.setupCode = ""
	s.loginLimiter.succeed(ip)
	if s.startSession(w, r, user) {
		writeJSON(w, http.StatusCreated, authStateResponse{User: &user})
	}
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if !s.requireAccounts(w) {
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	ip := clientIP(r)
	keys := []string{"ip:" + ip, "user-ip:" + strings.ToLower(strings.TrimSpace(input.Username)) + "|" + ip}
	if s.loginLimiter.locked(keys...) {
		writeError(w, http.StatusTooManyRequests, "too many failed logins; try again later")
		return
	}
	user, hash, err := s.accounts.GetUserCredentials(r.Context(), input.Username)
	switch {
	case errors.Is(err, store.ErrUserNotFound):
		accounts.SpendVerifyTime(input.Password)
	case err != nil:
		writeError(w, http.StatusInternalServerError, "login failed")
		return
	}
	if err != nil || !accounts.VerifyPassword(hash, input.Password) || !user.Active() {
		s.loginLimiter.fail(keys...)
		writeError(w, http.StatusUnauthorized, "username or password is incorrect")
		return
	}
	s.loginLimiter.succeed(keys...)
	if s.startSession(w, r, user) {
		writeJSON(w, http.StatusOK, authStateResponse{User: &user})
	}
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if !s.requireAccounts(w) {
		return
	}
	if cookie, err := r.Cookie(sessionCookieName); err == nil && cookie.Value != "" {
		if err := s.accounts.DeleteUserSession(r.Context(), accounts.HashToken(cookie.Value)); err != nil {
			writeError(w, http.StatusInternalServerError, "logout failed")
			return
		}
	}
	s.clearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func currentAccount(w http.ResponseWriter, r *http.Request) (*store.User, bool) {
	account := actorFromContext(r.Context()).Account
	if account == nil {
		writeError(w, http.StatusForbidden, "a logged-in account is required")
		return nil, false
	}
	return account, true
}

func (s *Server) handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	account, ok := currentAccount(w, r)
	if !ok {
		return
	}
	var input struct {
		DisplayName string `json:"displayName"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	name := strings.TrimSpace(input.DisplayName)
	if name == "" {
		writeError(w, http.StatusBadRequest, "display name must not be empty")
		return
	}
	if err := accounts.ValidateDisplayName(name); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	user, err := s.accounts.UpdateUser(r.Context(), account.ID, store.UserUpdate{DisplayName: &name})
	if err != nil {
		writeAccountError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	account, ok := currentAccount(w, r)
	if !ok {
		return
	}
	var input struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	key := "password:" + account.ID
	if s.loginLimiter.locked(key) {
		writeError(w, http.StatusTooManyRequests, "too many failed attempts; try again later")
		return
	}
	_, hash, err := s.accounts.GetUserCredentials(r.Context(), account.Username)
	if err != nil {
		writeAccountError(w, err)
		return
	}
	if !accounts.VerifyPassword(hash, input.CurrentPassword) {
		s.loginLimiter.fail(key)
		writeError(w, http.StatusForbidden, "current password is incorrect")
		return
	}
	if err := accounts.ValidatePassword(input.NewPassword); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	newHash, err := accounts.HashPassword(input.NewPassword)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "hash password")
		return
	}
	// Revokes every session, including this one; issue a fresh cookie.
	if err := s.accounts.SetUserPassword(r.Context(), account.ID, newHash); err != nil {
		writeAccountError(w, err)
		return
	}
	s.loginLimiter.succeed(key)
	s.events.Reauthorize(account.ID)
	if s.startSession(w, r, *account) {
		w.WriteHeader(http.StatusNoContent)
	}
}

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	if !s.requireAccounts(w) {
		return
	}
	users, err := s.accounts.ListUsers(r.Context())
	if err != nil {
		writeAccountError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, users)
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	if !s.requireAccounts(w) {
		return
	}
	var input struct {
		Role     *string `json:"role"`
		Disabled *bool   `json:"disabled"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.Role != nil && !store.ValidRole(*input.Role) {
		writeError(w, http.StatusBadRequest, "role must be admin or member")
		return
	}
	user, err := s.accounts.UpdateUser(r.Context(), r.PathValue("id"), store.UserUpdate{Role: input.Role, Disabled: input.Disabled})
	if err != nil {
		writeAccountError(w, err)
		return
	}
	s.events.Reauthorize(user.ID)
	if !user.Active() {
		s.cancelAllSessionsStartedBy(r.Context(), user.ID)
	}
	writeJSON(w, http.StatusOK, user)
}

func (s *Server) handleListInvites(w http.ResponseWriter, r *http.Request) {
	if !s.requireAccounts(w) {
		return
	}
	invites, err := s.accounts.ListInvites(r.Context())
	if err != nil {
		writeAccountError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, invites)
}

func (s *Server) handleCreateInvite(w http.ResponseWriter, r *http.Request) {
	if !s.requireAccounts(w) {
		return
	}
	account, ok := currentAccount(w, r)
	if !ok {
		return
	}
	var input struct {
		Role           string `json:"role"`
		ExpiresInHours int    `json:"expiresInHours"`
		WorkspaceID    string `json:"workspaceId"`
		WorkspaceRole  string `json:"workspaceRole"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !store.ValidRole(input.Role) {
		writeError(w, http.StatusBadRequest, "role must be admin or member")
		return
	}
	grant := store.WorkspaceGrant{WorkspaceID: strings.TrimSpace(input.WorkspaceID), Role: input.WorkspaceRole}
	if grant.WorkspaceID != "" {
		if !store.ValidWorkspaceRole(grant.Role) {
			writeError(w, http.StatusBadRequest, "workspaceRole must be viewer, member, maintainer or owner")
			return
		}
		// An invite can only share a workspace its creator owns.
		if !s.requireWorkspace(w, r, grant.WorkspaceID, store.WorkspaceRoleOwner) {
			return
		}
	}
	ttl := inviteDefaultTTL
	if input.ExpiresInHours > 0 {
		ttl = time.Duration(input.ExpiresInHours) * time.Hour
	}
	if ttl > inviteMaxTTL {
		writeError(w, http.StatusBadRequest, "invites expire within 30 days at most")
		return
	}
	token, err := accounts.NewToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create invite")
		return
	}
	invite, err := s.accounts.CreateInvite(r.Context(), accounts.HashToken(token), input.Role, account.ID, time.Now().UTC().Add(ttl), grant)
	if err != nil {
		writeAccountError(w, err)
		return
	}
	// The token is returned once; only its hash is stored.
	writeJSON(w, http.StatusCreated, struct {
		store.Invite
		Token string `json:"token"`
	}{invite, token})
}

func (s *Server) handleRevokeInvite(w http.ResponseWriter, r *http.Request) {
	if !s.requireAccounts(w) {
		return
	}
	if err := s.accounts.RevokeInvite(r.Context(), r.PathValue("id")); err != nil {
		writeAccountError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleGetInvite(w http.ResponseWriter, r *http.Request) {
	if !s.requireAccounts(w) {
		return
	}
	invite, err := s.accounts.GetPendingInvite(r.Context(), accounts.HashToken(r.PathValue("token")), time.Now().UTC())
	if err != nil {
		writeAccountError(w, err)
		return
	}
	preview := struct {
		Role          string    `json:"role"`
		ExpiresAt     time.Time `json:"expiresAt"`
		WorkspaceName string    `json:"workspaceName,omitempty"`
		WorkspaceRole string    `json:"workspaceRole,omitempty"`
	}{Role: invite.Role, ExpiresAt: invite.ExpiresAt}
	if invite.WorkspaceID != "" {
		if workspace, err := s.store.GetWorkspace(r.Context(), invite.WorkspaceID); err == nil {
			preview.WorkspaceName, preview.WorkspaceRole = workspace.Name, invite.WorkspaceRole
		}
	}
	writeJSON(w, http.StatusOK, preview)
}

func (s *Server) handleAcceptInvite(w http.ResponseWriter, r *http.Request) {
	if !s.requireAccounts(w) {
		return
	}
	var input newAccountRequest
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	newUser, ok := validateNewAccount(w, input)
	if !ok {
		return
	}
	user, err := s.accounts.RedeemInvite(r.Context(), accounts.HashToken(r.PathValue("token")), time.Now().UTC(), newUser)
	if err != nil {
		writeAccountError(w, err)
		return
	}
	if s.startSession(w, r, user) {
		writeJSON(w, http.StatusCreated, authStateResponse{User: &user})
	}
}
