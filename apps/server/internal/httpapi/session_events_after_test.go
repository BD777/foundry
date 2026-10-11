package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type caughtUpForTest struct {
	ID          string                    `json:"id"`
	Status      string                    `json:"status"`
	Events      []store.AgentSessionEvent `json:"events"`
	EventsAfter *string                   `json:"eventsAfter"`
	EventsMore  bool                      `json:"eventsMore"`
}

type catchUpWindowForTest struct {
	windowedSessionForTest
	EventsAfter *string `json:"eventsAfter"`
}

func registerCatchUpDaemon(t *testing.T, db store.Store, device, workspace, agent string) {
	t.Helper()
	if err := db.RegisterDaemon(context.Background(), store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: device, Label: "Catch-up Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: workspace, Name: "Catch-up", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{{
			ID: agent, WorkspaceID: workspace, DeviceID: device, DeviceLabel: "Catch-up Device",
			Provider: "codex", Status: "healthy", AuthMode: "local_config", SecretStored: "local",
			ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
}

func appendCatchUpEvents(t *testing.T, db store.Store, sessionID, prefix string, count int) []string {
	t.Helper()
	ids := make([]string, count)
	for index := range count {
		ids[index] = fmt.Sprintf("%s_%d", prefix, index)
		if err := db.AppendAgentSessionEvent(context.Background(), store.AgentSessionEvent{
			ID: ids[index], SessionID: sessionID, Label: "Response stream", Detail: fmt.Sprint(index), Level: "info",
		}); err != nil {
			t.Fatal(err)
		}
	}
	return ids
}

// A reader that missed stream events reads only those: the newest window
// (of the session or of its thread) names its newest event, and
// ?eventsAfter= from it returns the session and the events stored since,
// with the cursor to catch up from next. A reader too far behind is told
// so and gets none; a cursor of another session is gone; a cursor no read
// returned, or one named with eventsBefore, is refused.
func TestCatchUpReadsTheEventsAfterACursor(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	registerCatchUpDaemon(t, db, "dev_catchup", "ws_catchup", "agent_catchup")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_catchup", AgentID: "agent_catchup", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	appendCatchUpEvents(t, db, session.ID, "evt_seen", 5)
	if _, err := db.CompleteAgentSession(ctx, session.ID, "done", "native_catchup"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	sessionPath := "/api/agent-sessions/" + session.ID
	catchUp := func(query string, status int) (caughtUpForTest, string) {
		t.Helper()
		raw := getRawForTest(t, server, sessionPath+"?"+query, status)
		var page caughtUpForTest
		if status == http.StatusOK {
			if err := json.Unmarshal(raw, &page); err != nil {
				t.Fatal(err)
			}
		}
		return page, string(raw)
	}

	var window catchUpWindowForTest
	if err := json.Unmarshal(getRawForTest(t, server, sessionPath+"?eventsLimit=3", http.StatusOK), &window); err != nil {
		t.Fatal(err)
	}
	if window.EventsAfter == nil || *window.EventsAfter == "" || window.EventsBefore == nil || len(window.Events) != 3 {
		t.Fatalf("newest window = %+v; want 3 events and a cursor each way", window)
	}
	cursor := *window.EventsAfter
	var thread []catchUpWindowForTest
	if err := json.Unmarshal(getRawForTest(t, server, "/api/agent-session-threads/"+session.ID+"?workspaceId=ws_catchup&eventsLimit=3", http.StatusOK), &thread); err != nil {
		t.Fatal(err)
	}
	if len(thread) != 1 || thread[0].EventsAfter == nil || *thread[0].EventsAfter != cursor {
		t.Fatalf("thread window = %+v; want the session's catch-up cursor %q", thread, cursor)
	}
	var older catchUpWindowForTest
	if err := json.Unmarshal(getRawForTest(t, server, sessionPath+"?eventsLimit=3&eventsBefore="+url.QueryEscape(*window.EventsBefore), http.StatusOK), &older); err != nil {
		t.Fatal(err)
	}
	if older.EventsAfter != nil || len(older.Events) == 0 {
		t.Fatalf("older page = %+v; want events without a catch-up cursor", older)
	}

	// Nothing missed: [] and the same cursor.
	page, raw := catchUp("eventsAfter="+url.QueryEscape(cursor), http.StatusOK)
	if page.ID != session.ID || page.Status != "completed" || page.EventsAfter == nil || *page.EventsAfter != cursor || page.EventsMore ||
		!strings.Contains(raw, `"events":[]`) || strings.Contains(raw, `"eventsMore"`) {
		t.Fatalf("nothing missed = %s; want the session, [] and the cursor back", raw)
	}

	missed := appendCatchUpEvents(t, db, session.ID, "evt_missed", 2)
	page, _ = catchUp("eventsAfter="+url.QueryEscape(cursor), http.StatusOK)
	if !slices.Equal(windowEventIDs(page.Events), missed) || page.EventsAfter == nil || *page.EventsAfter == cursor || page.EventsMore {
		t.Fatalf("caught up %v, cursor %v; want %v and a new cursor", windowEventIDs(page.Events), page.EventsAfter, missed)
	}
	next := *page.EventsAfter
	if page, _ = catchUp("eventsAfter="+url.QueryEscape(next), http.StatusOK); len(page.Events) != 0 || *page.EventsAfter != next {
		t.Fatalf("from the new cursor = %v, %q; want nothing", windowEventIDs(page.Events), *page.EventsAfter)
	}
	if err := json.Unmarshal(getRawForTest(t, server, sessionPath+"?eventsLimit=3", http.StatusOK), &window); err != nil || *window.EventsAfter != next {
		t.Fatalf("newest window's cursor %v (%v); want the catch-up's %q", window.EventsAfter, err, next)
	}

	// Too far behind: no events, so the reader reads the newest window.
	appendCatchUpEvents(t, db, session.ID, "evt_burst", 3)
	page, raw = catchUp("eventsLimit=2&eventsAfter="+url.QueryEscape(next), http.StatusOK)
	if !page.EventsMore || !strings.Contains(raw, `"events":[]`) || *page.EventsAfter != next {
		t.Fatalf("behind = %s; want eventsMore, [] and the cursor back", raw)
	}

	other, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_catchup", AgentID: "agent_catchup", Provider: "codex", Prompt: "other"})
	if err != nil {
		t.Fatal(err)
	}
	var otherWindow catchUpWindowForTest
	if err := json.Unmarshal(getRawForTest(t, server, "/api/agent-sessions/"+other.ID+"?eventsLimit=1", http.StatusOK), &otherWindow); err != nil || otherWindow.EventsAfter == nil {
		t.Fatalf("other session's window = %+v, %v", otherWindow, err)
	}
	catchUp("eventsAfter="+url.QueryEscape(*otherWindow.EventsAfter), http.StatusGone)

	for _, query := range []string{
		"eventsAfter=" + url.QueryEscape(next) + "&eventsBefore=" + url.QueryEscape(next),
		"eventsAfter=not-a-cursor",
		"eventsAfter=",
		"eventsAfter=" + url.QueryEscape(next) + "&eventsLimit=0",
	} {
		catchUp(query, http.StatusBadRequest)
	}
	getRawForTest(t, server, "/api/agent-sessions/sess_missing?eventsAfter="+url.QueryEscape(next), http.StatusNotFound)
}

// A catch-up is a session read: a caller who cannot read the session is
// refused exactly as the plain read refuses it.
func TestCatchUpIsRefusedLikeTheSessionRead(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	db := f.server.store
	registerCatchUpDaemon(t, db, "dev_alice", "ws_alice", "agent_alice_catchup")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice_catchup", Provider: "codex", Prompt: "private",
	})
	if err != nil {
		t.Fatal(err)
	}
	appendCatchUpEvents(t, db, session.ID, "evt_private", 2)
	sessionPath := "/api/agent-sessions/" + session.ID
	window := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, sessionPath+"?eventsLimit=1", ""))
	expectStatus(t, window, http.StatusOK, "alice reads her session's newest window")
	var newest catchUpWindowForTest
	if err := json.Unmarshal(window.Body.Bytes(), &newest); err != nil || newest.EventsAfter == nil {
		t.Fatalf("alice's window = %s, %v", window.Body.String(), err)
	}
	appendCatchUpEvents(t, db, session.ID, "evt_private_more", 1)
	catchUpPath := sessionPath + "?eventsAfter=" + url.QueryEscape(*newest.EventsAfter)
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, catchUpPath, "")), http.StatusOK, "alice catches up")

	plain := doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, sessionPath, ""))
	refused := doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, catchUpPath, ""))
	if plain.Code == http.StatusOK || refused.Code != plain.Code || strings.Contains(refused.Body.String(), "evt_private") {
		t.Fatalf("bob's catch-up = %d %s; want the plain read's refusal (%d)", refused.Code, refused.Body.String(), plain.Code)
	}
}
