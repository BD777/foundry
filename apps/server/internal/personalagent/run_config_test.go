package personalagent

import (
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestRoleOverrideDoesNotAccidentallyInheritAnotherDeviceAccount(t *testing.T) {
	settings := DefaultSettings()
	settings.RunDefault = &store.PersonalAgentRunPreference{ProfileID: "account-a", DeviceID: "device-a", Model: "model-a"}
	settings.RoleOverrides = map[string]store.PersonalAgentRunPreference{
		"memory": {ProfileID: "account-b", DeviceID: "device-b", Model: "model-b"},
	}
	memory, err := RunPreference(settings, "memory")
	if err != nil || memory.ProfileID != "account-b" || memory.DeviceID != "device-b" || memory.Model != "model-b" {
		t.Fatalf("mixed defaults: %+v %v", memory, err)
	}
	coordinator, err := RunPreference(settings, "coordinator")
	if err != nil || coordinator.ProfileID != "account-a" || coordinator.TokenBudget != 500000 || coordinator.TimeoutMinutes == 0 {
		t.Fatalf("default: %+v %v", coordinator, err)
	}
	if _, err := RunPreference(settings, "unknown"); err == nil {
		t.Fatal("unknown role accepted")
	}
	if err := ValidateRunPreference(store.PersonalAgentRunPreference{Fallbacks: []store.PersonalAgentRunTarget{{DeviceID: "device-b", ProfileID: "device_default"}}}); err == nil {
		t.Fatal("unbounded default-account fallback accepted")
	}
}

// The settings page's three choices for the work the assistant hands off.
func TestHelperChoices(t *testing.T) {
	settings := DefaultSettings()
	settings.RunDefault = &store.PersonalAgentRunPreference{ProfileID: "smart", Model: "big", DeviceID: "home"}
	settings.DelegateModel = "same_as_assistant"
	if same, err := RunPreference(settings, "executor"); err != nil || same.ProfileID != "smart" || same.Model != "big" {
		t.Fatalf("same as the assistant: %+v %v", same, err)
	}
	settings.RoleOverrides = map[string]store.PersonalAgentRunPreference{"executor": {ProfileID: "device_default"}}
	if each, err := RunPreference(settings, "executor"); err != nil || each.ProfileID != "device_default" || each.Model != "" {
		t.Fatalf("each computer's default: %+v %v", each, err)
	}
	settings.RoleOverrides["executor"] = store.PersonalAgentRunPreference{ProfileID: "cheap", Model: "small", WhenUnavailable: "device_default"}
	if chosen, err := RunPreference(settings, "executor"); err != nil || chosen.ProfileID != "cheap" || chosen.WhenUnavailable != "device_default" {
		t.Fatalf("chosen: %+v %v", chosen, err)
	}
	if assistant, err := RunPreference(settings, "coordinator"); err != nil || assistant.ProfileID != "smart" {
		t.Fatalf("assistant changed with its helpers: %+v %v", assistant, err)
	}
	if err := ValidateRunPreference(store.PersonalAgentRunPreference{WhenUnavailable: "anything"}); err == nil {
		t.Fatal("unknown whenUnavailable accepted")
	}
}
