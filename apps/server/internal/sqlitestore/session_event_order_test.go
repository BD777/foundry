package sqlitestore

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// created_at is RFC3339Nano text: trailing zeros are trimmed, so a
// later time can sort first as text (.751400Z formats as .7514Z, which
// sorts after .751401Z). A read must still return the events in time
// order.
func TestSessionEventsReadInTimeOrderDespiteTrimmedZeros(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	const session = "sess_trimmed"
	early := time.Date(2026, 11, 15, 22, 11, 20, 751400000, time.UTC)
	saveTestEvent(t, db, store.AgentSessionEvent{ID: "evt_late", SessionID: session, Label: "Late"}, early.Add(time.Microsecond))
	saveTestEvent(t, db, store.AgentSessionEvent{ID: "evt_early", SessionID: session, Label: "Early"}, early)
	events, err := listSessionEventsChronologically(ctx, db.conn(), `SELECT `+sessionEventColumns+` FROM agent_session_events WHERE session_id = ? ORDER BY created_at ASC`, session)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].ID != "evt_early" || events[1].ID != "evt_late" {
		t.Fatalf("events = %+v, want early then late", events)
	}
}
