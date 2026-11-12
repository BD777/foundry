package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The one memory vault a person had before the layers (assistant_id
// backfilled to their default assistant, no scope) becomes their person
// layer, once; then each person has one person layer and one layer per
// assistant.
func TestMemoryVaultBecomesThePersonLayerAndLayersStayUnique(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	if _, err := db.conn().ExecContext(ctx, `INSERT INTO knowledge_vaults(id,user_id,assistant_id,scope,kind,workspace_id,device_id,root_path,revision,state,payload_json) VALUES('old','u','asst_default','','memory','w','d','knowledge',1,'active','{"id":"old","kind":"memory","workspaceId":"w","deviceId":"d","rootPath":"knowledge","epoch":1,"revision":1,"state":"active"}')`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := db.setupKnowledge(ctx); err != nil {
			t.Fatal(err)
		}
		if err := db.setupAssistantRecords(ctx); err != nil {
			t.Fatal(err)
		}
	}
	old, err := db.GetKnowledgeVault(ctx, "u", "old")
	if err != nil || old.Scope != store.MemoryScopePerson || old.AssistantID != "" {
		t.Fatalf("migrated vault = %+v %v", old, err)
	}
	for _, v := range []store.KnowledgeVault{
		{ID: "layer-a", UserID: "u", AssistantID: "asst_a", Kind: "memory", WorkspaceID: "wa", DeviceID: "d", RootPath: ".foundry/memory"},
		{ID: "layer-b", UserID: "u", AssistantID: "asst_b", Kind: "memory", WorkspaceID: "wb", DeviceID: "d", RootPath: ".foundry/memory"},
	} {
		created, err := db.CreateKnowledgeVault(ctx, v)
		if err != nil || created.Scope != store.MemoryScopeAssistant {
			t.Fatalf("assistant layer %s = %+v %v", v.ID, created, err)
		}
	}
	for _, duplicate := range []store.KnowledgeVault{
		{ID: "second-person", UserID: "u", Kind: "memory", WorkspaceID: "w2", DeviceID: "d", RootPath: "knowledge"},
		{ID: "second-a", UserID: "u", AssistantID: "asst_a", Kind: "memory", WorkspaceID: "w3", DeviceID: "d", RootPath: "knowledge"},
	} {
		if _, err := db.CreateKnowledgeVault(ctx, duplicate); err == nil {
			t.Fatalf("second layer %s accepted", duplicate.ID)
		}
	}
	if a, err := db.GetKnowledgeVault(ctx, "u", "layer-a"); err != nil || a.AssistantID != "asst_a" || a.Scope != store.MemoryScopeAssistant {
		t.Fatalf("assistant layer read back = %+v %v", a, err)
	}
}

// Copying a legacy fact is idempotent and keeps its row, read-only, after
// the receipt; an inferred fact is never copied.
func TestLegacyMemoryCopyIsIdempotentAndKeepsTheLegacyRow(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	v, err := db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "person", UserID: "u", Kind: "memory", WorkspaceID: "w", DeviceID: "d", RootPath: "knowledge"})
	if err != nil {
		t.Fatal(err)
	}
	fact, err := db.AddPersonalAgentMemory(ctx, store.PersonalAgentMemoryItem{UserID: "u", Content: "Synthetic: prefers aisle seats", Status: store.PersonalAgentMemoryActive, Origin: store.PersonalAgentMemoryStated})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.AddPersonalAgentMemory(ctx, store.PersonalAgentMemoryItem{UserID: "u", Content: "Synthetic guess", Status: store.PersonalAgentMemoryActive, Origin: store.PersonalAgentMemoryInferred}); err != nil {
		t.Fatal(err)
	}
	todo, err := db.LegacyMemoryToCopy(ctx, 10)
	if err != nil || len(todo) != 1 || todo[0].ID != fact.ID {
		t.Fatalf("to copy = %+v %v", todo, err)
	}
	first, err := db.CopyLegacyMemory(ctx, todo[0], v.ID)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := db.CopyLegacyMemory(ctx, todo[0], v.ID)
	if err != nil || replay.ID != first.ID {
		t.Fatalf("replay = %+v %v", replay, err)
	}
	if todo, _ = db.LegacyMemoryToCopy(ctx, 10); len(todo) != 0 {
		t.Fatalf("copied fact listed again: %+v", todo)
	}
	jobs, _ := db.ListKnowledgeMutations(ctx, "u")
	if len(jobs) != 1 || jobs[0].Body != "" && jobs[0].Body != fact.Content {
		t.Fatalf("copy jobs = %+v", jobs)
	}
	first.Status = "writing"
	claimed, err := db.SaveKnowledgeMutation(ctx, first)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.CompleteKnowledgeMutation(ctx, claimed, store.KnowledgeDocument{ID: claimed.EntryID, Revision: 1, OperationID: claimed.ID, Hash: "h", SourceRef: claimed.SourceRef, UpdatedAt: paNow()}); err != nil {
		t.Fatal(err)
	}
	copies, err := db.LegacyMemoryCopies(ctx, "u")
	if err != nil || copies[fact.ID] != "copied" {
		t.Fatalf("copies = %v %v", copies, err)
	}
	kept, err := db.GetPersonalAgentMemory(ctx, "u", fact.ID)
	if err != nil || kept.Status != store.PersonalAgentMemoryActive || kept.Content != fact.Content {
		t.Fatalf("legacy row = %+v %v", kept, err)
	}
	// Forgetting the legacy fact still erases it and its copy.
	if err = db.ForgetPersonalAgentMemory(ctx, "u", fact.ID); err != nil {
		t.Fatal(err)
	}
	if entry, _ := db.GetKnowledgeEntry(ctx, "u", v.ID, claimed.EntryID); entry.State != "forgetting" {
		t.Fatalf("copy kept after forgetting: %+v", entry)
	}
}
