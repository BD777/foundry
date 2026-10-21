package sqlitestore

import (
	"context"
	"errors"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestKnowledgeVaultSingleRootAndExplicitMove(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	input := store.KnowledgeVault{ID: "vault", UserID: "alice", Kind: "memory", WorkspaceID: "ws", DeviceID: "dev-memory", RootPath: "knowledge"}
	created, err := db.CreateKnowledgeVault(ctx, input)
	if err != nil || created.State != "pending" {
		t.Fatalf("create: %+v %v", created, err)
	}
	if replay, err := db.CreateKnowledgeVault(ctx, input); err != nil || replay.ID != created.ID {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	changed := input
	changed.RootPath = "other"
	if _, err := db.CreateKnowledgeVault(ctx, changed); !errors.Is(err, store.ErrIdempotencyConflict) {
		t.Fatalf("silent migration: %v", err)
	}
	changed.ID = "second"
	if _, err := db.CreateKnowledgeVault(ctx, changed); err == nil {
		t.Fatal("second memory root accepted")
	}
	if _, err := db.GetKnowledgeVault(ctx, "bob", input.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross owner read: %v", err)
	}
	created.State = "active"
	saved, err := db.SaveKnowledgeVault(ctx, created)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SaveKnowledgeVault(ctx, created); !errors.Is(err, store.ErrPersonalAgentRevision) {
		t.Fatalf("stale state overwrite: %v", err)
	}
	saved.DeviceID = "other-device"
	if _, err := db.SaveKnowledgeVault(ctx, saved); err == nil {
		t.Fatal("device changed outside migration")
	}
	pending, err := db.PendingKnowledgeVaults(ctx)
	if err != nil || len(pending) != 0 {
		t.Fatalf("active root reinitialized: %+v %v", pending, err)
	}
}

func TestKnowledgeFailedInitialChoiceCanMoveWithoutAnOldWriter(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	v, err := db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "root-initial", UserID: "u", Kind: "memory", WorkspaceID: "wrong-workspace", DeviceID: "d", RootPath: "nonempty"})
	if err != nil {
		t.Fatal(err)
	}
	job, err := db.CaptureKnowledgeMutation(ctx, store.KnowledgeMutation{ID: "queued-fact", UserID: "u", VaultID: v.ID, EntryID: "fact", Epoch: 1, Action: "write", Body: "Synthetic fact", SourceRef: "user-input:confirmed", RequestHash: "stable-intent"})
	if err != nil {
		t.Fatal(err)
	}
	original := v
	v.WorkspaceID = "private-memory"
	v.RootPath = "empty-knowledge"
	moved, err := db.ResetPendingKnowledgeVault(ctx, v)
	if err != nil {
		t.Fatal(err)
	}
	if moved.Epoch != 2 || moved.State != "pending" {
		t.Fatalf("bad initial move %+v", moved)
	}
	queued, err := db.GetKnowledgeMutation(ctx, "u", job.ID)
	if err != nil || queued.Epoch != 2 || queued.Body != "Synthetic fact" || queued.RequestHash != job.RequestHash {
		t.Fatalf("pending intent lost %+v %v", queued, err)
	}
	original.State = "active"
	if _, err = db.SaveKnowledgeVault(ctx, original); err == nil {
		t.Fatal("late old initialization changed authority")
	}
	moved.State = "active"
	moved, err = db.SaveKnowledgeVault(ctx, moved)
	if err != nil {
		t.Fatal(err)
	}
	moved.RootPath = "third"
	if _, err = db.ResetPendingKnowledgeVault(ctx, moved); err == nil {
		t.Fatal("established source bypassed migration")
	}
}
