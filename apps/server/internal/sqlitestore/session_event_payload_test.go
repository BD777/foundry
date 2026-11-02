package sqlitestore

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A stored payload leaves out what its row holds (id, sessionId, level,
// at when it is created_at) and a detail that repeats the message's text;
// decoding with the row's columns gives back the event as written,
// including a detail that differs from the text or is empty beside it.
func TestSessionEventPayloadLeavesOutWhatTheRowHolds(t *testing.T) {
	const createdAt = "2026-11-02T10:00:00.123456789Z"
	message := func(text string) *store.TranscriptMessage {
		return &store.TranscriptMessage{ID: "m1", Kind: "tool", Text: text, CallID: "call_1", Status: "completed"}
	}
	for _, test := range []struct {
		name    string
		event   store.AgentSessionEvent
		absent  []string
		present []string
	}{
		{"detail repeats the text", store.AgentSessionEvent{Label: "Used tool", Detail: "out", Message: message("out")},
			[]string{"id", "sessionId", "level", "at", "detail"}, []string{"label", "message"}},
		{"detail differs from the text", store.AgentSessionEvent{Label: "Used tool", Detail: "summary", Message: message("out")},
			[]string{"id", "sessionId", "level", "at"}, []string{"detail"}},
		{"empty detail beside a text", store.AgentSessionEvent{Label: "Used tool", Detail: "", Message: message("out")},
			[]string{"at"}, []string{"detail"}},
		{"no message, no detail", store.AgentSessionEvent{Label: "Model request usage", Metadata: &store.AgentSessionEventMetadata{RequestUsage: &store.ModelRequestUsage{RequestID: "r"}}},
			[]string{"detail", "at"}, []string{"metadata"}},
		{"no message, a detail", store.AgentSessionEvent{Label: "Notice", Detail: "hello"},
			[]string{"at"}, []string{"detail"}},
		{"its own time", store.AgentSessionEvent{Label: "Native transcript", At: "2026-10-01T00:00:00Z", Message: message("x"), Detail: "x"},
			[]string{"detail"}, []string{"at"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			event := test.event
			event.ID, event.SessionID, event.Level = "evt_1", "sess_1", "info"
			if event.At == "" {
				event.At = createdAt
			}
			payload, err := encodeSessionEvent(event, createdAt)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal([]byte(payload), &fields); err != nil {
				t.Fatal(err)
			}
			for _, field := range test.absent {
				if _, ok := fields[field]; ok {
					t.Errorf("payload %s holds %q", payload, field)
				}
			}
			for _, field := range test.present {
				if _, ok := fields[field]; !ok {
					t.Errorf("payload %s lacks %q", payload, field)
				}
			}
			decoded, err := decodeSessionEvent("evt_1", "sess_1", "info", createdAt, []byte(payload))
			if err != nil || !reflect.DeepEqual(decoded, event) {
				t.Fatalf("decoded %+v, %v; want %+v", decoded, err, event)
			}
			// A payload stored whole, as servers before this one did,
			// decodes the same.
			whole, _ := encode(event)
			if decoded, err := decodeSessionEvent("evt_1", "sess_1", "info", createdAt, []byte(whole)); err != nil || !reflect.DeepEqual(decoded, event) {
				t.Fatalf("whole payload decoded %+v, %v; want %+v", decoded, err, event)
			}
		})
	}
}

// Every read of a session's events (whole, windowed, catching up, the
// panel's state events) returns them as written, from slim and whole
// payloads alike, and an event sent again unchanged is still recognised.
func TestStoredSessionEventsReadBackWhole(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_slim", "agent_slim")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_slim", AgentID: "agent_slim", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Add(time.Minute)
	tasks := []store.AgentBackgroundTask{{ID: "t1", Provider: "claude", Kind: "shell", Description: "npm test", Status: "running", StartedAt: formatTime(base)}}
	written := []store.AgentSessionEvent{
		{ID: "evt_slim_tool", Label: "Used tool", Detail: "Bash\n\nok", Level: "info", Message: &store.TranscriptMessage{ID: "m1", Kind: "tool", Text: "Bash\n\nok", CallID: "c1", Status: "completed"}},
		{ID: "evt_slim_note", Label: "Notice", Detail: "a notice", Level: "warning"},
		{ID: "evt_slim_empty", Label: "Thought", Detail: "", Level: "info", Message: &store.TranscriptMessage{ID: "m2", Kind: "reasoning", Text: "hmm"}},
		{ID: "evt_slim_background", Label: "Background tasks updated", Level: "info", Metadata: &store.AgentSessionEventMetadata{BackgroundTaskSnapshot: &tasks}},
	}
	for index := range written {
		written[index].SessionID = session.ID
		written[index].At = formatTime(base.Add(time.Duration(index) * time.Second))
		if err := db.AppendAgentSessionEvent(ctx, written[index]); err != nil {
			t.Fatal(err)
		}
	}
	// One stored whole, as a server before this one stored it.
	legacy := store.AgentSessionEvent{ID: "evt_slim_legacy", SessionID: session.ID, At: formatTime(base.Add(10 * time.Second)), Label: "Response stream", Detail: "old answer", Level: "info"}
	whole, _ := encode(legacy)
	if _, err := db.conn().ExecContext(ctx, `INSERT INTO agent_session_events (id, session_id, level, payload_json, created_at, state_key) VALUES (?, ?, ?, ?, ?, '')`,
		legacy.ID, session.ID, legacy.Level, whole, legacy.At); err != nil {
		t.Fatal(err)
	}
	written = append(written, legacy)

	var payload string
	if err := db.conn().QueryRowContext(ctx, `SELECT payload_json FROM agent_session_events WHERE id = 'evt_slim_tool'`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(payload), &fields); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"id", "sessionId", "level", "at", "detail"} {
		if _, ok := fields[field]; ok {
			t.Fatalf("stored payload %s holds %q", payload, field)
		}
	}

	byID := func(events []store.AgentSessionEvent) map[string]store.AgentSessionEvent {
		out := map[string]store.AgentSessionEvent{}
		for _, event := range events {
			out[event.ID] = event
		}
		return out
	}
	full, err := db.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	window, _, _, err := db.AgentSessionEventWindowSpan(ctx, session.ID, "", 100)
	if err != nil {
		t.Fatal(err)
	}
	firstCursor, err := db.AgentSessionOldestEventCursor(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	after, _, _, err := db.AgentSessionEventsAfter(ctx, session.ID, firstCursor, 100)
	if err != nil {
		t.Fatal(err)
	}
	state, err := db.AgentSessionStateEvents(ctx, session.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	for name, read := range map[string]map[string]store.AgentSessionEvent{
		"whole": byID(full.Events), "window": byID(window), "after": byID(after),
	} {
		for _, event := range written {
			if got := read[event.ID]; !reflect.DeepEqual(got, event) {
				t.Errorf("%s read %+v; want %+v", name, got, event)
			}
		}
	}
	if got := byID(state)["evt_slim_background"]; !reflect.DeepEqual(got, written[3]) {
		t.Errorf("state event %+v; want %+v", got, written[3])
	}
	// The same event again changes nothing.
	if stored, err := db.RecordAgentSessionEvent(ctx, written[0]); err != nil || stored {
		t.Fatalf("resent event stored = %v, %v; want it recognised", stored, err)
	}
}
