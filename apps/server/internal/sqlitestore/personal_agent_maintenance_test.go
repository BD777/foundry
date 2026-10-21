package sqlitestore

import (
	"context"
	"errors"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestMaintenanceCoalescesUnsentButPreservesAcceptedReceipt(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	add := func(id, key string) store.PersonalAgentMaintenance {
		t.Helper()
		j, e := db.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{ID: id, UserID: "u", WorkspaceID: "w", Role: "governance", EventKey: key})
		if e != nil {
			t.Fatal(e)
		}
		return j
	}
	a := add("a", "v1")
	replay := add("ignored", "v1")
	if replay.ID != a.ID {
		t.Fatal("same event duplicated")
	}
	b := add("b", "v2")
	a, _ = db.GetPersonalAgentMaintenance(ctx, "u", a.ID)
	if a.Status != "superseded" {
		t.Fatal("unsent event not coalesced")
	}
	b.Status = "starting"
	b.InputID = "native-input"
	b, e := db.SavePersonalAgentMaintenance(ctx, b)
	if e != nil {
		t.Fatal(e)
	}
	c := add("c", "v3")
	b, _ = db.GetPersonalAgentMaintenance(ctx, "u", b.ID)
	if b.Status != "starting" {
		t.Fatal("accepted input replaced")
	}
	c.Status = "starting"
	if _, e = db.SavePersonalAgentMaintenance(ctx, c); e == nil {
		t.Fatal("parallel maintenance bypassed concurrency cap")
	}
	if _, e = db.GetPersonalAgentMaintenance(ctx, "other", b.ID); !errors.Is(e, store.ErrNotFound) {
		t.Fatal("cross user read")
	}
	b.Status = "review"
	saved, e := db.SavePersonalAgentMaintenance(ctx, b)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.SavePersonalAgentMaintenance(ctx, b); !errors.Is(e, store.ErrPersonalAgentRevision) {
		t.Fatal("stale result overwrote decision")
	}
	saved.Result = &store.MaintenanceResult{Summary: "healthy"}
	if _, e = db.SavePersonalAgentMaintenance(ctx, saved); e != nil {
		t.Fatal(e)
	}
}

func TestMaintenanceRetryRequiresNativeEndAndCanRefreshUnsentSettings(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	job, err := db.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{ID: "review", UserID: "person", Role: "governance", WorkspaceID: "workspace", EventKey: "context-version"})
	if err != nil {
		t.Fatal(err)
	}
	job.Status, job.InputID, job.SessionID = "failed", "input", "session"
	job, err = db.SavePersonalAgentMaintenance(ctx, job)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.EnsurePersonalAgentRunControl(ctx, store.PersonalAgentRunControl{ID: "control", UserID: job.UserID, SessionID: job.SessionID, InputID: job.InputID, DispatchAttempted: true})
	if err != nil {
		t.Fatal(err)
	}
	retry := job
	retry.Status = "pending"
	retry.Attempt++
	retry.InputID = ""
	retry.SessionID = ""
	retry.SnapshotID = ""
	if _, err = db.SavePersonalAgentMaintenance(ctx, retry); !errors.Is(err, store.ErrPersonalAgentInputUnconfirmed) {
		t.Fatalf("retried unknown native outcome: %v", err)
	}
	if err = db.NotePersonalAgentNativeEnd(ctx, job.SessionID, job.InputID, "failed"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.SavePersonalAgentMaintenance(ctx, retry); err != nil {
		t.Fatal(err)
	}
	pending, err := db.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{ID: "waiting", UserID: "person", Role: "memory", WorkspaceID: "other", EventKey: "fresh"})
	if err != nil {
		t.Fatal(err)
	}
	pending.Status = "waiting"
	pending, err = db.SavePersonalAgentMaintenance(ctx, pending)
	if err != nil {
		t.Fatal(err)
	}
	pending.Status = "pending"
	pending.Attempt++
	if _, err = db.SavePersonalAgentMaintenance(ctx, pending); err != nil {
		t.Fatal("unsent configuration cannot be refreshed", err)
	}
}
