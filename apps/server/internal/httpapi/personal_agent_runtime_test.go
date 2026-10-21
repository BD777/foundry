package httpapi

import (
	"context"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestAssistantRuntimeDoesNotReplaceExplicitMissingAccount(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent, err := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	agent.Settings.RunDefault = &store.PersonalAgentRunPreference{ProfileID: "missing-account"}
	if _, err := f.server.resolveAssistantRun(ctx, agent, "coordinator", "ws_pa"); err == nil || !strings.Contains(err.Error(), "account_unavailable") {
		t.Fatalf("missing account silently replaced: %v", err)
	}
	agent.Settings.RunDefault = &store.PersonalAgentRunPreference{ProfileID: "device_default", DeviceID: "a-different-computer"}
	if _, err := f.server.resolveAssistantRun(ctx, agent, "coordinator", "ws_pa"); err == nil || !strings.Contains(err.Error(), "execution_location_mismatch") {
		t.Fatalf("data or execution silently moved: %v", err)
	}
}

func TestAssistantRunDetectsCachedNativeAccountChange(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	bindSyntheticKnowledgeAccount(t, f, "ws_pa", "chosen", "codex:local_login", "Synthetic account A")
	agent, err := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := f.server.resolveAssistantRun(ctx, agent, "coordinator", agent.WorkspaceID)
	if err != nil || snapshot.AccountLabel != "Synthetic account A" || snapshot.ProviderConfigHash == "" {
		t.Fatalf("missing cached descriptor: %+v %v", snapshot, err)
	}
	bindSyntheticKnowledgeAccount(t, f, "ws_pa", "chosen", "codex:local_login", "Synthetic account B")
	if err = f.server.checkPinnedAssistantRun(ctx, snapshot); err == nil {
		t.Fatal("cached account changed under a pending run")
	}
}
