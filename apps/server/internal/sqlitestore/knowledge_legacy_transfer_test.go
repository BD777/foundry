package sqlitestore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestKnowledgeLegacyTransferFreezesThenErasesOnlyAfterFileReceipt(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	v, e := db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "root", UserID: "u", Kind: "memory", WorkspaceID: "w", DeviceID: "d", RootPath: "knowledge"})
	if e != nil {
		t.Fatal(e)
	}
	v.State = "active"
	if _, e = db.SaveKnowledgeVault(ctx, v); e != nil {
		t.Fatal(e)
	}
	old, e := db.AddPersonalAgentMemory(ctx, store.PersonalAgentMemoryItem{UserID: "u", Content: "Synthetic confirmed preference", Status: "active", Origin: "stated"})
	if e != nil {
		t.Fatal(e)
	}
	hash := sha256.Sum256([]byte(old.Content))
	bodyHash := hex.EncodeToString(hash[:])
	if _, e = db.TransferPersonalAgentMemory(ctx, "u", old.ID, v.ID, "stale", bodyHash); e == nil {
		t.Fatal("unreviewed version transferred")
	}
	job, e := db.TransferPersonalAgentMemory(ctx, "u", old.ID, v.ID, old.UpdatedAt, bodyHash)
	if e != nil {
		t.Fatal(e)
	}
	frozen, _ := db.GetPersonalAgentMemory(ctx, "u", old.ID)
	if frozen.Status != "transferring" || frozen.Content == "" {
		t.Fatal("legacy authority lost before receipt")
	}
	if _, e = db.SupersedePersonalAgentMemory(ctx, "u", old.ID, store.PersonalAgentMemoryItem{Content: "double write"}); e == nil {
		t.Fatal("legacy edited during transfer")
	}
	replay, e := db.TransferPersonalAgentMemory(ctx, "u", old.ID, v.ID, old.UpdatedAt, bodyHash)
	if e != nil || replay.ID != job.ID {
		t.Fatal("transfer duplicated", e)
	}
	job.Status = "writing"
	job, e = db.SaveKnowledgeMutation(ctx, job)
	if e != nil {
		t.Fatal(e)
	}
	doc := store.KnowledgeDocument{ID: job.EntryID, Revision: 1, OperationID: job.ID, Hash: bodyHash, Body: old.Content, SourceRef: job.SourceRef, SourceVersion: job.SourceVersion}
	if e = db.CompleteKnowledgeMutation(ctx, job, doc); e != nil {
		t.Fatal(e)
	}
	erased, _ := db.GetPersonalAgentMemory(ctx, "u", old.ID)
	if erased.Content != "" || erased.Status != "forgotten" {
		t.Fatal("second editable body retained")
	}
	if e = db.ForgetPersonalAgentMemory(ctx, "u", old.ID); e != nil {
		t.Fatal(e)
	}
	entry, _ := db.GetKnowledgeEntry(ctx, "u", v.ID, job.EntryID)
	if entry.State != "forgetting" {
		t.Fatal("old pointer failed to revoke new authority")
	}
}
func TestKnowledgeForgetDuringLegacyTransferFencesLateWrite(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	v, _ := db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "root", UserID: "u", Kind: "memory", WorkspaceID: "w", DeviceID: "d", RootPath: "knowledge"})
	v.State = "active"
	_, _ = db.SaveKnowledgeVault(ctx, v)
	old, _ := db.AddPersonalAgentMemory(ctx, store.PersonalAgentMemoryItem{UserID: "u", Content: "Synthetic pending source", Status: "pending", Origin: "inferred"})
	sum := sha256.Sum256([]byte(old.Content))
	job, e := db.TransferPersonalAgentMemory(ctx, "u", old.ID, v.ID, old.UpdatedAt, hex.EncodeToString(sum[:]))
	if e != nil {
		t.Fatal(e)
	}
	job.Status = "writing"
	job, e = db.SaveKnowledgeMutation(ctx, job)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.ForgetAllPersonalAgentMemory(ctx, "u"); e != nil {
		t.Fatal(e)
	}
	late := store.KnowledgeDocument{ID: job.EntryID, Revision: 1, OperationID: job.ID, Body: old.Content, Hash: hex.EncodeToString(sum[:])}
	if e = db.CompleteKnowledgeMutation(ctx, job, late); e == nil {
		t.Fatal("late write revived transferred fact")
	}
	revoked, _ := db.GetKnowledgeEntry(ctx, "u", v.ID, job.EntryID)
	if revoked.State != "forgetting" {
		t.Fatal("pending copy not fenced")
	}
	source, _ := db.GetPersonalAgentMemory(ctx, "u", old.ID)
	if source.Content != "" {
		t.Fatal("legacy source not erased")
	}
}
