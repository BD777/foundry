package sqlitestore

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func eventIDs(events []store.AgentSessionEvent) []string {
	ids := make([]string, len(events))
	for index, event := range events {
		ids[index] = event.ID
	}
	return ids
}

// Paging a session's events newest first, a page at a time, yields exactly
// the full transcript in its order, including events created at the same
// instant (which the index orders by rowid).
func TestAgentSessionEventWindowPagesTheWholeTranscriptInOrder(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_window", "agent_window")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_window", AgentID: "agent_window", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Add(time.Minute)
	for index := range 9 {
		// Three events per instant: ties are broken by insertion order.
		at := base.Add(time.Duration(index/3) * time.Second)
		event := store.AgentSessionEvent{ID: fmt.Sprintf("evt_window_%d", index), SessionID: session.ID, Label: "Response stream", Detail: fmt.Sprint(index), Level: "info"}
		if err := db.saveAgentSessionEvent(ctx, event, at); err != nil {
			t.Fatal(err)
		}
	}
	full, err := db.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := eventIDs(full.Events)
	if len(want) < 10 {
		t.Fatalf("transcript = %v; want the input events and 9 more", want)
	}

	var paged []string
	before, pages := "", 0
	for {
		events, older, err := db.AgentSessionEventWindow(ctx, session.ID, before, 4)
		if err != nil {
			t.Fatal(err)
		}
		if len(events) > 4 {
			t.Fatalf("page of %d events, limit 4", len(events))
		}
		paged = append(eventIDs(events), paged...)
		pages++
		if older == "" {
			break
		}
		if older == before || pages > len(want) {
			t.Fatalf("cursor %q does not advance", older)
		}
		before = older
	}
	if !slices.Equal(paged, want) {
		t.Fatalf("paged transcript\n %v\nwant\n %v", paged, want)
	}
	if wantPages := (len(want) + 3) / 4; pages != wantPages {
		t.Fatalf("%d pages, want %d", pages, wantPages)
	}

	// A window as large as the transcript says nothing is older.
	events, older, err := db.AgentSessionEventWindow(ctx, session.ID, "", len(want))
	if err != nil || older != "" || !slices.Equal(eventIDs(events), want) {
		t.Fatalf("whole window = %v, %q, %v", eventIDs(events), older, err)
	}
	for _, cursor := range []string{"not base64!", "eA", encodeEventsCursor("", 3), "MDox"} {
		if _, _, err := db.AgentSessionEventWindow(ctx, session.ID, cursor, 4); !errors.Is(err, store.ErrInvalidEventsCursor) {
			t.Fatalf("cursor %q: err = %v, want ErrInvalidEventsCursor", cursor, err)
		}
	}
}

// The window reads the session's events through its index, newest first,
// without sorting the session's whole history.
func TestAgentSessionEventWindowUsesTheSessionIndex(t *testing.T) {
	db := newTestStore(t)
	for _, paged := range []bool{false, true} {
		args := []any{"sess", 1}
		if paged {
			args = []any{"sess", "2026-01-01T00:00:00~", 1}
		}
		rows, err := db.conn().QueryContext(context.Background(), "EXPLAIN QUERY PLAN "+eventWindowQuery(paged), args...)
		if err != nil {
			t.Fatal(err)
		}
		var plan []string
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
				t.Fatal(err)
			}
			plan = append(plan, detail)
		}
		rows.Close()
		joined := strings.Join(plan, "; ")
		if !strings.Contains(joined, "idx_agent_session_events_session_created") || strings.Contains(joined, "TEMP B-TREE") {
			t.Fatalf("paged=%v plan = %s; want the session index without a sort", paged, joined)
		}
	}
}

func TestAgentSessionThreadRecordsCarryNoEvents(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_records", "agent_records")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_records", AgentID: "agent_records", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	full, err := db.ListAgentSessionThread(ctx, "ws_records", session.ID)
	if err != nil {
		t.Fatal(err)
	}
	records, err := db.ListAgentSessionThreadRecords(ctx, "ws_records", session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || len(full) != 1 || records[0].ID != full[0].ID || records[0].Events != nil || len(full[0].Events) == 0 {
		t.Fatalf("records = %+v; want the thread's sessions without the events %d full ones carry", records, len(full[0].Events))
	}
}

// Every position in a trimmed fractional second can be a page boundary.
// Sorting only a LIMIT page loses the chronologically adjacent rows outside it.
func TestAgentSessionEventWindowOrdersFractionalBoundaries(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_fraction_window", "agent_fraction_window")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_fraction_window", AgentID: "agent_fraction_window", Provider: "codex", Prompt: "opening"})
	if err != nil {
		t.Fatal(err)
	}
	// Keep only our events, so the exact expected order is independent of the
	// creation-time bookkeeping events.
	if _, err := db.conn().ExecContext(ctx, `DELETE FROM agent_session_events WHERE session_id = ?`, session.ID); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
	offsets := []time.Duration{0, 120 * time.Millisecond, 123 * time.Millisecond, 123400 * time.Microsecond, 500 * time.Millisecond, time.Second, time.Second + 120*time.Millisecond, time.Second + 123*time.Millisecond, 2 * time.Second}
	var want []string
	for i, offset := range offsets {
		id := fmt.Sprintf("fraction-%d", i)
		if err := db.saveAgentSessionEvent(ctx, store.AgentSessionEvent{ID: id, SessionID: session.ID, Label: "User message", Detail: id, Level: "info"}, base.Add(offset)); err != nil {
			t.Fatal(err)
		}
		want = append(want, id)
	}
	for size := 1; size <= len(want); size++ {
		before := ""
		var got []string
		for count := 0; ; count++ {
			if count > len(want) {
				t.Fatal("paging did not terminate")
			}
			events, older, newest, err := db.AgentSessionEventWindowSpan(ctx, session.ID, before, size)
			if err != nil {
				t.Fatal(err)
			}
			got = append(eventIDs(events), got...)
			if len(events) > 0 {
				after, _, more, err := db.AgentSessionEventsAfter(ctx, session.ID, newest, 100)
				if err != nil || more {
					t.Fatalf("catch-up: %v %v", more, err)
				}
				last := slices.Index(want, events[len(events)-1].ID)
				if !slices.Equal(eventIDs(after), want[last+1:]) {
					t.Fatalf("after page newest: %v, want %v", eventIDs(after), want[last+1:])
				}
			}
			if older == "" {
				break
			}
			before = older
		}
		if !slices.Equal(got, want) {
			t.Fatalf("page size %d: %v; want %v", size, got, want)
		}
	}
	for _, cursor := range []string{encodeEventsCursor("invalid", 1), encodeEventsCursor("2026-10-27T00:00:00.wrongZ", 1)} {
		if _, _, err := db.AgentSessionEventWindow(ctx, session.ID, cursor, 1); !errors.Is(err, store.ErrInvalidEventsCursor) {
			t.Fatalf("invalid time cursor: %v", err)
		}
	}
}
