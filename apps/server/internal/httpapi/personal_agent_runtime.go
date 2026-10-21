package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) assistantRuntimeStore() (store.PersonalAgentRuntimeStore, error) {
	backing, ok := s.store.(store.PersonalAgentRuntimeStore)
	if !ok {
		return nil, &statusError{http.StatusNotImplemented, errors.New("assistant run snapshots unavailable")}
	}
	return backing, nil
}

// resolveAssistantRun chooses once from the accounts of the data workspace.
// An explicit choice never falls back to a different account implicitly.
func (s *Server) resolveAssistantRun(ctx context.Context, agent store.PersonalAgent, role, workspaceID string) (store.PersonalAgentRunSnapshot, error) {
	preference, err := personalagent.RunPreference(agent.Settings, role)
	if err != nil {
		return store.PersonalAgentRunSnapshot{}, invalid("%v", err)
	}
	if preference.Disabled {
		return store.PersonalAgentRunSnapshot{}, invalid("this assistant role is disabled")
	}
	if workspaceID == "" && role == "coordinator" {
		workspaceID = agent.WorkspaceID
	}
	if role == "coordinator" && workspaceID != agent.WorkspaceID {
		return store.PersonalAgentRunSnapshot{}, invalid("the coordinator runs in its own assistant workspace")
	}
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return store.PersonalAgentRunSnapshot{}, err
	}
	roles, err := s.store.WorkspaceRolesForUser(ctx, agent.UserID)
	if err != nil {
		return store.PersonalAgentRunSnapshot{}, err
	}
	required := store.WorkspaceRoleMember
	if role == "memory" || role == "governance" {
		required = store.WorkspaceRoleOwner
	}
	if !roleAtLeast(roles[workspace.ID], required) {
		return store.PersonalAgentRunSnapshot{}, &statusError{http.StatusForbidden, errors.New("workspace permission does not allow this role")}
	}
	if err := store.RequireDeviceAvailable(ctx, s.store, workspace.DeviceID); err != nil {
		return store.PersonalAgentRunSnapshot{}, err
	}
	if role != "coordinator" && !personalagent.DeviceSettings(agent.Settings.Devices, workspace.DeviceID, agent.HomeDeviceID).AllowWork {
		return store.PersonalAgentRunSnapshot{}, invalid("execution_on_device_not_allowed")
	}
	if preference.DeviceID != "" && preference.DeviceID != workspace.DeviceID {
		return store.PersonalAgentRunSnapshot{}, invalid("execution_location_mismatch: this role runs on the data workspace's computer")
	}
	if workspace.ArchivedAt != "" || workspace.UnavailableOnDevice != nil {
		return store.PersonalAgentRunSnapshot{}, invalid("workspace_unavailable")
	}
	accounts, err := s.workspaceAccounts(ctx, workspace, agent.UserID)
	if err != nil {
		return store.PersonalAgentRunSnapshot{}, err
	}
	pick := func(profileID, runtime string) (workspaceAccount, bool) {
		if profileID == "device_default" {
			return pickAccount(accounts, runtime, "")
		}
		for _, account := range accounts {
			if account.ProfileID == profileID && account.Usable && (runtime == "" || account.Runtime == runtime) {
				return account, true
			}
		}
		return workspaceAccount{}, false
	}
	chosen, found := pick(preference.ProfileID, preference.Runtime)
	reason := "configured"
	if preference.ProfileID == "device_default" {
		reason = "device_default"
	}
	if !found {
		// Fallbacks are explicit, scope-bounded choices on this computer.
		// Cross-device execution needs a separate, authorized workspace move.
		for _, target := range preference.Fallbacks {
			if target.DeviceID != workspace.DeviceID || !slices.Contains(target.WorkspaceIDs, workspace.ID) {
				continue
			}
			if candidate, ok := pick(target.ProfileID, target.Runtime); ok {
				chosen, found = candidate, true
				preference.ProfileID, preference.Runtime, preference.Model, preference.Effort = target.ProfileID, target.Runtime, target.Model, target.Effort
				reason = "configured_fallback"
				break
			}
		}
	}
	if !found {
		return store.PersonalAgentRunSnapshot{}, &statusError{http.StatusConflict, errors.New("account_unavailable: choose an account available on the target computer")}
	}
	providerConfigHash := ""
	var profile store.AgentProfileProjection
	profiles, err := s.store.ListAgentProfiles(ctx, workspace.DeviceID)
	if err != nil {
		return store.PersonalAgentRunSnapshot{}, err
	}
	for _, p := range profiles {
		if p.ID == chosen.ProfileID {
			profile = p
			break
		}
	}
	if chosen.Kind == "model_service" {
		service, err := s.store.GetProfile(ctx, chosen.ProfileID)
		if err != nil {
			return store.PersonalAgentRunSnapshot{}, err
		}
		providerConfigHash = assistantProviderConfiguration(service)
		profile.ID, profile.Runtime, profile.Model, profile.Models = service.ID, service.Runtime, service.Model, service.Models
		profile.BaseURL, profile.ClaudeEffort, profile.CodexReasoningEffort = service.BaseURL, service.ClaudeEffort, service.CodexReasoningEffort
	}
	if chosen.Kind != "model_service" {
		if profile.ID == "" {
			profile = assistantFallbackProfile(chosen)
		}
		providerConfigHash = assistantDeviceConfiguration(profile)
	}
	model := preference.Model
	if model == "" {
		model = profile.Model
	}
	if len(profile.Models) > 0 && model != "" && model != profile.Model && !slices.Contains(profile.Models, model) {
		return store.PersonalAgentRunSnapshot{}, invalid("model_unavailable: the chosen account does not advertise this model")
	}
	effort := preference.Effort
	if effort == "" {
		if chosen.Runtime == "codex" {
			effort = profile.CodexReasoningEffort
		} else {
			effort = profile.ClaudeEffort
		}
	}
	allowed := []string{"", "low", "medium", "high", "xhigh", "max"}
	if chosen.Runtime == "codex" {
		allowed = []string{"", "minimal", "low", "medium", "high", "xhigh"}
	}
	if !slices.Contains(allowed, effort) {
		return store.PersonalAgentRunSnapshot{}, invalid("effort is not supported by this runtime")
	}
	origin := ""
	if parsed, err := url.Parse(profile.BaseURL); err == nil && parsed.Scheme != "" && parsed.Host != "" {
		origin = parsed.Scheme + "://" + parsed.Host
	}
	configHash, err := flow.Fingerprint(struct {
		Role                                                                           string
		Preference                                                                     store.PersonalAgentRunPreference
		Device, Workspace, Profile, Model, Effort, Fingerprint, Origin, ProviderConfig string
	}{role, preference, workspace.DeviceID, workspace.ID, chosen.ProfileID, model, effort, chosen.agent.ProfileFingerprint, origin, providerConfigHash})
	if err != nil {
		return store.PersonalAgentRunSnapshot{}, err
	}
	return store.PersonalAgentRunSnapshot{
		UserID: agent.UserID, Role: role, WorkspaceID: workspace.ID, DeviceID: workspace.DeviceID, AccountLabel: profile.AccountLabel,
		Runtime: chosen.Runtime, ProfileID: chosen.ProfileID, AgentID: chosen.agent.ID, Model: model, Effort: effort,
		ProfileFingerprint: chosen.agent.ProfileFingerprint, ProviderOrigin: origin, ProviderConfigHash: providerConfigHash, ConfigHash: configHash,
		TokenBudget: preference.TokenBudget, TimeoutMinutes: preference.TimeoutMinutes, SelectionReason: reason,
	}, nil
}

func (s *Server) pinAssistantRun(ctx context.Context, agent store.PersonalAgent, operationID, role, workspaceID string) (store.PersonalAgentRunSnapshot, error) {
	backing, err := s.assistantRuntimeStore()
	if err != nil {
		return store.PersonalAgentRunSnapshot{}, err
	}
	id := flow.Key("parun", agent.UserID, operationID)
	existing, err := backing.GetPersonalAgentRunSnapshot(ctx, agent.UserID, id)
	if err == nil {
		if existing.Role != role || existing.WorkspaceID != workspaceID {
			return existing, &statusError{http.StatusConflict, store.ErrIdempotencyConflict}
		}
		return existing, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return existing, err
	}
	snapshot, err := s.resolveAssistantRun(ctx, agent, role, workspaceID)
	if err != nil {
		return snapshot, err
	}
	snapshot.ID = id
	snapshot.InputID = flow.InputID(operationID)
	return backing.RecordPersonalAgentRunSnapshot(ctx, snapshot)
}

func runSessionInput(snapshot store.PersonalAgentRunSnapshot, prompt, inputID string) store.CreateAgentSessionInput {
	input := store.CreateAgentSessionInput{
		CreatedByUserID: snapshot.UserID, WorkspaceID: snapshot.WorkspaceID,
		ProfileID: snapshot.ProfileID, Provider: snapshot.Runtime, Model: snapshot.Model,
		Prompt: prompt, InputID: inputID, Source: "chat",
		ExecutionBudget: runExecutionBudget(snapshot),
	}
	if input.ProfileID == "" {
		input.AgentID = snapshot.AgentID
	}
	if snapshot.Runtime == "codex" {
		input.CodexReasoningEffort = snapshot.Effort
	} else {
		input.ClaudeEffort = snapshot.Effort
	}
	return input
}

func (s *Server) handlePersonalAgentRunPreview(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input store.PersonalAgentRunPreview
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	snapshot, err := s.resolveAssistantRun(r.Context(), agent, strings.TrimSpace(input.Role), strings.TrimSpace(input.WorkspaceID))
	writeResult(w, snapshot, err)
}

func (s *Server) handlePersonalAgentRunSnapshots(w http.ResponseWriter, r *http.Request) {
	backing, err := s.assistantRuntimeStore()
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	items, err := backing.ListPersonalAgentRunSnapshots(r.Context(), s.personFrom(r).ID, 100)
	writeResult(w, items, err)
}

func (s *Server) checkPinnedAssistantRun(ctx context.Context, snapshot store.PersonalAgentRunSnapshot) error {
	if err := store.RequireDeviceAvailable(ctx, s.store, snapshot.DeviceID); err != nil {
		return err
	}
	workspace, err := s.store.GetWorkspace(ctx, snapshot.WorkspaceID)
	if err != nil {
		return err
	}
	if workspace.DeviceID != snapshot.DeviceID {
		return fmt.Errorf("execution location changed")
	}
	if workspace.ArchivedAt != "" || workspace.UnavailableOnDevice != nil {
		return fmt.Errorf("workspace is unavailable")
	}
	roles, err := s.store.WorkspaceRolesForUser(ctx, snapshot.UserID)
	if err != nil {
		return err
	}
	required := store.WorkspaceRoleMember
	if snapshot.Role == "memory" || snapshot.Role == "governance" {
		required = store.WorkspaceRoleOwner
	}
	if !roleAtLeast(roles[workspace.ID], required) {
		return fmt.Errorf("workspace permission changed")
	}
	agent, e := s.store.GetPersonalAgent(ctx, snapshot.UserID)
	if e != nil {
		return e
	}
	if snapshot.Role != "coordinator" && !personalagent.DeviceSettings(agent.Settings.Devices, workspace.DeviceID, agent.HomeDeviceID).AllowWork {
		return fmt.Errorf("execution_on_device_not_allowed")
	}
	accounts, err := s.workspaceAccounts(ctx, workspace, snapshot.UserID)
	if err != nil {
		return err
	}
	for _, account := range accounts {
		if account.ProfileID == snapshot.ProfileID && account.Usable && account.Runtime == snapshot.Runtime &&
			(snapshot.ProfileFingerprint == "" || snapshot.ProfileFingerprint == account.agent.ProfileFingerprint) {
			current, e := s.assistantAccountConfiguration(ctx, workspace, account)
			if e != nil {
				return e
			}
			if current != snapshot.ProviderConfigHash {
				return fmt.Errorf("pinned account configuration changed; configure an explicit new attempt")
			}

			return nil
		}
	}
	return fmt.Errorf("pinned account is unavailable; configure an explicit new attempt")
}

func runExecutionBudget(snapshot store.PersonalAgentRunSnapshot) *store.SessionExecutionBudget {
	return &store.SessionExecutionBudget{SnapshotID: snapshot.ID, TokenBudget: snapshot.TokenBudget, TimeoutMinutes: snapshot.TimeoutMinutes}
}

// Opaque configuration hash, not an authentication assertion. Credentials are
// never read here. Rotation of a key within the same configured account remains
// that account's operation, not permission to silently choose another provider.
func assistantProviderConfiguration(p store.ProfileDefinition) string {
	value, _ := flow.Fingerprint(struct {
		Runtime, Auth, Connection, URL, Prefix, ClaudePermission, CodexSandbox, CodexApproval, Transport, Speed string
		Windows                                                                                                 map[string]int64
	}{p.Runtime, p.AuthMode, p.ConnectionType, p.BaseURL, p.PromptPrefix, p.ClaudePermissionMode, p.CodexSandboxMode, p.CodexApprovalPolicy, p.CodexTransport, p.CodexSpeed, p.ContextWindows})
	return value
}

// Binds observed configuration and cached identity, never credentials or an
// assertion that the provider has authenticated this account online.
func (s *Server) assistantAccountConfiguration(ctx context.Context, workspace store.WorkspaceProjection, account workspaceAccount) (string, error) {
	if account.Kind == "model_service" {
		p, err := s.store.GetProfile(ctx, account.ProfileID)
		if err != nil {
			return "", err
		}
		return assistantProviderConfiguration(p), nil
	}
	p := assistantFallbackProfile(account)
	profiles, err := s.store.ListAgentProfiles(ctx, workspace.DeviceID)
	if err != nil {
		return "", err
	}
	for _, observed := range profiles {
		if observed.ID == account.ProfileID {
			p = observed
			break
		}
	}
	return assistantDeviceConfiguration(p), nil
}
func assistantFallbackProfile(account workspaceAccount) store.AgentProfileProjection {
	return store.AgentProfileProjection{ID: account.ProfileID, Runtime: account.Runtime, Fingerprint: account.agent.ProfileFingerprint, ConnectionType: account.agent.ConnectionType, AuthMode: account.agent.AuthMode, ConfigScope: account.agent.ConfigScope, ConfigLabel: account.agent.ConfigLabel}
}
func assistantDeviceConfiguration(p store.AgentProfileProjection) string {
	value, _ := flow.Fingerprint(struct {
		Runtime, Profile, Fingerprint, Connection, URL, AccountLabel, AuthMode, Scope, Section, KeySource, Command string
	}{p.Runtime, p.ID, p.Fingerprint, p.ConnectionType, p.BaseURL, p.AccountLabel, p.AuthMode, p.ConfigScope, p.ConfigSection, p.KeySource, p.CommandLabel})
	return value
}
