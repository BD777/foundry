package httpapi

import (
	"context"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
	"time"
)

func TestKnowledgeRootRecallUsesCurrentAuthorityAndAccount(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	roots, _ := f.server.knowledgeVaultStore()
	pubs, _ := f.server.publicationStore()
	root, err := roots.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "memory", UserID: f.aliceID, Kind: "memory", WorkspaceID: "ws_alice", DeviceID: "dev_alice", RootPath: "knowledge"})
	if err != nil {
		t.Fatal(err)
	}
	root.State = "active"
	root, err = roots.SaveKnowledgeVault(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	audience, err := f.server.knowledgeAudience(ctx, f.aliceID, "ws_pa")
	if err != nil {
		t.Fatal(err)
	}
	grant, err := pubs.CreateKnowledgePublication(ctx, store.KnowledgePublication{ID: "grant", UserID: f.aliceID, Scope: "memory_root", VaultID: root.ID, SourceEpoch: 1, TargetWorkspaceID: "ws_pa", ProfileID: "chosen", ProfileFingerprint: "fingerprint", ProviderConfigHash: bindSyntheticKnowledgeAccount(t, f, "ws_pa", "chosen", "fingerprint", "Synthetic account A"), AudienceHash: audience, Purpose: "assistant_memory_recall"})
	if err != nil {
		t.Fatal(err)
	}
	session := f.conversation
	session.ProfileID, session.ProfileFingerprint = "chosen", "fingerprint"
	if err = f.server.checkKnowledgePublication(ctx, session, grant); err != nil {
		t.Fatal(err)
	}
	session.ProfileFingerprint = "changed"
	if err = f.server.checkKnowledgePublication(ctx, session, grant); err == nil {
		t.Fatal("new provider inherited recall")
	}
	session.ProfileFingerprint = "fingerprint"
	root.State = "migrating"
	if _, err = roots.SaveKnowledgeVault(ctx, root); err != nil {
		t.Fatal(err)
	}
	if err = f.server.checkKnowledgePublication(ctx, session, grant); err == nil {
		t.Fatal("moving source was recalled as live")
	}
	if knowledgeEntryCurrent(store.KnowledgeEntry{Epoch: 1, State: "active", ExpiresAt: "2020-01-01T00:00:00Z"}, 1) {
		t.Fatal("expired fact is current")
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
	input, err := f.server.assistantPromptInput(ctx, agent, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range input.Memory {
		if item.Origin == store.PersonalAgentMemoryInferred {
			t.Fatal("unconfirmed legacy memory entered prompt")
		}
	}
}

func TestKnowledgeMetadataCanPagePastFiftyWithoutRevivingExpiredEntries(t *testing.T) {
	rows := []store.KnowledgeEntry{}
	for i := 120; i > 0; i-- {
		rows = append(rows, store.KnowledgeEntry{ID: fmt.Sprintf("entry%03d", i), Epoch: 2, State: "active", Title: "MATCH synthetic fact"})
	}
	rows = append(rows, store.KnowledgeEntry{ID: "expired", Epoch: 2, State: "active", Title: "MATCH", ExpiresAt: "2020-01-01T00:00:00Z"}, store.KnowledgeEntry{ID: "forgotten", Epoch: 2, State: "forgotten", Title: "MATCH"}, store.KnowledgeEntry{ID: "old-authority", Epoch: 1, State: "active", Title: "MATCH"})
	seen := map[string]bool{}
	cursor := ""
	pages := 0
	for {
		page, more, next := knowledgeMetadataPage(rows, 2, "match", cursor)
		pages++
		if len(page) > 50 {
			t.Fatal("unbounded metadata page")
		}
		for _, entry := range page {
			if seen[entry.ID] {
				t.Fatal("repeated metadata", entry.ID)
			}
			seen[entry.ID] = true
		}
		if !more {
			break
		}
		if next <= cursor {
			t.Fatal("cursor did not advance")
		}
		cursor = next
	}
	if pages != 3 || len(seen) != 120 {
		t.Fatalf("incomplete discovery: %d pages, %d entries", pages, len(seen))
	}
}
