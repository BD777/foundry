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
	return EligibleFor(account, boundWorkspaces, workspaceID, sessionOwner, deviceOwner, Policy{}) &&
		(account.Status == store.ExternalAccountReady || account.Status == store.ExternalAccountExpiring)
}

// EligibleFor is Eligible with the session workspace's Personal Agent
// policy: an owned account in the assistant's workspace needs no binding
// unless the person switched that account off.
func EligibleFor(account store.ExternalAccount, boundWorkspaces []string, workspaceID, sessionOwner, deviceOwner string, policy Policy) bool {
	return PermittedFor(account, boundWorkspaces, workspaceID, sessionOwner, deviceOwner, policy) &&
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
	return PermittedFor(account, boundWorkspaces, workspaceID, sessionOwner, deviceOwner, Policy{})
}

// PermittedFor is Permitted with the Personal Agent policy applied to
// workspace bindings.
func PermittedFor(account store.ExternalAccount, boundWorkspaces []string, workspaceID, sessionOwner, deviceOwner string, policy Policy) bool {
	if account.OwnerUserID == "" || sessionOwner != account.OwnerUserID || deviceOwner != account.OwnerUserID {
		return false
	}
	if account.Mode != store.ExternalCredentialServerHeld {
		return false
	}
	return policy.Bound(account.ID, boundWorkspaces, workspaceID)
}

// CheckEligible says whether a tool version check on a device owned by
// deviceOwner, run for userID, may act as account now: the account is
// userID's own, server-held and usable, and the device is theirs. It is
// what a bundle rollout's canary check uses (docs/skills.md, Bundle 版本);
// no workspace binding is involved, since no session uses the account.
func CheckEligible(account store.ExternalAccount, userID, deviceOwner string) bool {
	if account.OwnerUserID == "" || userID != account.OwnerUserID || deviceOwner != account.OwnerUserID {
		return false
	}
	return account.Mode == store.ExternalCredentialServerHeld &&
		(account.Status == store.ExternalAccountReady || account.Status == store.ExternalAccountExpiring)
}

// CheckMaterial is what a tool version check acts with: the gateway
// handles for one of the device owner's accounts, under the check's id.
func (s *Service) CheckMaterial(ctx context.Context, account store.ExternalAccount, checkID, deviceID string) (store.ExternalAccountMaterial, error) {
	account = s.withComputedStatus(account)
	if !CheckEligible(account, account.OwnerUserID, account.OwnerUserID) {
		return store.ExternalAccountMaterial{}, errors.New("the account cannot be used now")
	}
	return s.material(ctx, account, HandleRequest{SessionID: checkID, DeviceID: deviceID, UserID: account.OwnerUserID, Account: account})
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
	accounts, err := s.SessionAccounts(ctx, workspaceID, sessionID, sessionOwner, deviceID, deviceOwner)
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
func (s *Service) SessionAccounts(ctx context.Context, workspaceID, sessionID, sessionOwner, deviceID, deviceOwner string) ([]store.ExternalAccount, error) {
	if !s.SecretsConfigured() || sessionOwner == "" || deviceID == "" {
		return nil, nil
	}
	if deviceOwner != sessionOwner {
		return nil, nil
	}
	var policy Policy
	if sessionID != "" {
		session, err := s.store.GetAgentSessionSummary(ctx, sessionID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
		if err == nil {
			if policy, err = ResolvePolicy(ctx, s.store, session); err != nil {
				return nil, err
			}
		}
	}
	var candidates []store.ExternalAccount
	var err error
	if policy.PersonalAgent() {
		candidates, err = s.store.ListExternalAccounts(ctx, sessionOwner)
	} else {
		var bindings []store.ExternalAccountBinding
		bindings, err = s.store.ListWorkspaceExternalAccounts(ctx, workspaceID)
		for _, binding := range bindings {
			account, getErr := s.store.GetExternalAccount(ctx, binding.AccountID)
			if getErr == nil {
				candidates = append(candidates, account)
			}
		}
	}
	if err != nil {
		return nil, err
	}
	var accounts []store.ExternalAccount
	for _, account := range candidates {
		account = s.withComputedStatus(account)
		if EligibleFor(account, account.WorkspaceIDs, workspaceID, sessionOwner, deviceOwner, policy) {
			if s.AllowSessionAccount != nil {
				allowed, err := s.AllowSessionAccount(ctx, account, deviceID)
				if err != nil {
					return nil, err
				}
				if !allowed {
					continue
				}
			}
			accounts = append(accounts, account)
		}
	}
	return s.preferDeviceNetworkAccounts(ctx, accounts), nil
}

// preferDeviceNetworkAccounts picks one instance per connector kind: when a
// workspace binds both a server-network and a device-network instance, a
// session that can reach the latter gets it instead of the server one.
func (s *Service) preferDeviceNetworkAccounts(ctx context.Context, accounts []store.ExternalAccount) []store.ExternalAccount {
	type choice struct {
		account store.ExternalAccount
		device  bool
		ext     bool
	}
	choices := make([]choice, 0, len(accounts))
	byProvider := map[string]int{}
	for _, account := range accounts {
		app, err := s.store.GetExternalProviderApp(ctx, account.AppID)
		device, ext := false, false
		if err == nil && app.CreatedVia == "extension" {
			ext = true
			if data, dataErr := decodeExtensionData(app); dataErr == nil {
				device = data.Network == ExtensionNetworkDevice
			}
		}
		if ext {
			if index, ok := byProvider[account.Provider]; ok {
				if device && !choices[index].device {
					choices[index] = choice{account: account, device: true, ext: true}
				}
				continue
			}
			byProvider[account.Provider] = len(choices)
		}
		choices = append(choices, choice{account: account, device: device, ext: ext})
	}
	result := make([]store.ExternalAccount, 0, len(choices))
	for _, selected := range choices {
		result = append(result, selected.account)
	}
	return result
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
	var sessionEnvironment map[string]string
	if app.CreatedVia == "extension" {
		data, dataErr := s.ExtensionData(ctx, app)
		if dataErr != nil {
			return store.ExternalAccountMaterial{}, dataErr
		}
		tool = data.Descriptor.Tool.Command
		sessionEnvironment, err = s.ExtensionSessionEnvironment(ctx, app, data)
		if err != nil {
			return store.ExternalAccountMaterial{}, err
		}
	}
	expires := gateway.ExpiresAt
	if expires == "" {
		expires = s.formatTime(s.Now().Add(sessionHandleLifetime))
	}
	return store.ExternalAccountMaterial{
		AccountID: account.ID, Provider: account.Provider, Label: account.Label, Tool: tool, ProfileName: ProfileName(account.ID, request.SessionID),
		ClientID: app.ClientID, Gateway: &gateway, ExpiresAt: expires,
		Scope: strings.Join(account.GrantedScopes, " "), Subject: account.Subject, DisplayName: account.DisplayName,
		SessionEnvironment: sessionEnvironment,
	}, nil
}
