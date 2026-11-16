package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// seedProgressSession records one running turn with the facts an
// orchestrator pulls: a completed tool call, three identical failures, a
// rate-limit storm, a plan step, a running background task and a last error.
func seedProgressSession(t *testing.T, db store.Store, workspaceID, agentID string) store.AgentSession {
	t.Helper()
	ctx := context.Background()
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: workspaceID, AgentID: agentID, Provider: "claude", Prompt: "Run the checks", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	// The session's own input event is recorded at start; the turn this
	// fixture describes follows it.
	base := time.Now().UTC().Add(time.Minute)
	append := func(event store.AgentSessionEvent) {
		t.Helper()
		event.SessionID = session.ID
		if event.ID == "" {
			event.ID = fmt.Sprintf("evt_%s_%d", session.ID, time.Now().UnixNano())
		}
		if event.Level == "" {
			event.Level = "info"
		}
		if err := db.AppendAgentSessionEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	at := func(offset time.Duration) string { return base.Add(offset).Format(time.RFC3339Nano) }
	tool := func(at, label, detail, id string) store.AgentSessionEvent {
		return store.AgentSessionEvent{At: at, Label: label, Detail: detail,
			Message: &store.TranscriptMessage{ID: id, CallID: id, Kind: "tool", Status: "running"}}
	}
	bash := "Bash\n\n```json\n{\"command\":\"make test\"}\n```"
	bad := "Bash\n\n```json\n{\"command\":\"make test\"}\n```"
	append(store.AgentSessionEvent{At: at(0), Label: store.EventLabelUserMessage, Detail: "Run the checks."})
	append(tool(at(time.Minute), store.ProcessLabelUsingTool, bash, "t1"))
	append(tool(at(2*time.Minute), store.ProcessLabelUsedTool, bash, "t1"))
	for index := 0; index < 3; index++ {
		id := fmt.Sprintf("f%d", index)
		append(tool(at(time.Duration(3+2*index)*time.Minute), store.ProcessLabelUsingTool, bad, id))
		append(tool(at(time.Duration(4+2*index)*time.Minute), store.ProcessLabelToolFailed, bad, id))
	}
	for index := 0; index < 5; index++ {
		append(store.AgentSessionEvent{At: at(time.Duration(9+index) * time.Minute), Label: store.ProcessLabelRateLimited, Detail: "HTTP 429", Level: "warning"})
	}
	append(store.AgentSessionEvent{At: at(14 * time.Minute), Label: store.ProcessLabelUpdatedPlan, Detail: "- [x] scaffold\n- [ ] run the checks"})
	append(store.AgentSessionEvent{At: at(15 * time.Minute), Label: store.ProcessLabelBackgroundTasksSync,
		Metadata: &store.AgentSessionEventMetadata{BackgroundTaskSnapshot: &[]store.AgentBackgroundTask{{
			ID: "task-1", Kind: "bash", Description: "watch the queue", Status: "running"}}}})
	append(store.AgentSessionEvent{At: at(16 * time.Minute), Label: store.ProcessLabelPermissionDenied, Detail: "write refused by the sandbox", Level: "error"})
	return session
}

func TestGetSessionCarriesPullableProgress(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	token, err := db.MintAgentSessionToken(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	session := seedProgressSession(t, db, "ws_lineage", "agent_lineage")
	call := mcpToolCaller(t, NewServer(db).Routes(), token)

	text, isError := call("get_session", map[string]any{"sessionId": session.ID})
	if isError {
		t.Fatalf("get_session = %s", text)
	}
	var digest sessionDigest
	if err := json.Unmarshal([]byte(text), &digest); err != nil {
		t.Fatalf("%v\n%s", err, text)
	}
	progress := digest.Progress
	if progress == nil {
		t.Fatalf("no progress in %s", text)
	}
	if progress.Status != "running" || progress.LastEvent != store.ProcessLabelPermissionDenied ||
		progress.LastError != "write refused by the sandbox" || progress.PlanStep != "run the checks" {
		t.Fatalf("progress = %+v", progress)
	}
	if len(progress.BackgroundTasks) != 1 || progress.BackgroundTasks[0].ID != "task-1" {
		t.Fatalf("background tasks = %+v", progress.BackgroundTasks)
	}
	if progress.Flags == nil {
		t.Fatalf("no flags in %s", text)
	}
	if !strings.Contains(progress.Flags.RepeatedFailure, "failed 3 times") {
		t.Fatalf("repeated failure = %q", progress.Flags.RepeatedFailure)
	}
	if !strings.Contains(progress.Flags.RateLimitStorm, "5 rate-limit waits") {
		t.Fatalf("rate-limit storm = %q", progress.Flags.RateLimitStorm)
	}
	if progress.Flags.Quiet != "" {
		t.Fatalf("quiet during an active turn = %q", progress.Flags.Quiet)
	}
	if progress.Flags.Budget != "" {
		t.Fatalf("budget without an execution budget = %q", progress.Flags.Budget)
	}
}

func TestReadProgressPagesToolCalls(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	token, err := db.MintAgentSessionToken(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	session := seedProgressSession(t, db, "ws_lineage", "agent_lineage")
	call := mcpToolCaller(t, NewServer(db).Routes(), token)

	type page struct {
		SessionID string `json:"sessionId"`
		Progress  struct {
			Status    string `json:"status"`
			LastEvent string `json:"lastEvent"`
			Flags     struct {
				RepeatedFailure string `json:"repeatedFailure"`
			} `json:"flags"`
		} `json:"progress"`
		ToolCalls []struct {
			Tool       string `json:"tool"`
			Detail     string `json:"detail"`
			Status     string `json:"status"`
			DurationMs *int64 `json:"durationMs"`
		} `json:"toolCalls"`
		TotalToolCalls int    `json:"totalToolCalls"`
		Earlier        string `json:"earlier"`
		Later          string `json:"later"`
	}
	read := func(args map[string]any) page {
		t.Helper()
		args["sessionId"] = session.ID
		args["scope"] = "progress"
		text, isError := call("read_context", args)
		if isError {
			t.Fatalf("read_context progress = %s", text)
		}
		var value page
		if err := json.Unmarshal([]byte(text), &value); err != nil {
			t.Fatalf("%v\n%s", err, text)
		}
		return value
	}
	newest := read(map[string]any{"limit": 2})
	if newest.TotalToolCalls != 4 || len(newest.ToolCalls) != 2 || newest.Earlier != "offset=0 limit=2" || newest.Later != "" {
		t.Fatalf("newest page = %+v", newest)
	}
	if newest.ToolCalls[0].Status != "failed" || newest.ToolCalls[0].DurationMs == nil || *newest.ToolCalls[0].DurationMs != 60_000 {
		t.Fatalf("a failed call = %+v", newest.ToolCalls[0])
	}
	if newest.Progress.Status != "running" || newest.Progress.LastEvent != store.ProcessLabelPermissionDenied ||
		!strings.Contains(newest.Progress.Flags.RepeatedFailure, "Bash") {
		t.Fatalf("page progress = %+v", newest.Progress)
	}
	first := read(map[string]any{"limit": 2, "offset": 0})
	if len(first.ToolCalls) != 2 || first.ToolCalls[0].Tool != "Bash" || first.ToolCalls[0].Status != "completed" ||
		first.Earlier != "" || first.Later != "offset=2" {
		t.Fatalf("first page = %+v", first)
	}
}

func TestListSessionsCarriesCheapProgress(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	token, err := db.MintAgentSessionToken(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	session := seedProgressSession(t, db, "ws_lineage", "agent_lineage")
	call := mcpToolCaller(t, NewServer(db).Routes(), token)

	text, isError := call("list_sessions", map[string]any{})
	if isError {
		t.Fatalf("list_sessions = %s", text)
	}
	var page struct {
		Sessions []struct {
			ID       string `json:"id"`
			Progress *struct {
				LastEvent   string `json:"lastEvent"`
				LastEventAt string `json:"lastEventAt"`
				Flags       *struct {
					RateLimitStorm string `json:"rateLimitStorm"`
				} `json:"flags"`
			} `json:"progress"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal([]byte(text), &page); err != nil {
		t.Fatalf("%v\n%s", err, text)
	}
	for _, item := range page.Sessions {
		if item.ID != session.ID {
			continue
		}
		if item.Progress == nil || item.Progress.LastEvent != store.ProcessLabelPermissionDenied ||
			item.Progress.LastEventAt == "" || item.Progress.Flags == nil ||
			!strings.Contains(item.Progress.Flags.RateLimitStorm, "5 rate-limit waits") {
			t.Fatalf("list progress = %+v", item.Progress)
		}
		return
	}
	t.Fatalf("session %s not listed:\n%s", session.ID, text)
}
