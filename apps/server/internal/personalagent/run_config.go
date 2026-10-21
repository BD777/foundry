package personalagent

import (
	"fmt"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var RunRoles = []string{"coordinator", "memory", "governance", "executor"}

func RunPreference(settings store.PersonalAgentSettings, role string) (store.PersonalAgentRunPreference, error) {
	if !slices.Contains(RunRoles, role) {
		return store.PersonalAgentRunPreference{}, fmt.Errorf("unknown assistant role %q", role)
	}
	preference := store.PersonalAgentRunPreference{ProfileID: "device_default"}
	if settings.RunDefault != nil {
		preference = *settings.RunDefault
	} else if role == "coordinator" || settings.DelegateModel == "same_as_assistant" {
		if settings.AssistantProfileID != "" {
			preference.ProfileID = settings.AssistantProfileID
		}
		preference.Model = settings.AssistantModel
	}
	if override, ok := settings.RoleOverrides[role]; ok {
		preference = override
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
