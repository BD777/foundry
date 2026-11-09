package personalagent

import (
	"fmt"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// RunRoles are the assistant's flows that run a model (docs/assistant-
// orchestration.md §g): its conversation (coordinator), the work it hands
// off (executor), project summaries (digest), memory and project upkeep.
var RunRoles = []string{"coordinator", "executor", "digest", "memory", "governance"}

// RunPreference is how one flow runs: its own override when the person set
// one; else the conversation its default (runDefault, then the older
// assistant fields), the helpers DEV-150's hand-off choice, and every other
// flow the assistant's own choice, resolved on its target project's
// computer.
func RunPreference(settings store.PersonalAgentSettings, role string) (store.PersonalAgentRunPreference, error) {
	if !slices.Contains(RunRoles, role) {
		return store.PersonalAgentRunPreference{}, fmt.Errorf("unknown assistant role %q", role)
	}
	preference, ok := settings.RoleOverrides[role]
	if !ok {
		switch role {
		case "coordinator":
			preference = assistantDefault(settings)
		case "executor":
			preference = store.PersonalAgentRunPreference{ProfileID: "device_default"}
			if settings.RunDefault != nil || settings.DelegateModel == "same_as_assistant" {
				preference = assistantChoice(settings)
			}
		default:
			preference = assistantChoice(settings)
		}
	}
	if preference.TokenBudget == 0 {
		preference.TokenBudget = 500000
	}
	if preference.TimeoutMinutes == 0 {
		preference.TimeoutMinutes = 30
	}
	if preference.ProfileID == "" {
		preference.ProfileID = "device_default"
	}
	return preference, ValidateRunPreference(preference)
}

// assistantDefault is the conversation's choice without its own override.
func assistantDefault(settings store.PersonalAgentSettings) store.PersonalAgentRunPreference {
	if settings.RunDefault != nil {
		return *settings.RunDefault
	}
	preference := store.PersonalAgentRunPreference{ProfileID: "device_default", Model: settings.AssistantModel}
	if settings.AssistantProfileID != "" {
		preference.ProfileID = settings.AssistantProfileID
	}
	return preference
}

// assistantChoice is the assistant's own choice for a flow that follows it:
// its account and model, on whichever computer that flow runs.
func assistantChoice(settings store.PersonalAgentSettings) store.PersonalAgentRunPreference {
	preference, ok := settings.RoleOverrides["coordinator"]
	if !ok {
		preference = assistantDefault(settings)
	}
	preference.DeviceID = ""
	return preference
}

func ValidateRunPreference(preference store.PersonalAgentRunPreference) error {
	if preference.Runtime != "" && !slices.Contains([]string{"claude", "codex"}, preference.Runtime) {
		return fmt.Errorf("runtime must be claude or codex")
	}
	if preference.TokenBudget < 0 || preference.TokenBudget > 10000000 {
		return fmt.Errorf("token budget must be between 0 and 10000000")
	}
	if preference.TimeoutMinutes < 0 || preference.TimeoutMinutes > 240 {
		return fmt.Errorf("run timeout must be between 0 and 240 minutes")
	}
	for _, value := range []string{preference.DeviceID, preference.ProfileID, preference.Model, preference.Effort} {
		if len(value) > 200 || strings.ContainsAny(value, "\r\n\t") {
			return fmt.Errorf("run choices must be short single-line values")
		}
	}
	if !slices.Contains([]string{"", "wait", "device_default"}, preference.WhenUnavailable) {
		return fmt.Errorf("whenUnavailable must be wait or device_default")
	}
	if len(preference.Fallbacks) > 3 {
		return fmt.Errorf("at most three explicit fallback targets are allowed")
	}
	for _, fallback := range preference.Fallbacks {
		if fallback.DeviceID == "" || fallback.ProfileID == "" || fallback.ProfileID == "device_default" || len(fallback.WorkspaceIDs) == 0 {
			return fmt.Errorf("fallbacks require an explicit device, account and allowed workspaces")
		}
		if err := ValidateRunPreference(store.PersonalAgentRunPreference{DeviceID: fallback.DeviceID, ProfileID: fallback.ProfileID, Runtime: fallback.Runtime, Model: fallback.Model, Effort: fallback.Effort}); err != nil {
			return err
		}
	}
	return nil
}
