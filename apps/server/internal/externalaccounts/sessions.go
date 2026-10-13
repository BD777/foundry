package externalaccounts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Eligible says whether sessionOwner's session on a device owned by
// deviceOwner may act as account now: Permitted, and the account usable.
func Eligible(account store.ExternalAccount, boundWorkspaces []string, workspaceID, sessionOwner, deviceOwner string) bool {
	return Permitted(account, boundWorkspaces, workspaceID, sessionOwner, deviceOwner) &&
		(account.Status == store.ExternalAccountReady || account.Status == store.ExternalAccountExpiring)
}

// Permitted says whether sessionOwner's session on a device owned by
// deviceOwner may act as account at all, whatever the account's status: in
// the MVP only the account's owner, on their own devices, with the account
// bound to the session's workspace. This mirrors the UserFiles rule for
// Issues (issueUserFiles, httpapi/session_dispatch.go). A permitted session
// whose account is revoked or needs re-auth is refused by Mint with
// ErrAccountUnusable, not forbidden.
func Permitted(account store.ExternalAccount, boundWorkspaces []string, workspaceID, sessionOwner, deviceOwner string) bool {
	if account.OwnerUserID == "" || sessionOwner != account.OwnerUserID || deviceOwner != account.OwnerUserID {
		return false
	}
	if account.Mode != store.ExternalCredentialServerHeld {
		return false
	}
	for _, bound := range boundWorkspaces {
		if bound == workspaceID {
			return true
		}
	}
	return false
}

// ProfileName is the tool profile a worker writes for an account in one
// session: "foundry-<account id>-<session digest>", within feishu-cli's
// [A-Za-z0-9_-]{1,64}. Each session has its own profile, since its handles
// die with it.
func ProfileName(accountID, sessionID string) string {
	id := strings.TrimPrefix(accountID, "xacc_")
	var clean strings.Builder
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			clean.WriteRune(r)
		}
	}
	name := "foundry-" + clean.String()
	if len(name) > 53 {
		name = name[:53]
	}
	digest := sha256.Sum256([]byte(sessionID))
	return name + "-" + hex.EncodeToString(digest[:])[:10]
}

// sessionHandleLifetime is the expiry the tool is told its handles have;
// the gateway refuses them as soon as the session ends, whatever it says.
const sessionHandleLifetime = 30 * 24 * time.Hour

// SessionMaterials is what a session may act with: for every account bound
// to its workspace that Eligible allows, the gateway handles standing in for
// the app secret and the access token. Accounts whose handles cannot be
// issued are left out and logged; the session still starts.
func (s *Service) SessionMaterials(ctx context.Context, workspaceID, sessionID, deviceID, sessionOwner, deviceOwner string) ([]store.ExternalAccountMaterial, error) {
	accounts, err := s.SessionAccounts(ctx, workspaceID, sessionOwner, deviceOwner)
	if err != nil {
		return nil, err
	}
	var materials []store.ExternalAccountMaterial
	for _, account := range accounts {
		material, err := s.material(ctx, account, HandleRequest{SessionID: sessionID, DeviceID: deviceID, WorkspaceID: workspaceID, UserID: sessionOwner, Account: account})
		if err != nil {
			s.Logf("external account %s for session %s: %v", account.ID, sessionID, err)
			continue
		}
		materials = append(materials, material)
	}
	return materials, nil
}

// SessionAccounts lists the accounts bound to workspaceID that a session
// sessionOwner started on a device deviceOwner owns may act as now.
func (s *Service) SessionAccounts(ctx context.Context, workspaceID, sessionOwner, deviceOwner string) ([]store.ExternalAccount, error) {
	if !s.SecretsConfigured() || sessionOwner == "" || deviceOwner == "" {
		return nil, nil
	}
	bindings, err := s.store.ListWorkspaceExternalAccounts(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	var accounts []store.ExternalAccount
	for _, binding := range bindings {
		account, err := s.store.GetExternalAccount(ctx, binding.AccountID)
		if err != nil {
			continue
		}
		account = s.withComputedStatus(account)
		if Eligible(account, account.WorkspaceIDs, workspaceID, sessionOwner, deviceOwner) {
			accounts = append(accounts, account)
		}
	}
	return accounts, nil
}

func (s *Service) material(ctx context.Context, account store.ExternalAccount, request HandleRequest) (store.ExternalAccountMaterial, error) {
	if s.Handles == nil {
		return store.ExternalAccountMaterial{}, errors.New("this server has no gateway for the account's provider")
	}
	app, err := s.store.GetExternalProviderApp(ctx, account.AppID)
	if err != nil {
		return store.ExternalAccountMaterial{}, err
	}
	request.App = app
	gateway, err := s.Handles.IssueHandles(ctx, request)
	if err != nil {
		return store.ExternalAccountMaterial{}, err
	}
	provider, _ := s.registry.Lookup(account.Provider)
	tool := ""
	if provider != nil && len(provider.Describe().Tools) > 0 {
		tool = provider.Describe().Tools[0]
	}
	return store.ExternalAccountMaterial{
		AccountID: account.ID, Provider: account.Provider, Label: account.Label, Tool: tool, ProfileName: ProfileName(account.ID, request.SessionID),
		ClientID: app.ClientID, Gateway: &gateway, ExpiresAt: s.formatTime(s.Now().Add(sessionHandleLifetime)),
		Scope: strings.Join(account.GrantedScopes, " "), Subject: account.Subject, DisplayName: account.DisplayName,
	}, nil
}
