package sqlitestore

import (
	"context"
	"encoding/json"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestContextPatchFenceSurvivesDisconnectAndOnlyReceiptReleasesIt(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	v := store.PersonalAgentContextPatch{ID: "patch", UserID: "u", WorkspaceID: "w", Status: "applying", Revision: 1}
	raw, _ := json.Marshal(v)
	_, err := db.conn().ExecContext(ctx, `INSERT INTO pa_context_patches VALUES(?,?,?,?,?,?)`, v.ID, v.UserID, v.WorkspaceID, v.Status, v.Revision, string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if err = db.checkPAContextPatchFence(ctx, "w"); err == nil {
		t.Fatal("pending device receipt lost the fence")
	}
	v.Reason = "waiting_for_device_receipt"
	v, err = db.SavePersonalAgentContextPatch(ctx, v)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.checkPAContextPatchFence(ctx, "w"); err == nil {
		t.Fatal("offline update released fence")
	}
	if err = db.checkPAContextPatchFence(ctx, "other"); err != nil {
		t.Fatal("unrelated workspace fenced")
	}
	v.Status = "applied"
	if _, err = db.SavePersonalAgentContextPatch(ctx, v); err != nil {
		t.Fatal(err)
	}
	if err = db.checkPAContextPatchFence(ctx, "w"); err != nil {
		t.Fatal("confirmed receipt did not release fence")
	}
}
