package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// compactionFixture is apps/web/test/fixtures/session-event-compaction.json:
// one session read through the transcript API before and after its events
// were compacted. The web's own projection renders both the same
// (apps/web/test/session-event-compaction.test.mjs). Rewrite it with
// FOUNDRY_WRITE_COMPACTION_FIXTURE=1 go test ./internal/httpapi -run TestSessionEventCompactionKeepsTranscript,
// then format it with prettier.
const compactionFixture = "../../../web/test/fixtures/session-event-compaction.json"

// Compaction removes what an idle session's transcript stores more than
// once: a step's earlier snapshot, a usage report its step now carries, old
// context reports and background snapshots. Every read the web makes (the
// newest window, the pages before it, the whole session) then returns the
// same transcript without them and the same side panel (the server derives
// it, store.DeriveSessionPanel), and the conversation a native session is
// told is unchanged; snapshots something still shows in place stay, as do
// the events the panel reads.
func TestSessionEventCompactionKeepsTranscript(t *testing.T) {
	db := newEmptyTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_compact", Label: "Compact Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_compact", Name: "Compact", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{{
			ID: "agent_compact", WorkspaceID: "ws_compact", DeviceID: "dev_compact", DeviceLabel: "Compact Device",
			Provider: "claude", Status: "healthy", AuthMode: "local_config", SecretStored: "local",
			ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_compact", AgentID: "agent_compact", Provider: "claude", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	inputAt, err := time.Parse(time.RFC3339Nano, session.Input.At)
	if err != nil {
		t.Fatal(err)
	}
	step := 0
	event := func(id, label string, message *store.TranscriptMessage, metadata *store.AgentSessionEventMetadata) {
		t.Helper()
		step++
		at := inputAt.Add(time.Duration(step) * time.Microsecond).Format(time.RFC3339Nano)
		value := store.AgentSessionEvent{ID: id, SessionID: session.ID, At: at, Label: label, Level: "info", Message: message, Metadata: metadata}
		if message != nil {
			value.Detail = message.Text
		}
		if err := db.AppendAgentSessionEvent(ctx, value); err != nil {
			t.Fatal(err)
		}
	}
	tokens := func(value int64) *int64 { return &value }
	usage := func(id string, input, cacheRead, output int64) *store.ModelRequestUsage {
		return &store.ModelRequestUsage{RequestID: id, InputTokens: input, CacheReadTokens: cacheRead, OutputTokens: output}
	}
	background := func(status string, tasks int) *store.AgentSessionEventMetadata {
		snapshot := []store.AgentBackgroundTask{}
		for range tasks {
			snapshot = append(snapshot, store.AgentBackgroundTask{ID: "task_1", Provider: "claude", Kind: "shell", Description: "npm test", Status: status, StartedAt: session.Input.At})
		}
		return &store.AgentSessionEventMetadata{BackgroundTaskSnapshot: &snapshot}
	}
	toolInput := "Bash\n\n```json\n{\"command\":\"go test ./...\"}\n```"
	event("evt_think_1", "Thinking", &store.TranscriptMessage{ID: "think", Kind: "reasoning", Status: "running", Text: "Let me"}, nil)
	event("evt_think_2", "Thought", &store.TranscriptMessage{ID: "think", Kind: "reasoning", Status: "completed", Text: "Let me run the tests."}, nil)
	event("evt_tool_1", "Using tool", &store.TranscriptMessage{ID: "tool", Kind: "tool", CallID: "call_1", Status: "running", Title: "Using tool", Text: toolInput, RequestUsage: usage("req_1", 10, 0, 1)}, nil)
	event("evt_usage_1", "Model request usage", nil, &store.AgentSessionEventMetadata{RequestUsage: usage("req_1", 10, 5, 40)})
	event("evt_context_1", "Model request usage", nil, &store.AgentSessionEventMetadata{ContextUsage: &store.AgentContextUsage{InputTokens: tokens(1000), ContextWindow: tokens(200000), Model: "claude-x"}})
	event("evt_context_2", "Model request usage", nil, &store.AgentSessionEventMetadata{ContextUsage: &store.AgentContextUsage{InputTokens: tokens(1100)}})
	event("evt_background_1", "Background tasks updated", nil, background("running", 1))
	event("evt_tool_2", "Used tool", &store.TranscriptMessage{ID: "tool", Kind: "tool", CallID: "call_1", Status: "completed", Title: "Used tool", Text: toolInput + "\n\nok"}, nil)
	event("evt_command_1", "Running command", &store.TranscriptMessage{ID: "command", Kind: "tool", CallID: "call_2", Status: "running", Title: "Running command", Text: "make build"}, nil)
	event("evt_steer", "Steered into active turn", &store.TranscriptMessage{ID: "steer", Kind: "user", Text: "also lint"}, nil)
	event("evt_command_2", "Ran command", &store.TranscriptMessage{ID: "command", Kind: "tool", CallID: "call_2", Status: "completed", Title: "Ran command", Text: "make build\n\nbuilt"}, nil)
	event("evt_commentary_1", "Commentary", &store.TranscriptMessage{ID: "note", Kind: "commentary", Text: "Tests"}, nil)
	event("evt_commentary_2", "Commentary", &store.TranscriptMessage{ID: "note", Kind: "commentary", Text: "Tests pass."}, nil)
	event("evt_context_3", "Model request usage", nil, &store.AgentSessionEventMetadata{ContextUsage: &store.AgentContextUsage{InputTokens: tokens(1200), ContextWindow: tokens(200000), Model: "claude-x"}})
	event("evt_background_2", "Background tasks updated", nil, background("completed", 1))
	event("evt_background_3", "Background tasks updated", nil, background("completed", 0))
	event("evt_answer", "Response stream", &store.TranscriptMessage{ID: "answer", Kind: "assistant", Text: "Done: tests pass."}, nil)
	event("evt_usage_2", "Model request usage", nil, &store.AgentSessionEventMetadata{RequestUsage: usage("req_2", 20, 0, 9)})
	if _, err := db.CompleteAgentSession(ctx, session.ID, "Done: tests pass.", "native_compact"); err != nil {
		t.Fatal(err)
	}
	// A second turn, so the conversation before the current input holds
	// the first.
	if _, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: "second"}); err != nil {
		t.Fatal(err)
	}
	if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{ID: "evt_answer_second", SessionID: session.ID, Label: "Response stream", Level: "info",
		Detail: "Second.", Message: &store.TranscriptMessage{ID: "answer_second", Kind: "assistant", Text: "Second."}}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "Second.", "native_compact"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)

	type sessionRead struct {
		Session      json.RawMessage           `json:"session"`
		Events       []store.AgentSessionEvent `json:"events"`
		Panel        json.RawMessage           `json:"panel"`
		Conversation string                    `json:"conversation"`
	}
	read := func() sessionRead {
		t.Helper()
		var whole struct {
			Events []store.AgentSessionEvent `json:"events"`
		}
		raw := getRawForTest(t, server, "/api/agent-sessions/"+session.ID, http.StatusOK)
		if err := json.Unmarshal(raw, &whole); err != nil {
			t.Fatal(err)
		}
		var summary map[string]json.RawMessage
		if err := json.Unmarshal(raw, &summary); err != nil {
			t.Fatal(err)
		}
		delete(summary, "events")
		sessionJSON, _ := json.Marshal(summary)
		// The chat's reads: the newest window, then pages before it.
		var recent []struct {
			windowedSessionForTest
			Panel json.RawMessage `json:"panel"`
		}
		if err := json.Unmarshal(getRawForTest(t, server, "/api/agent-session-threads/"+session.ID+"?workspaceId=ws_compact&eventsLimit=4", http.StatusOK), &recent); err != nil {
			t.Fatal(err)
		}
		paged := recent[0].Events
		for before := recent[0].EventsBefore; before != nil; {
			var page windowedSessionForTest
			if err := json.Unmarshal(getRawForTest(t, server, "/api/agent-sessions/"+session.ID+"?eventsLimit=4&eventsBefore="+url.QueryEscape(*before), http.StatusOK), &page); err != nil {
				t.Fatal(err)
			}
			paged, before = append(page.Events, paged...), page.EventsBefore
		}
		encodedPaged, _ := json.Marshal(paged)
		encodedWhole, _ := json.Marshal(whole.Events)
		if string(encodedPaged) != string(encodedWhole) {
			t.Fatalf("the paged windows read\n%s\nthe whole session\n%s", encodedPaged, encodedWhole)
		}
		var conversation struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(getRawForTest(t, server, "/api/agent-sessions/"+session.ID+"/conversation", http.StatusOK), &conversation); err != nil {
			t.Fatal(err)
		}
		// The whole session's newest window carries the same panel.
		var single struct {
			Panel json.RawMessage `json:"panel"`
		}
		if err := json.Unmarshal(getRawForTest(t, server, "/api/agent-sessions/"+session.ID+"?eventsLimit=1000", http.StatusOK), &single); err != nil {
			t.Fatal(err)
		}
		if string(single.Panel) != string(recent[0].Panel) {
			t.Fatalf("the session read's panel\n%s\nthe thread read's\n%s", single.Panel, recent[0].Panel)
		}
		return sessionRead{Session: sessionJSON, Events: whole.Events, Panel: recent[0].Panel, Conversation: conversation.Text}
	}
	before := read()
	if before.Conversation != "User: first\n\nUser: also lint\n\nAssistant: Done: tests pass." {
		t.Fatalf("conversation = %q", before.Conversation)
	}

	report, err := db.CompactSessionEvents(ctx, time.Now().Add(time.Hour), 0)
	if err != nil {
		t.Fatal(err)
	}
	if report.Sessions != 1 || report.Conflicts != 0 {
		t.Fatalf("compaction = %+v; want the one session", report)
	}
	after := read()
	if after.Conversation != before.Conversation {
		t.Fatalf("conversation after compaction = %q; before %q", after.Conversation, before.Conversation)
	}
	if string(after.Panel) != string(before.Panel) {
		t.Fatalf("panel after compaction\n%s\nbefore\n%s", after.Panel, before.Panel)
	}
	var panel store.AgentSessionPanel
	if err := json.Unmarshal(before.Panel, &panel); err != nil {
		t.Fatal(err)
	}
	if panel.Usage.UsedTokens == nil || *panel.Usage.UsedTokens != 1200 || panel.Usage.ContextWindow == nil || *panel.Usage.ContextWindow != 200000 {
		t.Fatalf("panel usage = %+v; want the newest report's 1200 of 200000", panel.Usage)
	}
	// The newest context report of each kind stays for the panel; the
	// older usage report and background snapshots go.
	removed := []string{"evt_think_1", "evt_tool_1", "evt_usage_1", "evt_background_1", "evt_background_2", "evt_commentary_1"}
	var kept []store.AgentSessionEvent
	for _, event := range before.Events {
		if !slices.Contains(removed, event.ID) {
			kept = append(kept, event)
		}
	}
	// The finished tool step carries the usage its request reported.
	for index := range kept {
		if kept[index].ID == "evt_tool_2" {
			message := *kept[index].Message
			message.RequestUsage = usage("req_1", 10, 5, 40)
			kept[index].Message = &message
		}
	}
	want, _ := json.Marshal(kept)
	got, _ := json.Marshal(after.Events)
	if string(got) != string(want) {
		t.Fatalf("events after compaction\n%s\nwant\n%s", got, want)
	}
	// Compacting again finds nothing new.
	if again, err := db.CompactSessionEvents(ctx, time.Now().Add(time.Hour), 0); err != nil || again.Sessions != 0 {
		t.Fatalf("second compaction = %+v, %v; want nothing to do", again, err)
	}

	if os.Getenv("FOUNDRY_WRITE_COMPACTION_FIXTURE") == "1" {
		fixture, err := json.MarshalIndent(map[string]any{
			"comment": "Written by TestSessionEventCompactionKeepsTranscript (apps/server/internal/httpapi): one session read before and after its events were compacted.",
			"before":  before,
			"after":   after,
		}, "", " ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(compactionFixture), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(compactionFixture, append(fixture, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}
