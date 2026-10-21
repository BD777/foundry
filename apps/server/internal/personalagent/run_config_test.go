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
