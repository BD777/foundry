package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A link opens a chat at a message thousands of events back: one read with
// ?eventsThrough= reaches back from the reader's cursor to that message
// (by its message id, or an event's own id) and a few events before it,
// as one contiguous page whose cursor paging continues from. A message no
// event before the cursor holds is 404, whether gone or already loaded; the
// thread read refuses the parameter.
func TestEventsThroughReadsBackToAMessage(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	registerCatchUpDaemon(t, db, "dev_seek", "ws_seek", "agent_seek")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_seek", AgentID: "agent_seek", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	// After the session's input event, which is stored now.
	start := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	ids := make([]string, 60)
	for index := range ids {
		ids[index] = fmt.Sprintf("evt_seek_%02d", index)
		event := store.AgentSessionEvent{
			ID: ids[index], SessionID: session.ID, Label: "Response", Level: "info",
			At:      start.Add(time.Duration(index) * time.Second).Format(time.RFC3339Nano),
			Message: &store.TranscriptMessage{ID: fmt.Sprintf("msg_%02d", index), Kind: "assistant", Text: fmt.Sprint(index)},
		}
		if err := db.AppendAgentSessionEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db)
	sessionPath := "/api/agent-sessions/" + session.ID
	read := func(query string, status int) windowedSessionForTest {
		t.Helper()
		var page windowedSessionForTest
		raw := getRawForTest(t, server, sessionPath+"?"+query, status)
		if status == http.StatusOK {
			if err := json.Unmarshal(raw, &page); err != nil {
				t.Fatal(err)
			}
		}
		return page
	}
	newest := read("eventsLimit=5", http.StatusOK)
	if newest.EventsBefore == nil || !slices.Equal(windowEventIDs(newest.Events), ids[55:]) {
		t.Fatalf("newest window = %v; want the newest 5 and a cursor", windowEventIDs(newest.Events))
	}
	cursor := url.QueryEscape(*newest.EventsBefore)

	seek := read("eventsLimit=3&eventsBefore="+cursor+"&eventsThrough=msg_20", http.StatusOK)
	got := windowEventIDs(seek.Events)
	if !slices.Contains(got, ids[20]) || !slices.Contains(got, ids[17]) || got[len(got)-1] != ids[54] {
		t.Fatalf("seek page = %v; want every event from %s back past %s", got, ids[54], ids[17])
	}
	if seek.EventsBefore == nil || *seek.EventsBefore == "" {
		t.Fatalf("seek page holds no cursor to continue paging from: %+v", seek)
	}
	older := read("eventsLimit=100&eventsBefore="+url.QueryEscape(*seek.EventsBefore), http.StatusOK)
	all := append(windowEventIDs(older.Events), got...)
	if len(all) != 56 || !slices.Equal(all[1:], ids[:55]) {
		t.Fatalf("paging on from the seek = %v; want the input and the events before it exactly once", all)
	}

	byEvent := read("eventsLimit=1&eventsBefore="+cursor+"&eventsThrough="+ids[30], http.StatusOK)
	if !slices.Contains(windowEventIDs(byEvent.Events), ids[30]) {
		t.Fatalf("seek by event id = %v; want it to hold %s", windowEventIDs(byEvent.Events), ids[30])
	}

	read("eventsLimit=3&eventsBefore="+cursor+"&eventsThrough=msg_gone", http.StatusNotFound)
	// Already loaded (newer than the cursor): nothing before it to reach.
	read("eventsLimit=3&eventsBefore="+cursor+"&eventsThrough=msg_57", http.StatusNotFound)
	read("eventsLimit=3&eventsBefore="+url.QueryEscape(*seek.EventsBefore)+"&eventsThrough=msg_20", http.StatusNotFound)
	getRawForTest(t, server, "/api/agent-session-threads/"+session.ID+"?workspaceId=ws_seek&eventsLimit=3&eventsThrough=msg_20", http.StatusBadRequest)
	getRawForTest(t, server, sessionPath+"?eventsAfter="+cursor+"&eventsThrough=msg_20", http.StatusBadRequest)
}
