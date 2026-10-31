package httpapi

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Default agents (DEV-068, docs/models-and-accounts.md "默认智能体"). A
// session whose start names no account runs under the first of, most
// specific first: the Feishu chat's default, the workspace's Feishu bot's,
// the workspace's, then the person's own (pickAccount: last used, their
// default, the first usable). Each level may set the account, the model
// and the effort; what it leaves unset falls through. A configured account
// that cannot run here is passed over, and the session's transcript says
// so: the session is never refused, nor silently run on it.

// Levels a default agent comes from, besides pickAccount's.
const (
	agentFromFeishuChat = string(store.AgentDefaultFeishuChat)
	agentFromFeishuBot  = string(store.AgentDefaultFeishuBot)
	agentFromWorkspace  = string(store.AgentDefaultWorkspace)
)

// accountMissing: a configured account is not on the workspace's device.
const accountMissing = "missing"

// agentDefaultLevel is one level's default, as resolution reads it.
type agentDefaultLevel struct {
	source string
	value  store.AgentDefault
}

// skippedDefault is a configured account resolution passed over.
type skippedDefault struct {
	Source      string `json:"source"`
	ProfileID   string `json:"profileId"`
	AccountName string `json:"accountName,omitempty"`
	// Problem: not_signed_in, not_ready or missing.
	Problem string `json:"problem"`
}

// agentChoice is the agent a session started without an account runs as,
// and where each part of it came from.
type agentChoice struct {
	ProfileID     string `json:"profileId,omitempty"`
	Runtime       string `json:"runtime"`
	AccountName   string `json:"accountName"`
	AccountSource string `json:"accountSource"`
	// Model and Effort are "" where nothing sets them: the account's own
	// default applies.
	Model        string           `json:"model,omitempty"`
	ModelSource  string           `json:"modelSource,omitempty"`
	Effort       string           `json:"effort,omitempty"`
	EffortSource string           `json:"effortSource,omitempty"`
	Skipped      []skippedDefault `json:"skipped,omitempty"`

	agent store.AgentProjection
}

// validEffort reports whether effort is one of runtime's.
func validEffort(runtime, effort string) bool {
	switch runtime {
	case "claude":
		return slices.Contains([]string{"low", "medium", "high", "xhigh", "max"}, effort)
	case "codex":
		return slices.Contains([]string{"minimal", "low", "medium", "high", "xhigh"}, effort)
	}
	return false
}

// agentDefaultLevels are the defaults that apply in the workspace, most
// specific first; routeID adds a Feishu topic's chat and bot.
func (s *Server) agentDefaultLevels(ctx context.Context, workspaceID, routeID string) []agentDefaultLevel {
	backing, ok := s.store.(store.AgentDefaultStore)
	if !ok || workspaceID == "" {
		return nil
	}
	defaults, err := backing.ListAgentDefaults(ctx, workspaceID)
	if err != nil {
		return nil
	}
	return defaultLevelsFor(defaults, routeID)
}

// defaultLevelsFor orders a workspace's defaults for a start from routeID
// ("" the Web or an agent).
func defaultLevelsFor(defaults []store.AgentDefault, routeID string) []agentDefaultLevel {
	find := func(scope store.AgentDefaultScope, route string) (store.AgentDefault, bool) {
		index := slices.IndexFunc(defaults, func(value store.AgentDefault) bool {
			return value.Scope == scope && value.RouteID == route
		})
		if index < 0 {
			return store.AgentDefault{}, false
		}
		return defaults[index], true
	}
	var levels []agentDefaultLevel
	if routeID != "" {
		if value, ok := find(store.AgentDefaultFeishuChat, routeID); ok {
			levels = append(levels, agentDefaultLevel{agentFromFeishuChat, value})
		}
		if value, ok := find(store.AgentDefaultFeishuBot, ""); ok {
			levels = append(levels, agentDefaultLevel{agentFromFeishuBot, value})
		}
	}
	if value, ok := find(store.AgentDefaultWorkspace, ""); ok {
		levels = append(levels, agentDefaultLevel{agentFromWorkspace, value})
	}
	return levels
}

// resolveAgent chooses the agent for a start naming no account (runtime:
// the one it named, "" none). The account is the first level's that is
// usable here, else pickAccount's. A model or effort applies from the
// first level that set one for this account: a level naming it, or one
// naming none that is more specific than the level that chose it (a less
// specific one chose for an account since overridden), and only for the
// runtime it was chosen for. ok is false when no account is usable.
func resolveAgent(accounts []workspaceAccount, levels []agentDefaultLevel, runtime, preferred string) (agentChoice, bool) {
	var choice agentChoice
	var account workspaceAccount
	chosenAt := len(levels)
	for index, level := range levels {
		profileID := level.value.ProfileID
		if profileID == "" {
			continue
		}
		found := slices.IndexFunc(accounts, func(candidate workspaceAccount) bool { return candidate.ProfileID == profileID })
		switch {
		case found < 0:
			choice.Skipped = append(choice.Skipped, skippedDefault{Source: level.source, ProfileID: profileID, Problem: accountMissing})
			continue
		case runtime != "" && accounts[found].Runtime != runtime:
			// The start asked for another runtime: not a problem of the default.
			continue
		case !accounts[found].Usable:
			choice.Skipped = append(choice.Skipped, skippedDefault{
				Source: level.source, ProfileID: profileID, AccountName: accounts[found].Name,
				Problem: cmp.Or(accounts[found].Problem, accountNotReady),
			})
			continue
		}
		account, choice.AccountSource, chosenAt = accounts[found], level.source, index
		break
	}
	if chosenAt == len(levels) {
		picked, source, ok := pickAccountFrom(accounts, runtime, preferred)
		if !ok {
			return choice, false
		}
		account, choice.AccountSource = picked, source
	}
	choice.ProfileID, choice.Runtime, choice.AccountName, choice.agent = account.ProfileID, account.Runtime, account.Name, account.agent
	for index, level := range levels {
		value := level.value
		fits := (value.ProfileID == account.ProfileID || value.ProfileID == "" && index < chosenAt) &&
			(value.Runtime == "" || value.Runtime == account.Runtime)
		if !fits {
			continue
		}
		if choice.Model == "" && value.Model != "" {
			choice.Model, choice.ModelSource = value.Model, level.source
		}
		if choice.Effort == "" && validEffort(account.Runtime, value.Effort) {
			choice.Effort, choice.EffortSource = value.Effort, level.source
		}
	}
	return choice, true
}

// chooseAgent is resolveAgent over the workspace's accounts for userID.
// ok is false for a workspace whose device reported no account at all,
// left to the caller as before; with accounts but none usable it is
// refused with no_usable_account.
func (s *Server) chooseAgent(ctx context.Context, workspace store.WorkspaceProjection, levels []agentDefaultLevel, runtime, userID string) (agentChoice, bool, error) {
	accounts, err := s.workspaceAccounts(ctx, workspace, userID)
	if err != nil || len(accounts) == 0 {
		return agentChoice{}, false, err
	}
	if choice, ok := resolveAgent(accounts, levels, runtime, s.defaultAccountOf(ctx, userID)); ok {
		return choice, true, nil
	}
	return agentChoice{}, false, &statusError{http.StatusConflict, &noUsableAccountError{
		device: cmp.Or(workspace.DeviceLabel, workspace.DeviceID), runtime: runtime, accounts: accounts,
	}}
}

// apply pins the choice on a session input that named no account, keeping
// the model and effort it named.
func (choice agentChoice) apply(input *store.CreateAgentSessionInput) {
	// An agent reported without a profile (older workers) is named by id.
	if choice.ProfileID == "" {
		input.AgentID = choice.agent.ID
	}
	input.ProfileID, input.Provider = choice.ProfileID, choice.Runtime
	input.Model = cmp.Or(input.Model, choice.Model)
	switch choice.Runtime {
	case "claude":
		input.ClaudeEffort = cmp.Or(input.ClaudeEffort, choice.Effort)
	case "codex":
		input.CodexReasoningEffort = cmp.Or(input.CodexReasoningEffort, choice.Effort)
	}
	// The transcript says which default was passed over.
	if note := choice.note(); note != "" && input.ProfileTransitionNote == "" {
		input.ProfileTransitionNote = note
	}
}

// note tells, in the session's transcript, which configured default
// account could not be used and what ran instead; "" when none was
// passed over.
func (choice agentChoice) note() string {
	if len(choice.Skipped) == 0 {
		return ""
	}
	levels := map[string]string{
		agentFromFeishuChat: "this Feishu chat's default", agentFromFeishuBot: "the Feishu bot's default",
		agentFromWorkspace: "the workspace default", accountLastUsed: "your last used account",
		accountPersonal: "your default account", accountFirstUsable: "the first usable account",
	}
	problems := map[string]string{
		accountNotSignedIn: "it is not signed in", accountNotReady: "its check did not pass", accountMissing: "it is not on this device",
	}
	passed := make([]string, 0, len(choice.Skipped))
	for _, skipped := range choice.Skipped {
		passed = append(passed, fmt.Sprintf("%s account %q (%s)", levels[skipped.Source], cmp.Or(skipped.AccountName, skipped.ProfileID), problems[skipped.Problem]))
	}
	return fmt.Sprintf("Default agent: passed over %s; this session runs on %q, %s.",
		strings.Join(passed, " and "), choice.AccountName, levels[choice.AccountSource])
}

// agentDefaultView is one configured default as the Web shows it: the
// account's name, and why it cannot be used now.
type agentDefaultView struct {
	store.AgentDefault
	AccountName string `json:"accountName,omitempty"`
	Problem     string `json:"problem,omitempty"`
}

// workspaceAgentDefaults is GET /api/workspaces/{id}/agent-defaults: what
// is configured, the accounts to choose from, and what a new chat, a new
// Feishu topic and a new topic in each paired chat would run as.
type workspaceAgentDefaults struct {
	WorkspaceID string             `json:"workspaceId"`
	Defaults    []agentDefaultView `json:"defaults"`
	Accounts    []workspaceAccount `json:"accounts"`
	// Effective is a new Web chat's, for the caller; nil when no account
	// can run one.
	Effective *agentChoice `json:"effective,omitempty"`
	// FeishuBot is a new topic's in a chat without an override, for the
	// caller; nil without a Feishu bot.
	FeishuBot *agentChoice `json:"feishuBot,omitempty"`
	// FeishuChats are, by route id, a new topic's in each chat, for the
	// person the bot acts as there.
	FeishuChats map[string]agentChoice `json:"feishuChats,omitempty"`
}

func (s *Server) agentDefaultsAnswer(ctx context.Context, workspace store.WorkspaceProjection, userID string) (workspaceAgentDefaults, error) {
	answer := workspaceAgentDefaults{WorkspaceID: workspace.ID, Defaults: []agentDefaultView{}}
	var defaults []store.AgentDefault
	if backing, ok := s.store.(store.AgentDefaultStore); ok {
		var err error
		if defaults, err = backing.ListAgentDefaults(ctx, workspace.ID); err != nil {
			return answer, err
		}
	}
	accounts, err := s.workspaceAccounts(ctx, workspace, "")
	if err != nil {
		return answer, err
	}
	answer.Accounts = accounts
	for _, value := range defaults {
		view := agentDefaultView{AgentDefault: value}
		if value.ProfileID != "" {
			view.Problem = accountMissing
			if index := slices.IndexFunc(accounts, func(account workspaceAccount) bool { return account.ProfileID == value.ProfileID }); index >= 0 {
				view.AccountName = accounts[index].Name
				view.Problem = ""
				if !accounts[index].Usable {
					view.Problem = cmp.Or(accounts[index].Problem, accountNotReady)
				}
			}
		}
		answer.Defaults = append(answer.Defaults, view)
	}
	sessions, _ := s.store.ListAgentSessionSummaries(ctx, workspace.ID)
	resolveFor := func(routeID, user string) (agentChoice, bool) {
		worked := accountsWorkedIn(sessions, user)
		own := make([]workspaceAccount, len(accounts))
		for index, account := range accounts {
			account.LastWorkedAt = worked[account.ProfileID]
			own[index] = account
		}
		return resolveAgent(own, defaultLevelsFor(defaults, routeID), "", s.defaultAccountOf(ctx, user))
	}
	if choice, ok := resolveFor("", userID); ok {
		answer.Effective = &choice
	}
	routes, err := s.store.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{WorkspaceID: workspace.ID})
	if err != nil {
		return answer, err
	}
	for _, route := range routes {
		if route.WorkspaceID != workspace.ID {
			continue
		}
		if route.Kind == store.FeishuRoutePairing {
			// Any route id that is not a chat's: the bot's own levels.
			if choice, ok := resolveFor(route.ID, userID); ok {
				answer.FeishuBot = &choice
			}
			continue
		}
		if choice, ok := resolveFor(route.ID, route.BoundUserID); ok {
			if answer.FeishuChats == nil {
				answer.FeishuChats = map[string]agentChoice{}
			}
			answer.FeishuChats[route.ID] = choice
		}
	}
	return answer, nil
}

// handleGetAgentDefaults answers the workspace's default agents.
func (s *Server) handleGetAgentDefaults(w http.ResponseWriter, r *http.Request) {
	workspace, err := s.store.GetWorkspace(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	answer, err := s.agentDefaultsAnswer(r.Context(), workspace, actorFromContext(r.Context()).AccountID())
	writeResult(w, answer, err)
}

// agentDefaultRequest sets one level's default; empty fields inherit.
type agentDefaultRequest struct {
	Scope     store.AgentDefaultScope `json:"scope"`
	RouteID   string                  `json:"routeId,omitempty"`
	ProfileID string                  `json:"profileId,omitempty"`
	// Runtime is the inherited account's, for a model or effort set
	// without an account; an account's own runtime wins.
	Runtime string `json:"runtime,omitempty"`
	Model   string `json:"model,omitempty"`
	Effort  string `json:"effort,omitempty"`
}

// handleSetAgentDefault sets one level's default agent (workspace
// maintainers). The account must be one of the workspace's device; one
// that cannot run now may still be chosen, and shows as unusable.
func (s *Server) handleSetAgentDefault(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var request agentDefaultRequest
	if !decodeJSONRequest(w, r, &request) {
		return
	}
	workspace, err := s.store.GetWorkspace(ctx, r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	backing, ok := s.store.(store.AgentDefaultStore)
	if !ok {
		writeError(w, http.StatusNotImplemented, "default agents are not available on this server")
		return
	}
	value, err := s.validAgentDefault(ctx, workspace, request)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	value.UpdatedBy = actorFromContext(ctx).AccountID()
	if err := backing.SetAgentDefault(ctx, value); err != nil {
		writeResult(w, nil, err)
		return
	}
	answer, err := s.agentDefaultsAnswer(ctx, workspace, value.UpdatedBy)
	writeResult(w, answer, err)
}

// validAgentDefault checks a request against the workspace: its scope, the
// chat it names, the account and the effort for the runtime.
func (s *Server) validAgentDefault(ctx context.Context, workspace store.WorkspaceProjection, request agentDefaultRequest) (store.AgentDefault, error) {
	refuse := func(message string) (store.AgentDefault, error) {
		return store.AgentDefault{}, &statusError{http.StatusBadRequest, errors.New(message)}
	}
	value := store.AgentDefault{
		WorkspaceID: workspace.ID, Scope: request.Scope, ProfileID: strings.TrimSpace(request.ProfileID),
		Runtime: strings.TrimSpace(request.Runtime), Model: strings.TrimSpace(request.Model), Effort: strings.TrimSpace(request.Effort),
	}
	if !store.ValidAgentDefaultScope(value.Scope) {
		return refuse("scope must be workspace, feishu_bot or feishu_chat")
	}
	if value.Scope == store.AgentDefaultFeishuChat {
		value.RouteID = strings.TrimSpace(request.RouteID)
		routes, err := s.store.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{WorkspaceID: workspace.ID})
		if err != nil {
			return store.AgentDefault{}, err
		}
		if !slices.ContainsFunc(routes, func(route store.FeishuBotRoute) bool {
			return route.ID == value.RouteID && route.WorkspaceID == workspace.ID && route.Kind != store.FeishuRoutePairing
		}) {
			return store.AgentDefault{}, &statusError{http.StatusNotFound, errors.New("that Feishu chat is not paired with this workspace")}
		}
	}
	if len(value.Model) > 200 {
		return refuse("model is too long")
	}
	if value.ProfileID != "" {
		accounts, err := s.workspaceAccounts(ctx, workspace, "")
		if err != nil {
			return store.AgentDefault{}, err
		}
		index := slices.IndexFunc(accounts, func(account workspaceAccount) bool { return account.ProfileID == value.ProfileID })
		if index < 0 {
			return refuse("that account is not on this workspace's device")
		}
		value.Runtime = accounts[index].Runtime
	}
	if value.Runtime != "" && value.Runtime != "claude" && value.Runtime != "codex" {
		return refuse("runtime must be claude or codex")
	}
	if value.Effort != "" && (value.Runtime == "" || !validEffort(value.Runtime, value.Effort)) {
		return refuse(fmt.Sprintf("effort %q is not one of the %s runtime's", value.Effort, cmp.Or(value.Runtime, "chosen")))
	}
	if value.Model == "" && value.Effort == "" && value.ProfileID == "" {
		value.Runtime = ""
	}
	return value, nil
}
