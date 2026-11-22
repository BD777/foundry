package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Needs you keeps only what is stuck on the person: the upkeep items and the
// needs_hands items the tool-output rules made close as superseded, once; a
// permission the runtime refused and every other source stay open. A retired
// source is in no visible list even when a row of it is open.
func TestRetiredPendingSourcesCloseOnce(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	const user = "user_retired"
	record := func(item store.PendingItem) {
		t.Helper()
		item.UserID, item.WorkspaceID, item.Handler = user, "ws_retired", store.PendingHandlerPerson
		item.Title, item.Excerpt = item.Key, item.Key
		if _, _, err := db.RecordPendingItem(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	record(store.PendingItem{Source: store.PendingSourceProjectUpkeep, Key: "upkeep:user_retired:ws_retired", Count: 2})
	record(store.PendingItem{Source: store.PendingSourceMemoryUpkeep, Key: "memory_upkeep:user_retired:pa_1", Count: 1})
	record(store.PendingItem{Source: store.PendingSourceNeedsHands, Rule: "sudo", Key: "hands:sess_a:sudo", MessageID: "turn/evt_sudo"})
	record(store.PendingItem{Source: store.PendingSourceNeedsHands, Rule: "permission", Key: "hands:sess_b:permission", MessageID: "turn/evt_eacces"})
	record(store.PendingItem{Source: store.PendingSourceNeedsHands, Rule: "permission", Key: "hands:sess_c:permission", EventID: "evt_denied"})
	record(store.PendingItem{Source: store.PendingSourceTurnFailed, Key: "turn_failed:user_retired:other:codex:p:session:sess_d"})

	visible, err := db.ListVisiblePendingItems(ctx, user, []string{store.PendingOpen}, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range visible {
		if item.Source == store.PendingSourceProjectUpkeep || item.Source == store.PendingSourceMemoryUpkeep {
			t.Fatalf("a retired source is visible: %+v", item)
		}
	}
	if len(visible) != 4 {
		t.Fatalf("visible = %d items, want the 4 of kept sources", len(visible))
	}

	if _, err := db.conn().ExecContext(ctx, `DELETE FROM data_migrations WHERE name = ?`, retiredPendingMigration); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := db.migrateRetiredPendingSources(ctx); err != nil {
			t.Fatal(err)
		}
	}
	all, err := db.ListPendingItems(ctx, user, []string{store.PendingOpen, store.PendingSuperseded}, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	stillOpen := map[string]bool{"hands:sess_c:permission": true, "turn_failed:user_retired:other:codex:p:session:sess_d": true}
	if len(all) != 6 {
		t.Fatalf("items = %d, want 6", len(all))
	}
	for _, item := range all {
		if stillOpen[item.Key] {
			if item.State != store.PendingOpen {
				t.Errorf("%s = %s, want open", item.Key, item.State)
			}
			continue
		}
		if item.State != store.PendingSuperseded || item.ResolutionDetail != retiredPendingDetail ||
			item.ResolutionReason != store.PendingResolutionAutoResolved {
			t.Errorf("%s = %s (%s/%s), want superseded as retired", item.Key, item.State, item.ResolutionReason, item.ResolutionDetail)
		}
	}
}
