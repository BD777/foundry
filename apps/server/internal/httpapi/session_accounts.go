package httpapi

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Choosing an account (docs/models-and-accounts.md "会话不指定账号时"): a
// session started without a profile, or with only a runtime, runs under an
// account of its workspace's device that can work there: the one the
// person's last completed session there used, else their assistant's own,
// else the first ready one. A login the device reports as not signed in,
// or an endpoint whose check did not pass, is never chosen; with none
// ready the start is refused with no_usable_account instead of failing
// on the device.

const (
	accountNotSignedIn = "not_signed_in"
	accountNotReady    = "not_ready"
)

// workspaceAccount is one account a session in a workspace can run under,
// as the caller choosing one reads it.
type workspaceAccount struct {
	ProfileID string `json:"profileId"`
	Name      string `json:"name"`
	Runtime   string `json:"runtime"`
	// Kind: device_login (that computer's own Claude Code / Codex sign-in),
	// device_endpoint (an endpoint in its Claude Code / Codex config) or
	// model_service (one set up in Foundry and assigned to it).
	Kind   string `json:"kind"`
	Usable bool   `json:"usable"`
	// Problem says why it is not usable: not_signed_in or not_ready.
	Problem string `json:"problem,omitempty"`
	Detail  string `json:"detail,omitempty"`
	// LastWorkedAt is when the person's last session there that completed
	// on it was active.
	LastWorkedAt string `json:"lastWorkedAt,omitempty"`

	agent store.AgentProjection
}

func (a workspaceAccount) describe() string {
	return fmt.Sprintf("%q (profileId %s, %s)", a.Name, a.ProfileID, a.Runtime)
}

// accountReadiness says whether an account its device reported can run a
// session, and why not. A status the device never reported is not known
// to be broken.
func accountReadiness(agent store.AgentProjection) (bool, string) {
	switch agent.Status {
	case "missing_auth":
		return false, accountNotSignedIn
	case "unavailable":
		return false, accountNotReady
	}
	return true, ""
}

// workspaceAccounts are the accounts of the workspace's device, as a
// session there would run them: what the device reported, and the model
// services assigned to it. A model service reads as it does once the
// device is connected, since a session for an offline device waits for
// it. userID's completed sessions there date each account's LastWorkedAt.
func (s *Server) workspaceAccounts(ctx context.Context, workspace store.WorkspaceProjection, userID string) ([]workspaceAccount, error) {
	deviceID := strings.TrimSpace(workspace.DeviceID)
	agents, err := s.store.ListAgents(ctx, workspace.ID, deviceID)
	if err != nil {
		return nil, err
	}
	services := map[string]bool{}
	if deviceID != "" {
		bindings, err := s.store.ListDeviceProfiles(ctx, deviceID)
		if err != nil {
			return nil, err
		}
		health, err := s.store.ListProviderHealth(ctx, deviceID)
		if err != nil {
			return nil, err
		}
		device := store.DeviceProjection{ID: deviceID, Label: workspace.DeviceLabel, Status: deviceStatusConnected}
		for _, binding := range bindings {
			if !binding.Enabled || binding.ProfileID == "" {
				continue
			}
			profile, err := s.store.GetProfile(ctx, binding.ProfileID)
			if errors.Is(err, store.ErrProfileNotFound) {
				continue
			}
			if err != nil {
				return nil, err
			}
			row := serverProfileRow(device, profile, health, s.profileHasCredential(ctx, profile.ID))
			agents = upsertAgentRow(agents, serverAgentRow(workspace, device, row))
			services[profile.ID] = true
		}
	}
	worked := s.accountsWorked(ctx, workspace.ID, userID)
	accounts := make([]workspaceAccount, 0, len(agents))
	for _, agent := range agents {
		usable, problem := accountReadiness(agent)
		kind := "device_endpoint"
		switch {
		case services[agent.ProfileID]:
			kind = "model_service"
		case agent.ConnectionType == "local_login":
			kind = "device_login"
		}
		account := workspaceAccount{
			ProfileID: agent.ProfileID, Name: cmp.Or(agent.ProfileLabel, agent.ProfileID, agent.ID), Runtime: agent.Provider,
			Kind: kind, Usable: usable, Problem: problem, LastWorkedAt: worked[agent.ProfileID], agent: agent,
		}
		if !usable {
			account.Detail = agent.StatusDetail
		}
		accounts = append(accounts, account)
	}
	return accounts, nil
}

// accountsWorked dates, by profile, the latest of userID's sessions in
// the workspace that completed ("" userID: anyone's). Naming and digest
// jobs are not the person's work.
func (s *Server) accountsWorked(ctx context.Context, workspaceID, userID string) map[string]string {
	worked := map[string]string{}
	sessions, err := s.store.ListAgentSessionSummaries(ctx, workspaceID)
	if err != nil {
		return worked
	}
	for _, session := range sessions {
		if session.Status != "completed" || session.ProfileID == "" || session.Source == "naming" || session.Source == store.DigestSessionSource {
			continue
		}
		if userID != "" && session.CreatedByUserID != userID {
			continue
		}
		at := cmp.Or(session.ActivityAt, session.CompletedAt, session.StartedAt)
		if at > worked[session.ProfileID] {
			worked[session.ProfileID] = at
		}
	}
	return worked
}

// pickAccount chooses among accounts for a runtime ("" any): the usable
// one the person last completed work on, else their default, else the
// first usable one, a reported-ready one before one never reported. ok
// is false when none is usable.
func pickAccount(accounts []workspaceAccount, runtime, preferred string) (workspaceAccount, bool) {
	var usable []workspaceAccount
	for _, account := range accounts {
		if account.Usable && (runtime == "" || account.Runtime == runtime) {
			usable = append(usable, account)
		}
	}
	if len(usable) == 0 {
		return workspaceAccount{}, false
	}
	latest := -1
	for index, account := range usable {
		if account.LastWorkedAt != "" && (latest < 0 || account.LastWorkedAt > usable[latest].LastWorkedAt) {
			latest = index
		}
	}
	if latest >= 0 {
		return usable[latest], true
	}
	if index := slices.IndexFunc(usable, func(account workspaceAccount) bool { return preferred != "" && account.ProfileID == preferred }); index >= 0 {
		return usable[index], true
	}
	if index := slices.IndexFunc(usable, func(account workspaceAccount) bool { return account.agent.Status == "healthy" }); index >= 0 {
		return usable[index], true
	}
	return usable[0], true
}

// defaultAccountOf is the account the person chose for their assistant,
// the one they set as their own default; "" without one.
func (s *Server) defaultAccountOf(ctx context.Context, userID string) string {
	if userID == "" {
		return ""
	}
	agent, err := s.store.GetPersonalAgent(ctx, userID)
	if err != nil {
		return ""
	}
	return agent.Settings.AssistantProfileID
}

// chooseAccount is the account a session in the workspace runs under when
// its caller named no profile (runtime: the runtime it named, "" none).
// ok is false for a workspace whose device reported no account at all,
// left to the caller as before; with accounts but none usable it is
// refused with no_usable_account.
func (s *Server) chooseAccount(ctx context.Context, workspace store.WorkspaceProjection, runtime, userID string) (workspaceAccount, bool, error) {
	accounts, err := s.workspaceAccounts(ctx, workspace, userID)
	if err != nil || len(accounts) == 0 {
		return workspaceAccount{}, false, err
	}
	if account, ok := pickAccount(accounts, runtime, s.defaultAccountOf(ctx, userID)); ok {
		return account, true, nil
	}
	return workspaceAccount{}, false, &statusError{http.StatusConflict, &noUsableAccountError{
		device: cmp.Or(workspace.DeviceLabel, workspace.DeviceID), runtime: runtime, accounts: accounts,
	}}
}

// sessionUserID is the person a session input works for: its creator, else
// its parent's.
func (s *Server) sessionUserID(ctx context.Context, input store.CreateAgentSessionInput) string {
	if input.CreatedByUserID != "" || input.ParentSessionID == "" {
		return input.CreatedByUserID
	}
	if parent, err := s.store.GetAgentSessionSummary(ctx, input.ParentSessionID); err == nil {
		return parent.CreatedByUserID
	}
	return ""
}

// chooseSessionAccount pins the account of a session input that names
// none, or only a runtime (chooseAccount). An input naming an agent or a
// profile is left as it is.
func (s *Server) chooseSessionAccount(ctx context.Context, input *store.CreateAgentSessionInput) error {
	if input.AgentID != "" || input.ProfileID != "" || input.WorkspaceID == "" {
		return nil
	}
	workspace, err := s.store.GetWorkspace(ctx, input.WorkspaceID)
	if err != nil {
		return nil
	}
	account, ok, err := s.chooseAccount(ctx, workspace, input.Provider, s.sessionUserID(ctx, *input))
	if err != nil || !ok {
		return err
	}
	// An agent reported without a profile (older workers) is named by id.
	if account.ProfileID == "" {
		input.AgentID, input.Provider = account.agent.ID, account.Runtime
		return nil
	}
	input.ProfileID, input.Provider = account.ProfileID, account.Runtime
	return nil
}

// chooseRuntimeSwitch pins the account of a message that names only a
// runtime: its own runtime keeps the session's account, another one runs
// under an account chosen as for a new session (chooseAccount).
func (s *Server) chooseRuntimeSwitch(ctx context.Context, session store.AgentSession, input *store.SendAgentSessionInput) error {
	if input.AgentID != "" || input.ProfileID != "" || input.Provider == "" {
		return nil
	}
	if input.Provider == session.Provider {
		input.Provider = ""
		return nil
	}
	workspace, err := s.store.GetWorkspace(ctx, session.WorkspaceID)
	if err != nil {
		return err
	}
	account, ok, err := s.chooseAccount(ctx, workspace, input.Provider, session.CreatedByUserID)
	if err != nil || !ok {
		return err
	}
	if account.ProfileID == "" {
		input.AgentID = account.agent.ID
		return nil
	}
	input.ProfileID = account.ProfileID
	return nil
}

// accountUsable reports whether profileID is a usable account of the
// workspace's device.
func (s *Server) accountUsable(ctx context.Context, workspace store.WorkspaceProjection, profileID string) bool {
	accounts, err := s.workspaceAccounts(ctx, workspace, "")
	if err != nil {
		return false
	}
	index := slices.IndexFunc(accounts, func(account workspaceAccount) bool { return account.ProfileID == profileID })
	return index >= 0 && accounts[index].Usable
}

// noUsableAccountError refuses a session no account of its device can
// run, listing what is there.
type noUsableAccountError struct {
	device, runtime string
	accounts        []workspaceAccount
}

func (e *noUsableAccountError) Error() string {
	what := "a session"
	if e.runtime != "" {
		what = "a " + e.runtime + " session"
	}
	listed := make([]string, 0, len(e.accounts))
	for _, account := range e.accounts {
		state := "usable"
		if !account.Usable {
			state = strings.ReplaceAll(account.Problem, "_", " ")
		}
		listed = append(listed, account.describe()+": "+state)
	}
	return fmt.Sprintf("no_usable_account: no account on %q can run %s now. Accounts there: %s. Name a usable one with profileId, or ask the person to sign in on that computer or assign it a model service.",
		e.device, what, strings.Join(listed, "; "))
}

// mcpText is the refusal as a tool result: the code, what it means and
// every account there, so a caller can choose without asking.
func (e *noUsableAccountError) mcpText() string {
	encoded, _ := json.Marshal(map[string]any{
		"error": "no_usable_account", "device": e.device, "runtime": e.runtime,
		"message": e.Error(), "accounts": e.accounts,
	})
	return string(encoded)
}

// accountsAnswer is a workspace's accounts as get_workspace shows them:
// each account in plain terms, and the one create_session would use
// without a profileId ("" when none is usable).
func (s *Server) accountsAnswer(ctx context.Context, workspace store.WorkspaceProjection, userID string) map[string]any {
	accounts, err := s.workspaceAccounts(ctx, workspace, userID)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	chosen, _ := pickAccount(accounts, "", s.defaultAccountOf(ctx, userID))
	return map[string]any{"defaultProfileId": chosen.ProfileID, "accounts": accounts}
}
