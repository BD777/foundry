package sqlitestore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func migrationFixture(t *testing.T) (*Store, context.Context, store.KnowledgeVault, store.KnowledgeDocument) {
	t.Helper()
	db, ctx := newTestStore(t), context.Background()
	root, err := db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "memory", UserID: "person", Kind: "memory", WorkspaceID: "old-ws", DeviceID: "old-device", RootPath: "knowledge"})
	if err != nil {
		t.Fatal(err)
	}
	root.State = "active"
	root, err = db.SaveKnowledgeVault(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	job, err := db.CaptureKnowledgeMutation(ctx, store.KnowledgeMutation{ID: "write", UserID: "person", VaultID: root.ID, Epoch: 1, EntryID: "fact", Action: "write", Title: "Synthetic preference", Body: "Short reports", SourceRef: "user-input:test", RequestHash: "hash"})
	if err != nil {
		t.Fatal(err)
	}
	job.Status = "writing"
	job, err = db.SaveKnowledgeMutation(ctx, job)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(job.Body))
	doc := store.KnowledgeDocument{ID: job.EntryID, OperationID: job.ID, Revision: 1, Hash: hex.EncodeToString(sum[:]), Body: job.Body, SourceRef: job.SourceRef}
	if err = db.CompleteKnowledgeMutation(ctx, job, doc); err != nil {
		t.Fatal(err)
	}
	doc.Body = ""
	return db, ctx, root, doc
}
func moveToVerification(t *testing.T, db *Store, ctx context.Context, root store.KnowledgeVault, doc store.KnowledgeDocument) store.KnowledgeMigration {
	t.Helper()
	move, err := db.BeginKnowledgeMigration(ctx, store.KnowledgeMigration{ID: "move", UserID: root.UserID, VaultID: root.ID, Target: store.KnowledgeVault{WorkspaceID: "new-ws", DeviceID: "new-device", RootPath: "destination"}}, root.Revision)
	if err != nil {
		t.Fatal(err)
	}
	for _, phase := range []string{"freezing", "copying", "verifying"} {
		move.State = phase
		move.Manifest = []store.KnowledgeDocument{doc}
		move.SourceControlRevision, move.TargetControlRevision = 2, 1
		move, err = db.SaveKnowledgeMigration(ctx, move)
		if err != nil {
			t.Fatal(err)
		}
	}
	return move
}
func TestKnowledgeMigrationAtomicSwitchAndRacingForget(t *testing.T) {
	db, ctx, root, doc := migrationFixture(t)
	move := moveToVerification(t, db, ctx, root, doc)
	if _, err := db.CaptureKnowledgeMutation(ctx, store.KnowledgeMutation{ID: "write-during-move", UserID: root.UserID, VaultID: root.ID, EntryID: "new", Epoch: 1, Action: "write", RequestHash: "new"}); err == nil {
		t.Fatal("a new write entered frozen authority")
	}
	forget, err := db.CaptureKnowledgeMutation(ctx, store.KnowledgeMutation{ID: "forget", UserID: root.UserID, VaultID: root.ID, EntryID: doc.ID, Epoch: 1, Action: "forget", ExpectedRevision: 1, ExpectedHash: doc.Hash, RequestHash: "forget"})
	if err != nil {
		t.Fatal(err)
	}
	forget.Status = "writing"
	forget, err = db.SaveKnowledgeMutation(ctx, forget)
	if err != nil {
		t.Fatal(err)
	}
	moved, err := db.SwitchKnowledgeAuthority(ctx, move)
	if err != nil {
		t.Fatal(err)
	}
	current, err := db.GetKnowledgeVault(ctx, root.UserID, root.ID)
	if err != nil || current.Epoch != 2 || current.DeviceID != "new-device" || current.State != "activating" {
		t.Fatalf("authority not switched atomically: %+v %v", current, err)
	}
	entry, _ := db.GetKnowledgeEntry(ctx, root.UserID, root.ID, doc.ID)
	if entry.State != "forgetting" || entry.Epoch != 2 {
		t.Fatalf("move revived revoked knowledge: %+v", entry)
	}
	empty := sha256.Sum256(nil)
	receipt := store.KnowledgeDocument{ID: doc.ID, OperationID: forget.ID, Revision: 2, Hash: hex.EncodeToString(empty[:]), Deleted: true}
	if err = db.CompleteKnowledgeMutation(ctx, forget, receipt); !errors.Is(err, store.ErrPersonalAgentRevision) {
		t.Fatalf("old authority receipt overwrote new epoch: %v", err)
	}
	pending, _ := db.GetKnowledgeMutation(ctx, root.UserID, forget.ID)
	if pending.Epoch != 2 {
		t.Fatal("forget was not forwarded to the new authority")
	}
	if err = db.CompleteKnowledgeMutation(ctx, pending, receipt); err != nil {
		t.Fatal(err)
	}
	if _, err = db.RequestKnowledgeMigrationCancel(ctx, root.UserID, moved.ID, moved.Revision); err == nil {
		t.Fatal("post-switch cancellation could make two writers")
	}
	moved, err = db.ActivateKnowledgeAuthority(ctx, moved)
	if err != nil {
		t.Fatal(err)
	}
	moved.State = "complete"
	if _, err = db.SaveKnowledgeMigration(ctx, moved); err != nil {
		t.Fatal(err)
	}
	if err = db.EnsureKnowledgeReplicaForgets(ctx); err != nil {
		t.Fatal(err)
	}
	cleanup, err := db.ListKnowledgeReplicaForgets(ctx, root.UserID)
	if err != nil || len(cleanup) != 1 || cleanup[0].EntryID != doc.ID {
		t.Fatalf("retained source forgotten without cleanup: %+v %v", cleanup, err)
	}
}
func TestKnowledgeMigrationRejectsChangedManifestAndCanCancelBeforeSwitch(t *testing.T) {
	db, ctx, root, doc := migrationFixture(t)
	move := moveToVerification(t, db, ctx, root, doc)
	move.Manifest[0].SourceRef = "untrusted-change"
	var err error
	move, err = db.SaveKnowledgeMigration(ctx, move)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.SwitchKnowledgeAuthority(ctx, move); err == nil {
		t.Fatal("changed provenance silently imported")
	}
	current, _ := db.GetKnowledgeVault(ctx, root.UserID, root.ID)
	if current.Epoch != 1 || current.WorkspaceID != root.WorkspaceID {
		t.Fatal("failed verification changed source")
	}
	move, err = db.RequestKnowledgeMigrationCancel(ctx, root.UserID, move.ID, move.Revision)
	if err != nil {
		t.Fatal(err)
	}
	move, err = db.AbortKnowledgeMigration(ctx, move)
	if err != nil {
		t.Fatal(err)
	}
	current, _ = db.GetKnowledgeVault(ctx, root.UserID, root.ID)
	if current.State != "active" || move.State != "cancelled" {
		t.Fatalf("source not restored: %+v %+v", current, move)
	}
	copies, err := db.ListKnowledgeReplicas(ctx, root.UserID, root.ID)
	if err != nil || len(copies) != 1 || copies[0].Location.WorkspaceID != "new-ws" {
		t.Fatalf("staging copy was lost from inventory: %+v %v", copies, err)
	}
}
