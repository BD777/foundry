package httpapi

import (
	"slices"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestWindowSelectionRequiresMacCuaDriverBackend(t *testing.T) {
	spec, _ := resources.Spec("computer_use")
	base := store.ResourceInstance{
		Type: "computer_use", Platform: "macos",
		Backends: []store.ResourceBackend{{ID: "cua-driver", Mode: "remote_ops"}},
	}
	if !slices.Contains(resourceOperationNames(base, spec), "select_window") {
		t.Fatal("Mac provider selection was hidden")
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
