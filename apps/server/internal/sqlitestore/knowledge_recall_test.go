package sqlitestore

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestKnowledgeRootRecallIsExplicitAndReplacesOnlyRootAccount(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	root, err := db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "memory", UserID: "u", Kind: "memory", WorkspaceID: "memory-ws", DeviceID: "memory-device", RootPath: "knowledge"})
	if err != nil {
		t.Fatal(err)
	}
	grant := store.KnowledgePublication{ID: "grant", UserID: "u", Scope: "memory_root", VaultID: root.ID, SourceEpoch: 1, TargetWorkspaceID: "assistant-ws", ProfileID: "profile-a", ProfileFingerprint: "fingerprint-a", AudienceHash: "audience", Purpose: "assistant_memory_recall"}
	first, err := db.CreateKnowledgePublication(ctx, grant)
	if err != nil {
		t.Fatal(err)
	}
	grant.ID, grant.ProfileID, grant.ProfileFingerprint = "grant-b", "profile-b", "fingerprint-b"
	if _, err = db.CreateKnowledgePublication(ctx, grant); err != nil {
		t.Fatal(err)
	}
	old, err := db.GetKnowledgePublication(ctx, "u", first.ID)
	if err != nil || old.State != "revoked" {
		t.Fatalf("old account still has root access: %+v %v", old, err)
	}
	_, err = db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "domain", UserID: "u", Kind: "domain", WorkspaceID: "job-search", DeviceID: "memory-device", RootPath: "facts"})
	if err != nil {
		t.Fatal(err)
	}
	grant.ID, grant.VaultID = "domain-grant", "domain"
	if _, err = db.CreateKnowledgePublication(ctx, grant); err == nil {
		t.Fatal("domain became global recall")
	}
}

func TestKnowledgeCurrentGrantIsNotHiddenByRevokedHistory(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	err := db.withTx(ctx, func(tx *Store) error {
		for i := 0; i < 1001; i++ {
			state := "revoked"
			if i == 1000 {
				state = "active"
			}
			id := fmt.Sprintf("grant-%04d", i)
			row := store.KnowledgePublication{ID: id, UserID: "u", VaultID: "vault", EntryID: "entry", TargetWorkspaceID: "target", State: state, Revision: 1}
			raw, err := json.Marshal(row)
			if err != nil {
				return err
			}
			if _, err = tx.conn().ExecContext(ctx, `INSERT INTO knowledge_publications(id,user_id,vault_id,entry_id,target_workspace_id,state,revision,payload_json) VALUES(?,?,?,?,?,?,?,?)`, id, "u", "vault", "entry", "target", state, 1, string(raw)); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := db.ListKnowledgePublications(ctx, "u")
	if err != nil || len(rows) != 1001 || rows[1000].State != "active" {
		t.Fatalf("current authority truncated: %d rows, %v", len(rows), err)
	}
	other, err := db.ListKnowledgePublications(ctx, "another-person")
	if err != nil || len(other) != 0 {
		t.Fatal("cross-account metadata released")
	}
}
