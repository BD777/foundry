package sqlitestore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"strings"
	"testing"
)

func TestKnowledgeMutationRevokeBeforeCleanupAndScrubOutbox(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	v, err := db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "vault", UserID: "p", Kind: "memory", WorkspaceID: "ws", DeviceID: "memory-device", RootPath: "knowledge"})
	if err != nil {
		t.Fatal(err)
	}
	input := store.KnowledgeMutation{ID: "write", UserID: "p", VaultID: v.ID, EntryID: "fact", Epoch: 1, Action: "write", Title: "Synthetic preference", Body: "Concise updates", SourceRef: "user-input:example", RequestHash: "original"}
	first, err := db.CaptureKnowledgeMutation(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if replay, err := db.CaptureKnowledgeMutation(ctx, input); err != nil || replay.ID != first.ID {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	first.Status = "writing"
	first, err = db.SaveKnowledgeMutation(ctx, first)
	if err != nil {
		t.Fatal(err)
	}
	forgotten, err := db.CaptureKnowledgeMutation(ctx, store.KnowledgeMutation{ID: "forget", UserID: "p", VaultID: v.ID, EntryID: "fact", Epoch: 1, Action: "forget", RequestHash: "forget-request"})
	if err != nil {
		t.Fatal(err)
	}
	entry, err := db.GetKnowledgeEntry(ctx, "p", v.ID, "fact")
	if err != nil || entry.State != "forgetting" {
		t.Fatalf("retrieval not immediately revoked: %+v %v", entry, err)
	}
	old, err := db.GetKnowledgeMutation(ctx, "p", "write")
	if err != nil || old.Status != "superseded" || old.Body != "" || old.Title != "" || old.SourceRef != "" {
		t.Fatalf("forgotten outbox retained text: %+v %v", old, err)
	}
	digest := sha256.Sum256([]byte(input.Body))
	doc := store.KnowledgeDocument{ID: "fact", Revision: 1, OperationID: first.ID, Hash: hex.EncodeToString(digest[:]), Body: input.Body, SourceRef: input.SourceRef}
	if err = db.CompleteKnowledgeMutation(ctx, first, doc); !errors.Is(err, store.ErrPersonalAgentRevision) {
		t.Fatalf("late write resurrected index: %v", err)
	}
	forgotten.Status = "writing"
	forgotten, err = db.SaveKnowledgeMutation(ctx, forgotten)
	if err != nil {
		t.Fatal(err)
	}
	empty := sha256.Sum256(nil)
	if err = db.CompleteKnowledgeMutation(ctx, forgotten, store.KnowledgeDocument{ID: "fact", Revision: 2, OperationID: forgotten.ID, Hash: hex.EncodeToString(empty[:]), Deleted: true}); err != nil {
		t.Fatal(err)
	}
	entry, _ = db.GetKnowledgeEntry(ctx, "p", v.ID, "fact")
	if entry.State != "forgotten" {
		t.Fatalf("tombstone: %+v", entry)
	}
	renamed := input
	renamed.ID = "new-intent"
	renamed.EntryID = "different-id"
	renamed.RequestHash = "different-request"
	if _, err = db.CaptureKnowledgeMutation(ctx, renamed); err == nil || !strings.Contains(err.Error(), "source_revoked") {
		t.Fatalf("forgotten old source learned under a new key: %v", err)
	}
	renamed.ID = "fresh-confirmation"
	renamed.SourceRef = "user-input:new-confirmation"
	renamed.RequestHash = "fresh-request"
	if _, err = db.CaptureKnowledgeMutation(ctx, renamed); err != nil {
		t.Fatalf("fresh user confirmation blocked: %v", err)
	}
	input.ID, input.ExpectedRevision, input.ExpectedHash = "relearn", 2, entry.Hash
	if _, err = db.CaptureKnowledgeMutation(ctx, input); err == nil {
		t.Fatal("forgotten identity resurrected")
	}
}
func TestKnowledgeAppliedBodyIsOnlyInSource(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	_, err := db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "vault", UserID: "p", Kind: "domain", WorkspaceID: "ws", DeviceID: "device", RootPath: "knowledge"})
	if err != nil {
		t.Fatal(err)
	}
	job, err := db.CaptureKnowledgeMutation(ctx, store.KnowledgeMutation{ID: "write", UserID: "p", VaultID: "vault", EntryID: "fact", Epoch: 1, Action: "write", Title: "Test", Body: "Device source", SourceRef: "user-input:test", RequestHash: "request"})
	if err != nil {
		t.Fatal(err)
	}
	job.Status = "writing"
	job, err = db.SaveKnowledgeMutation(ctx, job)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte(job.Body))
	if err = db.CompleteKnowledgeMutation(ctx, job, store.KnowledgeDocument{ID: job.EntryID, OperationID: job.ID, Revision: 1, Hash: hex.EncodeToString(hash[:]), Body: job.Body, SourceRef: job.SourceRef}); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetKnowledgeMutation(ctx, "p", job.ID)
	if err != nil || got.Body != "" || got.Status != "applied" {
		t.Fatalf("outbox retained source body: %+v %v", got, err)
	}
}

func TestKnowledgeIndexRepairPreservesRevocationAndRejectsPendingWrites(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	v, _ := db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "vault-repair", UserID: "u", Kind: "memory", WorkspaceID: "w", DeviceID: "d", RootPath: "knowledge"})
	v.State = "active"
	_, _ = db.SaveKnowledgeVault(ctx, v)
	docs := []store.KnowledgeDocument{{ID: "fact", Revision: 1, Hash: "source-hash", SourceRef: "user-input:synthetic", SourceVersion: "v1", UpdatedAt: paNow()}}
	seeded, e := db.CaptureKnowledgeMutation(ctx, store.KnowledgeMutation{ID: "seed-repair", UserID: "u", VaultID: v.ID, EntryID: "fact", Epoch: 1, Action: "write", Body: "Synthetic source", Title: "Preference", SourceRef: docs[0].SourceRef, SourceVersion: docs[0].SourceVersion, RequestHash: "seed"})
	if e != nil {
		t.Fatal(e)
	}
	seeded.Status = "writing"
	seeded, e = db.SaveKnowledgeMutation(ctx, seeded)
	if e != nil {
		t.Fatal(e)
	}
	docs[0].OperationID = seeded.ID
	if e = db.CompleteKnowledgeMutation(ctx, seeded, docs[0]); e != nil {
		t.Fatal(e)
	}
	if _, e = db.conn().ExecContext(ctx, `DELETE FROM knowledge_entries WHERE user_id='u' AND vault_id=?`, v.ID); e != nil {
		t.Fatal(e)
	}
	changed := append([]store.KnowledgeDocument(nil), docs...)
	changed[0].Hash = "unreviewed-manual-change"
	if e = db.ReconcileKnowledgeIndex(ctx, "u", v.ID, 1, changed); e == nil {
		t.Fatal("index repair bypassed source review")
	}
	if err := db.ReconcileKnowledgeIndex(ctx, "u", v.ID, 1, docs); err != nil {
		t.Fatal(err)
	}
	restored, err := db.GetKnowledgeEntry(ctx, "u", v.ID, "fact")
	if err != nil || restored.Hash != "source-hash" {
		t.Fatal("index not rebuilt", err)
	}
	job, err := db.CaptureKnowledgeMutation(ctx, store.KnowledgeMutation{ID: "forget-repaired", UserID: "u", VaultID: v.ID, EntryID: "fact", Epoch: 1, Action: "forget", ExpectedRevision: 1, ExpectedHash: "source-hash", RequestHash: "forget"})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.ReconcileKnowledgeIndex(ctx, "u", v.ID, 1, docs); err == nil {
		t.Fatal("repair raced a pending mutation")
	}
	job.Status = "writing"
	job, err = db.SaveKnowledgeMutation(ctx, job)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.CompleteKnowledgeMutation(ctx, job, store.KnowledgeDocument{ID: "fact", Revision: 2, OperationID: job.ID, Hash: "empty-hash", Deleted: true}); err != nil {
		t.Fatal(err)
	}
	if err = db.ReconcileKnowledgeIndex(ctx, "u", v.ID, 1, docs); err != nil {
		t.Fatal(err)
	}
	restored, _ = db.GetKnowledgeEntry(ctx, "u", v.ID, "fact")
	if restored.State != "forgetting" {
		t.Fatal("old source resurrected through index repair", restored.State)
	}
}
