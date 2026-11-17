package sqlitestore

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A session's grants replace per account, never across accounts (DEV-265).
func TestSessionConnectorGrantsReplacePerAccount(t *testing.T) {
	ctx := context.Background()
	db, err := Open(filepath.Join(t.TempDir(), "foundry.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.SetSessionConnectorGrants(ctx, "sess_1", "acct_a", []store.SessionConnectorGrant{
		{AccountID: "acct_a", ObjectType: "conversation", ObjectID: "oc_1", Label: "One"},
		{AccountID: "acct_a", ObjectType: "conversation", ObjectID: "oc_2"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.SetSessionConnectorGrants(ctx, "sess_1", "acct_b", []store.SessionConnectorGrant{
		{AccountID: "acct_b", ObjectType: "conversation", ObjectID: "oc_3"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.SetSessionConnectorGrants(ctx, "sess_1", "acct_a", []store.SessionConnectorGrant{
		{AccountID: "acct_a", ObjectType: "conversation", ObjectID: "oc_2"},
	}); err != nil {
		t.Fatal(err)
	}
	grants, err := db.SessionConnectorGrants(ctx, "sess_1")
	if err != nil {
		t.Fatal(err)
	}
	if len(grants) != 2 {
		t.Fatalf("grants = %+v", grants)
	}
	seen := map[string]bool{}
	for _, grant := range grants {
		seen[grant.AccountID+"/"+grant.ObjectID] = true
	}
	if !seen["acct_a/oc_2"] || !seen["acct_b/oc_3"] || seen["acct_a/oc_1"] {
		t.Fatalf("grants = %+v", grants)
	}
	none, err := db.SessionConnectorGrants(ctx, "sess_other")
	if err != nil || len(none) != 0 {
		t.Fatalf("unknown session = %+v (%v)", none, err)
	}
}
