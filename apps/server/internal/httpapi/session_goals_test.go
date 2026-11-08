package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestDeviceDeliversADueClaudeTimerOnceMarkedAsCatchUp(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "loop", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = backing.CompleteAgentSession(ctx, session.ID, "scheduled a wakeup", "native_loop"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := serveForTest(t, server)
	daemon := connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", "claude", []string{})
	client := queueClient{t: t, server: server, url: live.URL}
	route := "/api/daemon/sessions/" + session.ID + "/timer-fire"
	fire := `{"timerId":"cron_7","prompt":"check the build","dueAt":"2026-11-07T10:02:00Z","catchUp":true}`
	if status, raw := client.call(http.MethodPost, route, fire, ""); status != http.StatusAccepted {
		t.Fatalf("fire %d %s", status, raw)
	}
	runs := daemon.waitForRuns(1)
	got := runs[0].Input.TimerFire
	if got == nil || got.ID != "cron_7" || got.Origin != "scheduled" || !got.CatchUp || got.ScheduledFor != "2026-11-07T10:02:00Z" || runs[0].Input.Prompt != "check the build" {
		t.Fatalf("run input = %+v, fire %+v", runs[0].Input, got)
	}
	// Running: the device asks again later.
	if status, raw := client.call(http.MethodPost, route, `{"timerId":"cron_9","prompt":"other","dueAt":"2026-11-07T10:03:00Z"}`, ""); status != http.StatusConflict {
		t.Fatalf("busy fire %d %s", status, raw)
	}
	daemon.complete(runs[0], "build is green")
	waitFor(t, "the timer's turn completes", func() bool {
		current, err := backing.GetAgentSessionSummary(ctx, session.ID)
		return err == nil && current.Status == "completed"
	})
	// The same due time again (a restarted device): nothing new.
	if status, raw := client.call(http.MethodPost, route, fire, ""); status != http.StatusOK {
		t.Fatalf("repeated fire %d %s", status, raw)
	}
	if len(daemon.dispatched()) != 1 {
		t.Fatalf("dispatched %d runs; want the due time once", len(daemon.dispatched()))
	}
	if status, raw := client.call(http.MethodPost, route, `{"timerId":"cron_7","prompt":"x","dueAt":"soon"}`, ""); status != http.StatusBadRequest {
		t.Fatalf("invalid due time %d %s", status, raw)
	}
}

func TestSessionGoalControlsFollowTheRuntime(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	claude, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "/goal all tests pass", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = backing.CompleteAgentSession(ctx, claude.ID, "working on it", "native_goal"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := serveForTest(t, server)
	daemon := connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", "claude", []string{})
	client := queueClient{t: t, server: server, url: live.URL}
	path := "/api/agent-sessions/" + claude.ID + "/goal"
	if status, raw := client.call(http.MethodPost, path, `{"action":"pause"}`, ""); status != http.StatusBadRequest {
		t.Fatalf("Claude pause %d %s", status, raw)
	}
	// Claude Code's own command, as the next message.
	if status, raw := client.call(http.MethodPost, path, `{"action":"clear"}`, ""); status != http.StatusOK {
		t.Fatalf("Claude clear %d %s", status, raw)
	}
	if runs := daemon.waitForRuns(1); runs[0].Input.Prompt != claudeGoalClear {
		t.Fatalf("clear sent %q", runs[0].Input.Prompt)
	}

}

func TestCodexGoalControlsGoToItsDevice(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "codex")
	codex, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "codex", Prompt: "ship it", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := serveForTest(t, server)
	daemon := connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", "codex", []string{})
	client := queueClient{t: t, server: server, url: live.URL}
	path := "/api/agent-sessions/" + codex.ID + "/goal"
	status, raw := client.call(http.MethodPost, path, `{"action":"pause"}`, "")
	var answer map[string]any
	_ = json.Unmarshal(raw, &answer)
	if status != http.StatusOK || answer["action"] != "pause" {
		t.Fatalf("Codex pause %d %s", status, raw)
	}
	// The device's refusal is the person's to read.
	if status, raw = client.call(http.MethodPost, path, `{"action":"resume"}`, ""); status != http.StatusConflict {
		t.Fatalf("refused resume %d %s", status, raw)
	}
	if status, raw = client.call(http.MethodPost, path, `{"action":"budget"}`, ""); status != http.StatusBadRequest {
		t.Fatalf("unknown action %d %s", status, raw)
	}
	daemon.mu.Lock()
	goals := append([]wsSessionGoalControlPayload(nil), daemon.goals...)
	daemon.mu.Unlock()
	if len(goals) != 2 || goals[0].SessionID != codex.ID || goals[0].Action != "pause" || goals[1].Action != "resume" {
		t.Fatalf("device got %+v", goals)
	}
}
