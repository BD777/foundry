package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestKnowledgeRootRecallUsesCurrentAuthorityAndAccount(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	root, err := f.server.store.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "memory", UserID: f.aliceID, Kind: "memory", WorkspaceID: "ws_alice", DeviceID: "dev_alice", RootPath: "knowledge"})
	if err != nil {
		t.Fatal(err)
	}
	root.State = "active"
	root, err = f.server.store.SaveKnowledgeVault(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	audience, err := f.server.knowledge.Audience(ctx, f.aliceID, "ws_pa")
	if err != nil {
		t.Fatal(err)
	}
	grant, err := f.server.store.CreateKnowledgePublication(ctx, store.KnowledgePublication{ID: "grant", UserID: f.aliceID, Scope: "memory_root", VaultID: root.ID, SourceEpoch: 1, TargetWorkspaceID: "ws_pa", ProfileID: "chosen", ProfileFingerprint: "fingerprint", ProviderConfigHash: bindSyntheticKnowledgeAccount(t, f, "ws_pa", "chosen", "fingerprint", "Synthetic account A"), AudienceHash: audience, Purpose: "assistant_memory_recall"})
	if err != nil {
		t.Fatal(err)
	}
	session := f.conversation
	session.ProfileID, session.ProfileFingerprint = "chosen", "fingerprint"
	if err = f.server.knowledge.CheckPublication(ctx, session, grant); err != nil {
		t.Fatal(err)
	}
	session.ProfileFingerprint = "changed"
	if err = f.server.knowledge.CheckPublication(ctx, session, grant); err == nil {
		t.Fatal("new provider inherited recall")
	}
	session.ProfileFingerprint = "fingerprint"
	root.State = "migrating"
	if _, err = f.server.store.SaveKnowledgeVault(ctx, root); err != nil {
		t.Fatal(err)
	}
	if err = f.server.knowledge.CheckPublication(ctx, session, grant); err == nil {
		t.Fatal("moving source was recalled as live")
	}
}
func TestAssistantSnapshotDoesNotTreatLegacyInferenceAsFact(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	_, err := f.server.store.AddPersonalAgentMemory(ctx, store.PersonalAgentMemoryItem{UserID: f.aliceID, Content: "Unconfirmed guess", Origin: store.PersonalAgentMemoryInferred, Status: store.PersonalAgentMemoryActive})
	if err != nil {
		t.Fatal(err)
	}
	agent, _ := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	// The prompt input may update workspace projections, but it must not promote
	// a legacy UI-active inference into the assistant's confirmed memory.
	input, err := f.server.assistant.PromptInput(ctx, agent, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range input.Memory {
		if item.Origin == store.PersonalAgentMemoryInferred {
			t.Fatal("unconfirmed legacy memory entered prompt")
		}
	}
}
