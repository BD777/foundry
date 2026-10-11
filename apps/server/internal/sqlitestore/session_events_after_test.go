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

// A reader that missed stream events catches up from the newest event of
// its window: it reads exactly the events stored since, oldest first, with
// those of one instant in rowid order, and an event stored again in place
// (a growing answer) once more. It reads nothing, or everything, never a
// part: when more than its limit followed it is told to read the newest
// window instead.
func TestAgentSessionEventsAfterCatchesUpFromAWindow(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_after", "agent_after")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_after", AgentID: "agent_after", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Add(time.Minute)
	save := func(id, detail string, at time.Time) {
		t.Helper()
		event := store.AgentSessionEvent{ID: id, SessionID: session.ID, Label: "Response stream", Detail: detail, Level: "info"}
		if err := db.saveAgentSessionEvent(ctx, event, at); err != nil {
			t.Fatal(err)
		}
	}
	for index := range 4 {
		save(fmt.Sprintf("evt_after_%d", index), "seen", base.Add(time.Duration(index)*time.Second))
	}

	window, older, newest, err := db.AgentSessionEventWindowSpan(ctx, session.ID, "", 3)
	if err != nil || older == "" || newest == "" {
		t.Fatalf("window = %v, older %q, newest %q, %v; want a cursor each way", eventIDs(window), older, newest, err)
	}
	if got := eventIDs(window); !slices.Equal(got, []string{"evt_after_1", "evt_after_2", "evt_after_3"}) {
		t.Fatalf("window = %v", got)
	}
	plain, plainOlder, err := db.AgentSessionEventWindow(ctx, session.ID, "", 3)
	if err != nil || plainOlder != older || !slices.Equal(eventIDs(plain), eventIDs(window)) {
		t.Fatalf("AgentSessionEventWindow = %v, %q, %v; want the span's window", eventIDs(plain), plainOlder, err)
	}

	// Nothing stored since: no events, and the same cursor.
	events, next, more, err := db.AgentSessionEventsAfter(ctx, session.ID, newest, 10)
	if err != nil || more || next != newest || len(events) != 0 {
		t.Fatalf("caught up = %v, %q, %v, %v; want [] and the cursor back", eventIDs(events), next, more, err)
	}

	// The newest answer grows in place, and two events share one instant.
	save("evt_after_3", "grown", base.Add(5*time.Second))
	tie := base.Add(6 * time.Second)
	save("evt_after_tie_a", "a", tie)
	save("evt_after_tie_b", "b", tie)
	events, next, more, err = db.AgentSessionEventsAfter(ctx, session.ID, newest, 10)
	if err != nil || more {
		t.Fatalf("catch-up: more %v, %v", more, err)
	}
	if got := eventIDs(events); !slices.Equal(got, []string{"evt_after_3", "evt_after_tie_a", "evt_after_tie_b"}) {
		t.Fatalf("caught up %v; want the grown answer, then the tie in insertion order", got)
	}
	if events[0].Detail != "grown" {
		t.Fatalf("grown answer = %q, want its stored content", events[0].Detail)
	}
	full, err := db.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if want := eventIDs(full.Events)[len(full.Events)-len(events):]; !slices.Equal(eventIDs(events), want) {
		t.Fatalf("caught up %v; want the transcript's tail %v", eventIDs(events), want)
	}
	_, _, windowNewest, err := db.AgentSessionEventWindowSpan(ctx, session.ID, "", 3)
	if err != nil || next != windowNewest {
		t.Fatalf("next cursor %q; want the newest window's %q (%v)", next, windowNewest, err)
	}
	// From the first of two events of one instant, only the second follows.
	_, tieB, _, err := db.AgentSessionEventWindowSpan(ctx, session.ID, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	_, _, tieA, err := db.AgentSessionEventWindowSpan(ctx, session.ID, tieB, 1)
	if err != nil {
		t.Fatal(err)
	}
	if events, _, _, err := db.AgentSessionEventsAfter(ctx, session.ID, tieA, 10); err != nil || !slices.Equal(eventIDs(events), []string{"evt_after_tie_b"}) {
		t.Fatalf("after the first of a tie = %v, %v; want the second", eventIDs(events), err)
	}

	// Too far behind: nothing, and the cursor back, so the reader reads the
	// newest window rather than a part of what it missed.
	events, next, more, err = db.AgentSessionEventsAfter(ctx, session.ID, older, 2)
	if err != nil || !more || len(events) != 0 || next != older {
		t.Fatalf("behind = %v, %q, %v, %v; want more, no events and the cursor back", eventIDs(events), next, more, err)
	}

	for _, cursor := range []string{"", "not base64!", "eA", encodeEventsCursor("", 3), "MDox"} {
		if _, _, _, err := db.AgentSessionEventsAfter(ctx, session.ID, cursor, 4); !errors.Is(err, store.ErrInvalidEventsCursor) {
			t.Fatalf("cursor %q: err = %v, want ErrInvalidEventsCursor", cursor, err)
		}
	}
	if _, _, _, err := db.AgentSessionEventsAfter(ctx, session.ID, newest, 0); err == nil {
		t.Fatal("a limit of 0 must be refused")
	}

	// Another session's cursor, or one naming no event, places the reader
	// nowhere in this transcript.
	other, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_after", AgentID: "agent_after", Provider: "codex", Prompt: "other"})
	if err != nil {
		t.Fatal(err)
	}
	_, _, foreign, err := db.AgentSessionEventWindowSpan(ctx, other.ID, "", 1)
	if err != nil || foreign == "" {
		t.Fatalf("other session's cursor %q, %v", foreign, err)
	}
	for _, cursor := range []string{foreign, encodeEventsCursor(formatTime(base), 1<<40)} {
		if _, _, _, err := db.AgentSessionEventsAfter(ctx, session.ID, cursor, 4); !errors.Is(err, store.ErrEventsCursorGone) {
			t.Fatalf("cursor %q: err = %v, want ErrEventsCursorGone", cursor, err)
		}
	}
	if _, _, empty, err := db.AgentSessionEventWindowSpan(ctx, "sess_missing", "", 3); err != nil || empty != "" {
		t.Fatalf("empty window's newest = %q, %v; want none", empty, err)
	}
}

// Stored times are RFC3339Nano text, which drops trailing zeros: an event
// at a whole second ("…05Z") sorts after the rest of its second ("…05.5Z"),
// and one at "…05.12Z" after "…05.123Z". Catching up from either misses
// none of the events after it in time.
func TestAgentSessionEventsAfterOrdersBySecondsNotText(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_after_text", "agent_after_text")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_after_text", AgentID: "agent_after_text", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	second := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	save := func(id string, at time.Time) {
		t.Helper()
		event := store.AgentSessionEvent{ID: id, SessionID: session.ID, Label: "Tool", Detail: id, Level: "info"}
		if err := db.saveAgentSessionEvent(ctx, event, at); err != nil {
			t.Fatal(err)
		}
	}
	save("evt_whole", second)
	_, _, cursor, err := db.AgentSessionEventWindowSpan(ctx, session.ID, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	save("evt_half", second.Add(500*time.Millisecond))
	save("evt_next", second.Add(1200*time.Millisecond))
	events, next, more, err := db.AgentSessionEventsAfter(ctx, session.ID, cursor, 10)
	if err != nil || more || !slices.Equal(eventIDs(events), []string{"evt_half", "evt_next"}) {
		t.Fatalf("after a whole second = %v, %v, %v; want both later events in time order", eventIDs(events), more, err)
	}

	save("evt_120", second.Add(2*time.Second+120*time.Millisecond))
	_, _, cursor, err = db.AgentSessionEventWindowSpan(ctx, session.ID, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	save("evt_123", second.Add(2*time.Second+123*time.Millisecond))
	if events, _, _, err = db.AgentSessionEventsAfter(ctx, session.ID, cursor, 10); err != nil || !slices.Equal(eventIDs(events), []string{"evt_123"}) {
		t.Fatalf("after …02.12Z = %v, %v; want …02.123Z", eventIDs(events), err)
	}
	if events, _, _, err = db.AgentSessionEventsAfter(ctx, session.ID, next, 10); err != nil || !slices.Equal(eventIDs(events), []string{"evt_120", "evt_123"}) {
		t.Fatalf("after evt_next = %v, %v; want the next second's in time order", eventIDs(events), err)
	}
	// What is before the cursor in its own second does not count toward
	// the limit.
	if events, _, more, err = db.AgentSessionEventsAfter(ctx, session.ID, cursor, 1); err != nil || more || len(events) != 1 {
		t.Fatalf("limit 1 = %v, more %v, %v; want the one later event", eventIDs(events), more, err)
	}
}

// The catch-up reads the session's events through its index, oldest
// first, without sorting the session's history.
func TestAgentSessionEventsAfterUsesTheSessionIndex(t *testing.T) {
	db := newTestStore(t)
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{eventsAfterQuery, []any{"sess", "2026-01-01T00:00:00", 1}},
		{eventsInSecondQuery, []any{"sess", "2026-01-01T00:00:00", "2026-01-01T00:00:00~"}},
	} {
		rows, err := db.conn().QueryContext(context.Background(), "EXPLAIN QUERY PLAN "+query.sql, query.args...)
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
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		joined := strings.Join(plan, "; ")
		if !strings.Contains(joined, "idx_agent_session_events_session_created") || strings.Contains(joined, "TEMP B-TREE") {
			t.Fatalf("plan = %s; want the session index without a sort", joined)
		}
	}
}
