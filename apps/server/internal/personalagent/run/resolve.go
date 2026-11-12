package run

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// ReasonUsedDeviceDefault is a run's selection reason when its chosen
// account or model could not run on the target computer and the person
// allowed the computer's default instead (whenUnavailable).
const ReasonUsedDeviceDefault = "unavailable_used_device_default"

const (
	ReasonExecutionDefault     = "execution_default"
	ReasonExecutionAlternative = "execution_alternative"
)

// Resolve chooses once from the accounts of the data workspace. A new
// executor uses its execution model's default.
func (s *Resolver) Resolve(ctx context.Context, agent store.PersonalAgent, role, workspaceID string) (store.PersonalAgentRunSnapshot, error) {
	return s.resolve(ctx, agent, role, workspaceID, "default")
}

// ResolveExecutor resolves a new helper from the default or one named
// alternative. A continued session keeps its own model through PinSession.
func (s *Resolver) ResolveExecutor(ctx context.Context, agent store.PersonalAgent, workspaceID, executionChoice string) (store.PersonalAgentRunSnapshot, error) {
	return s.resolve(ctx, agent, "executor", workspaceID, executionChoice)
}

// An explicit choice never falls back to a different account implicitly.
func (s *Resolver) resolve(ctx context.Context, agent store.PersonalAgent, role, workspaceID, executionChoice string) (store.PersonalAgentRunSnapshot, error) {
	preference, err := personalagent.RunPreference(agent.Settings, role)
	if err != nil {
		return store.PersonalAgentRunSnapshot{}, invalid("%v", err)
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
	if !store.WorkspaceRoleAtLeast(roles[workspace.ID], required) {
		return store.PersonalAgentRunSnapshot{}, &personalagent.Refusal{Status: http.StatusForbidden, Err: errors.New("workspace permission does not allow this role")}
	}
	if workspace.ID != agent.WorkspaceID && !(role == "memory" && s.personMemoryWorkspace(ctx, agent.UserID, workspace.ID)) {
		pkg, err := s.store.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
		if err != nil {
			return store.PersonalAgentRunSnapshot{}, err
		}
		if !(permission.Access{Applicable: true, Agent: agent, Package: pkg}).WorkspaceAllowed(workspace.ID) {
			return store.PersonalAgentRunSnapshot{}, &personalagent.Refusal{Status: http.StatusForbidden, Err: errors.New("the assistant's permissions do not include this workspace")}
		}
	}
	if err := store.RequireDeviceAvailable(ctx, s.store, workspace.DeviceID); err != nil {
		return store.PersonalAgentRunSnapshot{}, err
	}
	if role != "coordinator" && !personalagent.DeviceSettings(agent.Settings.Devices, workspace.DeviceID, agent.HomeDeviceID).AllowWork {
		return store.PersonalAgentRunSnapshot{}, invalid("execution_on_device_not_allowed")
	}
	if workspace.ArchivedAt != "" || workspace.UnavailableOnDevice != nil {
		return store.PersonalAgentRunSnapshot{}, invalid("workspace_unavailable")
	}
	accounts, err := s.accounts.WorkspaceAccounts(ctx, workspace, agent.UserID)
	if err != nil {
		return store.PersonalAgentRunSnapshot{}, err
	}
	preferenceReason := "configured"
	if role == "executor" {
		preference, preferenceReason, err = s.executorPreference(ctx, agent, workspace, executionChoice)
		if err != nil {
			return store.PersonalAgentRunSnapshot{}, err
		}
	}
	if preference.Disabled {
		return store.PersonalAgentRunSnapshot{}, invalid("this assistant role is disabled")
	}
	if preference.DeviceID != "" && preference.DeviceID != workspace.DeviceID {
		return store.PersonalAgentRunSnapshot{}, invalid("execution_location_mismatch: this role runs on the data workspace's computer")
	}
	pick := func(profileID, runtime string) (Account, bool) {
		if profileID == "device_default" {
			return s.accounts.Pick(accounts, runtime, "")
		}
		for _, account := range accounts {
			if account.ProfileID == profileID && account.Usable && (runtime == "" || account.Runtime == runtime) {
				return account, true
			}
		}
		return Account{}, false
	}
	chosen, found := pick(preference.ProfileID, preference.Runtime)
	reason := preferenceReason
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
	if !found && preference.WhenUnavailable == "device_default" && preference.ProfileID != "device_default" {
		if candidate, ok := s.accounts.Pick(accounts, "", ""); ok {
			chosen, found, reason = candidate, true, ReasonUsedDeviceDefault
			preference.ProfileID, preference.Runtime, preference.Model, preference.Effort = "device_default", "", "", ""
		}
	}
	if !found {
		return store.PersonalAgentRunSnapshot{}, &personalagent.Refusal{Status: http.StatusConflict, Err: errors.New("account_unavailable: choose an account available on the target computer")}
	}
	run, err := s.settle(ctx, workspace, chosen, preference)
	if err != nil && preference.WhenUnavailable == "device_default" && preference.ProfileID != "device_default" && strings.Contains(err.Error(), "model_unavailable") {
		// The account is here but not the chosen model: the computer's default.
		if candidate, ok := s.accounts.Pick(accounts, "", ""); ok {
			chosen, reason = candidate, ReasonUsedDeviceDefault
			preference.ProfileID, preference.Runtime, preference.Model, preference.Effort = "device_default", "", "", ""
			run, err = s.settle(ctx, workspace, chosen, preference)
		}
	}
	if err != nil {
		return store.PersonalAgentRunSnapshot{}, err
	}
	profile, providerConfigHash, model, effort := run.profile, run.providerConfigHash, run.model, run.effort
	origin := ""
	if parsed, err := url.Parse(profile.BaseURL); err == nil && parsed.Scheme != "" && parsed.Host != "" {
		origin = parsed.Scheme + "://" + parsed.Host
	}
	configHash, err := flow.Fingerprint(struct {
		Role                                                                           string
		Preference                                                                     store.PersonalAgentRunPreference
		Device, Workspace, Profile, Model, Effort, Fingerprint, Origin, ProviderConfig string
	}{role, preference, workspace.DeviceID, workspace.ID, chosen.ProfileID, model, effort, chosen.Agent.ProfileFingerprint, origin, providerConfigHash})
	if err != nil {
		return store.PersonalAgentRunSnapshot{}, err
	}
	return store.PersonalAgentRunSnapshot{
		UserID: agent.UserID, AssistantID: agent.ID, Role: role, WorkspaceID: workspace.ID, DeviceID: workspace.DeviceID, AccountLabel: profile.AccountLabel,
		Runtime: chosen.Runtime, ProfileID: chosen.ProfileID, AgentID: chosen.Agent.ID, Model: model, Effort: effort,
		ProfileFingerprint: chosen.Agent.ProfileFingerprint, ProviderOrigin: origin, ProviderConfigHash: providerConfigHash, ConfigHash: configHash,
		TokenBudget: preference.TokenBudget, TimeoutMinutes: preference.TimeoutMinutes, SelectionReason: reason,
	}, nil
}

type executorModels struct {
	defaultChoice store.ExecutionModelChoice
	alternatives  []store.ExecutionModelChoice
}

func (s *Resolver) executorModels(ctx context.Context, agent store.PersonalAgent, workspaceID string) (executorModels, bool, error) {
	if settings := agent.Settings.ExecutionModels; settings != nil {
		return executorModels{
			defaultChoice: store.ExecutionModelChoice{
				ProviderKind: settings.ProviderKind, ProviderID: settings.ProviderID,
				Runtime: settings.Runtime, Model: settings.Model, WorkerGroupID: settings.WorkerGroupID,
				Effort: settings.Effort,
			},
			alternatives: settings.Alternatives,
		}, true, nil
	}
	for _, scope := range []string{workspaceID, ""} {
		stored, err := s.store.GetExecutionDefault(ctx, agent.UserID, scope)
		if errors.Is(err, store.ErrExecutionDefaultNotFound) {
			continue
		}
		if err != nil {
			return executorModels{}, false, err
		}
		return executorModels{
			defaultChoice: store.ExecutionModelChoice{
				ProviderKind: store.ExecutionModelChoiceProviderKind(stored.ProviderKind),
				ProviderID:   stored.ProviderID, Runtime: store.NativeRuntimeID(stored.Runtime),
				Model: stored.Model, WorkerGroupID: stored.WorkerGroupID, Effort: stored.Effort,
			},
			alternatives: stored.Alternatives,
		}, true, nil
	}
	return executorModels{}, false, nil
}

func normalizedExecutionChoice(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return "default"
	}
	return value
}

func selectedExecutionChoice(models executorModels, executionChoice string) (store.ExecutionModelChoice, string, error) {
	choice := normalizedExecutionChoice(executionChoice)
	if choice == "default" {
		return models.defaultChoice, ReasonExecutionDefault, nil
	}
	value := strings.TrimPrefix(choice, "alternative:")
	if index, err := strconv.Atoi(value); err == nil && index >= 1 && index <= len(models.alternatives) {
		return models.alternatives[index-1], ReasonExecutionAlternative, nil
	}
	for _, alternative := range models.alternatives {
		if strings.EqualFold(alternative.ID, value) || strings.EqualFold(personalagent.ExecutionChoiceID(alternative), value) {
			return alternative, ReasonExecutionAlternative, nil
		}
	}
	return store.ExecutionModelChoice{}, "", invalid("executionChoice %q is not this execution model's default or one of its alternatives; use default, an alternative's 1-based number, or its id", executionChoice)
}

func validateExecutionChoice(choice store.ExecutionModelChoice) error {
	if choice.WorkerGroupID != "" {
		if choice.ProviderID != "" || choice.Runtime != "" || choice.Model != "" || choice.Effort != "" {
			return invalid("an execution choice must be a worker group or a provider with a model, not both")
		}
		return nil
	}
	if choice.ProviderID == "" || choice.Model == "" || (choice.Runtime != "claude" && choice.Runtime != "codex") {
		return invalid("an execution choice needs workerGroupId, or providerId, runtime and model")
	}
	return nil
}

// ValidateExecutorChoice refuses a named alternative that this helper's
// effective execution model does not offer. It does not reserve a worker
// group member or inspect accounts: delivery still waits for availability.
func (s *Resolver) ValidateExecutorChoice(ctx context.Context, agent store.PersonalAgent, workspaceID, executionChoice string) error {
	models, found, err := s.executorModels(ctx, agent, workspaceID)
	if err != nil {
		return err
	}
	if !found {
		if normalizedExecutionChoice(executionChoice) != "default" {
			return invalid("executionChoice %q is unavailable because this helper has no execution model alternatives; use default", executionChoice)
		}
		return nil
	}
	choice, _, err := selectedExecutionChoice(models, executionChoice)
	if err != nil {
		return err
	}
	return validateExecutionChoice(choice)
}

func (s *Resolver) executorPreference(ctx context.Context, agent store.PersonalAgent, workspace store.WorkspaceProjection, executionChoice string) (store.PersonalAgentRunPreference, string, error) {
	models, found, err := s.executorModels(ctx, agent, workspace.ID)
	if err != nil {
		return store.PersonalAgentRunPreference{}, "", err
	}
	if !found {
		if normalizedExecutionChoice(executionChoice) != "default" {
			return store.PersonalAgentRunPreference{}, "", invalid("executionChoice %q is unavailable because this helper has no execution model alternatives; use default", executionChoice)
		}
		preference, err := personalagent.RunPreference(agent.Settings, "executor")
		if err != nil {
			return store.PersonalAgentRunPreference{}, "", invalid("%v", err)
		}
		reason := "configured"
		if preference.ProfileID == "device_default" {
			reason = "device_default"
		}
		return preference, reason, nil
	}
	choice, reason, err := selectedExecutionChoice(models, executionChoice)
	if err != nil {
		return store.PersonalAgentRunPreference{}, "", err
	}
	if err := validateExecutionChoice(choice); err != nil {
		return store.PersonalAgentRunPreference{}, "", err
	}
	if choice.WorkerGroupID != "" {
		group, err := s.store.GetWorkerGroup(ctx, choice.WorkerGroupID)
		if errors.Is(err, store.ErrWorkerGroupNotFound) || err == nil && group.OwnerUserID != agent.UserID {
			return store.PersonalAgentRunPreference{}, "", invalid("worker group %q is not one of this person's groups", choice.WorkerGroupID)
		}
		if err != nil {
			return store.PersonalAgentRunPreference{}, "", err
		}
		member, err := s.accounts.ChooseWorkerGroupMember(ctx, group, workspace)
		if err != nil {
			return store.PersonalAgentRunPreference{}, "", err
		}
		choice.ProviderKind, choice.ProviderID = store.ExecutionModelChoiceProviderKind(member.ProviderKind), member.ProviderID
		choice.Runtime, choice.Model, choice.Effort = member.Runtime, member.Model, member.Effort
	}
	base, err := personalagent.RunPreference(agent.Settings, "executor")
	if err != nil {
		return store.PersonalAgentRunPreference{}, "", invalid("%v", err)
	}
	preference := store.PersonalAgentRunPreference{
		ProfileID: choice.ProviderID, Runtime: string(choice.Runtime), Model: choice.Model, Effort: choice.Effort,
		TokenBudget: base.TokenBudget, TimeoutMinutes: base.TimeoutMinutes,
	}
	if err := personalagent.ValidateRunPreference(preference); err != nil {
		return store.PersonalAgentRunPreference{}, "", invalid("%v", err)
	}
	return preference, reason, nil
}

// Pin is the run of the assistant's operationID, resolved the first time
// and kept: asked again, it answers the same snapshot, and refuses another
// role or workspace for the operation.
func (s *Resolver) Pin(ctx context.Context, agent store.PersonalAgent, operationID, role, workspaceID string) (store.PersonalAgentRunSnapshot, error) {
	return s.PinExecutor(ctx, agent, operationID, role, workspaceID, "default")
}

// PinExecutor is Pin with the coordinator's choice for a new helper.
func (s *Resolver) PinExecutor(ctx context.Context, agent store.PersonalAgent, operationID, role, workspaceID, executionChoice string) (store.PersonalAgentRunSnapshot, error) {
	id := flow.Key("parun", agent.UserID, operationID)
	existing, err := s.store.GetPersonalAgentRunSnapshot(ctx, agent.ID, id)
	if err == nil {
		if existing.Role != role || existing.WorkspaceID != workspaceID {
			return existing, &personalagent.Refusal{Status: http.StatusConflict, Err: store.ErrIdempotencyConflict}
		}
		return existing, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return existing, err
	}
	var snapshot store.PersonalAgentRunSnapshot
	if role == "executor" {
		snapshot, err = s.ResolveExecutor(ctx, agent, workspaceID, executionChoice)
	} else {
		snapshot, err = s.Resolve(ctx, agent, role, workspaceID)
	}
	if err != nil {
		return snapshot, err
	}
	snapshot.ID = id
	snapshot.InputID = flow.InputID(operationID)
	return s.store.RecordPersonalAgentRunSnapshot(ctx, snapshot)
}

// ReasonContinuedSession is a run's selection reason when it continues a
// session in that session's own account and model (§f-4: a conversation
// does not change model midway).
const ReasonContinuedSession = "continued_session"

// PinSession is Pin for an operation that continues session: the run keeps
// the session's own account, model and effort, with the role's budget. It
// checks only that the session's computer, workspace and the person's
// permission still allow it, never the role's account choice.
func (s *Resolver) PinSession(ctx context.Context, agent store.PersonalAgent, operationID, role string, session store.AgentSession) (store.PersonalAgentRunSnapshot, error) {
	id := flow.Key("parun", agent.UserID, operationID)
	existing, err := s.store.GetPersonalAgentRunSnapshot(ctx, agent.ID, id)
	if err == nil {
		if existing.Role != role || existing.WorkspaceID != session.WorkspaceID {
			return existing, &personalagent.Refusal{Status: http.StatusConflict, Err: store.ErrIdempotencyConflict}
		}
		return existing, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return existing, err
	}
	preference, err := personalagent.RunPreference(agent.Settings, role)
	if err != nil {
		return store.PersonalAgentRunSnapshot{}, invalid("%v", err)
	}
	workspace, err := s.store.GetWorkspace(ctx, session.WorkspaceID)
	if err != nil {
		return store.PersonalAgentRunSnapshot{}, err
	}
	if err := store.RequireDeviceAvailable(ctx, s.store, workspace.DeviceID); err != nil {
		return store.PersonalAgentRunSnapshot{}, err
	}
	roles, err := s.store.WorkspaceRolesForUser(ctx, agent.UserID)
	if err != nil {
		return store.PersonalAgentRunSnapshot{}, err
	}
	if !store.WorkspaceRoleAtLeast(roles[workspace.ID], store.WorkspaceRoleMember) {
		return store.PersonalAgentRunSnapshot{}, &personalagent.Refusal{Status: http.StatusForbidden, Err: errors.New("workspace permission does not allow this role")}
	}
	if workspace.ArchivedAt != "" || workspace.UnavailableOnDevice != nil {
		return store.PersonalAgentRunSnapshot{}, invalid("workspace_unavailable")
	}
	effort := session.ClaudeEffort
	if session.Provider == "codex" {
		effort = session.CodexReasoningEffort
	}
	configHash, err := flow.Fingerprint(struct {
		Role, Session, Device, Workspace, Profile, Runtime, Model, Effort string
	}{role, session.ID, workspace.DeviceID, workspace.ID, session.ProfileID, session.Provider, session.Model, effort})
	if err != nil {
		return store.PersonalAgentRunSnapshot{}, err
	}
	return s.store.RecordPersonalAgentRunSnapshot(ctx, store.PersonalAgentRunSnapshot{
		ID: id, InputID: flow.InputID(operationID), UserID: agent.UserID, AssistantID: agent.ID, Role: role,
		WorkspaceID: workspace.ID, DeviceID: workspace.DeviceID, Runtime: session.Provider, ProfileID: session.ProfileID,
		AgentID: session.AgentID, Model: session.Model, Effort: effort, ConfigHash: configHash,
		TokenBudget: preference.TokenBudget, TimeoutMinutes: preference.TimeoutMinutes, SelectionReason: ReasonContinuedSession,
	})
}

// SessionInput is the session a pinned run starts with prompt.
func SessionInput(snapshot store.PersonalAgentRunSnapshot, prompt, inputID string) store.CreateAgentSessionInput {
	input := store.CreateAgentSessionInput{
		CreatedByUserID: snapshot.UserID, WorkspaceID: snapshot.WorkspaceID,
		ProfileID: snapshot.ProfileID, Provider: snapshot.Runtime, Model: snapshot.Model,
		Prompt: prompt, InputID: inputID, Source: store.SessionSourceChat,
		ExecutionBudget: ExecutionBudget(snapshot),
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

// CheckPinned refuses a pinned run that would no longer run as pinned:
// its computer, workspace, permission or account changed.
func (s *Resolver) CheckPinned(ctx context.Context, snapshot store.PersonalAgentRunSnapshot) error {
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
	if !store.WorkspaceRoleAtLeast(roles[workspace.ID], required) {
		return fmt.Errorf("workspace permission changed")
	}
	agent, e := s.store.GetAssistant(ctx, snapshot.AssistantID)
	if e != nil {
		return e
	}
	if snapshot.Role != "coordinator" && !personalagent.DeviceSettings(agent.Settings.Devices, workspace.DeviceID, agent.HomeDeviceID).AllowWork {
		return fmt.Errorf("execution_on_device_not_allowed")
	}
	accounts, err := s.accounts.WorkspaceAccounts(ctx, workspace, snapshot.UserID)
	if err != nil {
		return err
	}
	for _, account := range accounts {
		if account.ProfileID == snapshot.ProfileID && account.Usable && account.Runtime == snapshot.Runtime &&
			(snapshot.ProfileFingerprint == "" || snapshot.ProfileFingerprint == account.Agent.ProfileFingerprint) {
			current, e := s.AccountConfiguration(ctx, workspace, account)
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

// ExecutionBudget is the budget a pinned run's input carries.
func ExecutionBudget(snapshot store.PersonalAgentRunSnapshot) *store.SessionExecutionBudget {
	return &store.SessionExecutionBudget{SnapshotID: snapshot.ID, TokenBudget: snapshot.TokenBudget, TimeoutMinutes: snapshot.TimeoutMinutes}
}

// Opaque configuration hash, not an authentication assertion. Credentials are
// never read here. Rotation of a key within the same configured account remains
// that account's operation, not permission to silently choose another provider.
func providerConfiguration(p store.ProfileDefinition) string {
	value, _ := flow.Fingerprint(struct {
		Runtime, Auth, Connection, URL, Prefix, ClaudePermission, CodexSandbox, CodexApproval, Transport, Speed string
		Windows                                                                                                 map[string]int64
	}{p.Runtime, p.AuthMode, p.ConnectionType, p.BaseURL, p.PromptPrefix, p.ClaudePermissionMode, p.CodexSandboxMode, p.CodexApprovalPolicy, p.CodexTransport, p.CodexSpeed, p.ContextWindows})
	return value
}

// Binds observed configuration and cached identity, never credentials or an
// assertion that the provider has authenticated this account online.
func (s *Resolver) AccountConfiguration(ctx context.Context, workspace store.WorkspaceProjection, account Account) (string, error) {
	if account.Kind == "model_service" {
		p, err := s.store.GetProfile(ctx, account.ProfileID)
		if err != nil {
			return "", err
		}
		return providerConfiguration(p), nil
	}
	p := fallbackProfile(account)
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
	return deviceConfiguration(p), nil
}

func fallbackProfile(account Account) store.AgentProfileProjection {
	return store.AgentProfileProjection{ID: account.ProfileID, Runtime: account.Runtime, Fingerprint: account.Agent.ProfileFingerprint, ConnectionType: account.Agent.ConnectionType, AuthMode: account.Agent.AuthMode, ConfigScope: account.Agent.ConfigScope, ConfigLabel: account.Agent.ConfigLabel}
}

func deviceConfiguration(p store.AgentProfileProjection) string {
	value, _ := flow.Fingerprint(struct {
		Runtime, Profile, Fingerprint, Connection, URL, AccountLabel, AuthMode, Scope, Section, KeySource, Command string
	}{p.Runtime, p.ID, p.Fingerprint, p.ConnectionType, p.BaseURL, p.AccountLabel, p.AuthMode, p.ConfigScope, p.ConfigSection, p.KeySource, p.CommandLabel})
	return value
}

// settled is an account's profile, model and effort for a run.
type settled struct {
	profile            store.AgentProfileProjection
	providerConfigHash string
	model, effort      string
}

// settle reads chosen's profile on the workspace's computer and checks the
// preference's model and effort against it.
func (s *Resolver) settle(ctx context.Context, workspace store.WorkspaceProjection, chosen Account, preference store.PersonalAgentRunPreference) (settled, error) {
	providerConfigHash := ""
	var profile store.AgentProfileProjection
	profiles, err := s.store.ListAgentProfiles(ctx, workspace.DeviceID)
	if err != nil {
		return settled{}, err
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
			return settled{}, err
		}
		providerConfigHash = providerConfiguration(service)
		profile.ID, profile.Runtime, profile.Model, profile.Models = service.ID, service.Runtime, service.Model, service.Models
		profile.BaseURL, profile.ClaudeEffort, profile.CodexReasoningEffort = service.BaseURL, service.ClaudeEffort, service.CodexReasoningEffort
	}
	if chosen.Kind != "model_service" {
		if profile.ID == "" {
			profile = fallbackProfile(chosen)
		}
		providerConfigHash = deviceConfiguration(profile)
	}
	model := preference.Model
	if model == "" {
		model = profile.Model
	}
	if len(profile.Models) > 0 && model != "" && model != profile.Model && !slices.Contains(profile.Models, model) {
		return settled{}, invalid("model_unavailable: the chosen account does not advertise this model")
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
		return settled{}, invalid("effort is not supported by this runtime")
	}
	return settled{profile: profile, providerConfigHash: providerConfigHash, model: model, effort: effort}, nil
}

// personMemoryWorkspace is whether workspaceID holds the person's memory
// layer, which every assistant of theirs recalls (knowledge.Recalls): its
// upkeep may run as any of them, whatever their permission package lists.
func (s *Resolver) personMemoryWorkspace(ctx context.Context, user, workspaceID string) bool {
	vaults, err := s.store.ListKnowledgeVaults(ctx, user)
	if err != nil {
		return false
	}
	for _, v := range vaults {
		if v.Kind == "memory" && v.Scope == store.MemoryScopePerson && v.WorkspaceID == workspaceID {
			return true
		}
	}
	return false
}
