package httpapi

import (
	"slices"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestWindowSelectionRequiresMacWorkerCapability(t *testing.T) {
	spec, _ := resources.Spec("computer_use")
	base := store.ResourceInstance{
		Type: "computer_use", Platform: "macos",
		Backends: []store.ResourceBackend{{ID: "cua-driver", Mode: "remote_ops"}},
	}
	if slices.Contains(resourceOperationNames(base, spec), "select_window") {
		t.Fatal("old workers must not advertise lease-local selection")
	}
	base.Details = map[string]string{"windowScope": "v1"}
	if !slices.Contains(resourceOperationNames(base, spec), "select_window") {
		t.Fatal("new Mac provider selection was hidden")
	}
	base.Platform = "windows"
	if supportsWindowScope(base) {
		t.Fatal("Mac scope must not claim support for other platforms")
	}
	base.Platform = "macos"
	base.Backends[0].Mode = "native_session"
	if supportsWindowScope(base) {
		t.Fatal("native shell control has no remote window scope")
	}
}

func TestMacRollingUpgradeDoesNotUseOldImplicitForegroundOrDesktop(t *testing.T) {
	actions := []store.ResourceAction{{Op: "drag", Args: map[string]any{"pid": 42, "window_id": 7}}}
	if err := prepareMacWindowActions(actions, false); err != nil {
		t.Fatal(err)
	}
	if actions[0].Args["delivery_mode"] != "background" {
		t.Fatal("old worker would force omitted drag mode to foreground")
	}
	if err := prepareMacWindowActions([]store.ResourceAction{{Op: "activate_window"}}, false); err == nil {
		t.Fatal("unrequested activation accepted")
	}
	if err := prepareMacWindowActions([]store.ResourceAction{{Op: "screenshot"}}, false); err == nil {
		t.Fatal("old worker would interpret an omitted target as desktop")
	}
	if err := prepareMacWindowActions([]store.ResourceAction{{Op: "screenshot"}}, true); err != nil {
		t.Fatal("new worker must resolve its own selected target", err)
	}
}
