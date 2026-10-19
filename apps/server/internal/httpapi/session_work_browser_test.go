package httpapi

import (
	"context"
	"encoding/json"
	"github.com/foundry-dev/foundry/apps/server/internal/sessionwork"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Opt-in interactive fixture uses an isolated DB and the real HTTP/UI stack.
// It never starts a worker, touches live data, or runs any model or service.
func TestSessionWorkBrowserFixture(t *testing.T) {
	dir := os.Getenv("DEV022_BROWSER_DIR")
	if dir == "" {
		t.Skip("interactive browser fixture")
	}
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "codex")
	makeSession := func(title, parent string) store.AgentSession {
		s, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "codex", Title: title, Prompt: title, ParentSessionID: parent, Source: "chat"})
		if err != nil {
			t.Fatal(err)
		}
		s, err = backing.CompleteAgentSession(ctx, s.ID, "Synthetic acceptance fixture: schedules, native work and linked services.", "native_"+s.ID)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	root := makeSession("DEV022 — Native work acceptance", "")
	ended := makeSession("DEV025 — Ended work", "")
	for i := 0; i < 6; i++ {
		makeSession("Completed child session", ended.ID)
	}
	empty := makeSession("DEV025 — No work", "")
	child, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "codex", Title: "DEV022 直接子会话 · Native work acceptance with a long English and 中文标题", Prompt: "Synthetic running child; no worker is connected.", ParentSessionID: root.ID, Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = backing.StartAgentSession(ctx, child.ID)
	if err != nil {
		t.Fatal(err)
	}
	makeSession("DEV022 hidden grandchild", child.ID)
	makeSession("推进 DEV-006/007 隔离与草稿完整性验证 — 已完成的直接子会话", root.ID)
	consumer := makeSession("DEV022 linked service consumer", "")
	now := time.Now().UTC().Format(time.RFC3339Nano)
	add := func(kind, source, id, title, status string, native bool) store.SessionWork {
		w := sessionwork.Base(root, kind, source, id, title)
		w.CreatedAt = now
		w.Observation = store.WorkObservation{Status: status, At: now, ConfirmedRevision: 1}
		if kind == "schedule" {
			w.Spec = store.WorkSpec{Schedule: "0 9 * * *", Recurring: true, Prompt: "Synthetic durable wake-up"}
			w.AllowedActions = []string{"pause", "resume", "stop", "run"}
		}
		if native {
			w.Native = &store.NativeWorkInfo{Runtime: source, Version: "0.163.0", SessionID: root.NativeSessionID, TaskID: id, Discovery: "synthetic acceptance fixture", Observation: "available", Controls: map[string]string{"stop": "unavailable", "pause": "unsupported", "resume": "unsupported"}}
			if source == "claude" {
				w.Native.Version = "2.1.295"
			}
			if kind == "schedule" {
				w.Native.LastRun = &store.NativeWorkRun{ID: id + "@" + now, StartedAt: now, Status: status}
			}
			w.Management = "observed"
			w.AllowedActions = []string{}
		}
		if status == "completed" {
			w.Observation.EndedAt = now
		}
		w, err := backing.SaveSessionWork(ctx, w)
		if err != nil {
			t.Fatal(err)
		}
		backing.ObserveSessionWork(ctx, w.ID, store.WorkObservation{Status: status, At: now, ConfirmedRevision: w.Revision, EndedAt: w.Observation.EndedAt})
		return w
	}
	add("schedule", "foundry", "timer", "Durable wake-up with a deliberately long title to verify narrow panel wrapping and keyboard access", "idle", false)
	add("schedule", "claude", "native-cron", "Claude native schedule — observe only", "running", true)
	add("agent", "codex", "native-agent", "Codex native subagent — no lifecycle menu", "running", true)
	add("agent", "claude", "claude-agent", "Claude native subagent", "running", true)
	add("process", "codex", "unknown-process", "Disconnected native terminal", "unknown", true)
	add("process", "codex", "ended-process", "Completed native terminal", "completed", true)
	add("process", "claude", "failed-process", "原生后台任务失败 · Error details stay available", "failed", true)
	paused := add("schedule", "foundry", "paused-timer", "Paused durable schedule — 暂停与运行状态区分", "idle", false)
	if _, err := backing.ControlSessionWork(ctx, root.ID, root.ID, store.WorkControlInput{ID: paused.ID, Action: "pause", ExpectedRevision: paused.Revision, IdempotencyKey: "pause-visual-fixture"}); err != nil {
		t.Fatal(err)
	}
	if err := backing.ObserveSessionWork(ctx, paused.ID, store.WorkObservation{Status: "idle", At: now, ConfirmedRevision: paused.Revision + 1}); err != nil {
		t.Fatal(err)
	}
	service := add("process", "foundry", "shared-service", "Shared durable service with one execution", "running", false)
	_, err = backing.ControlSessionWork(ctx, root.ID, root.ID, store.WorkControlInput{ID: service.ID, Action: "link", RelatedSessionID: consumer.ID, ExpectedRevision: service.Revision, IdempotencyKey: "link"})
	if err != nil {
		t.Fatal(err)
	}
	backing.SaveWorkCoverage(ctx, root.DeviceID, map[string]string{"hostSchedules": "observed", "processes": "managed_native_and_attributed", "observedAt": now, "sweepRevision": "0"})
	server := withTestOwner(NewServerWithOptions(backing, ServerOptions{WebDistDir: filepath.Join(dir, "web")}))
	live := httptest.NewUnstartedServer(nil)
	server.options.AllowedOrigin = "http://" + live.Listener.Addr().String()
	live.Config.Handler = server.Routes()
	live.Start()
	defer live.Close()
	data, _ := json.Marshal(map[string]string{"url": live.URL, "root": root.ID, "ended": ended.ID, "empty": empty.ID, "child": child.ID, "consumer": consumer.ID, "workspace": "ws_queue", "service": service.ID})
	if err = os.WriteFile(filepath.Join(dir, "browser-fixture.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Minute)
	for time.Now().Before(deadline) {
		_ = backing.SaveWorkCoverage(ctx, root.DeviceID, map[string]string{"hostSchedules": "observed", "processes": "managed_native_and_attributed", "observedAt": time.Now().UTC().Format(time.RFC3339Nano), "sweepRevision": "0"})
		if _, err = os.Stat(filepath.Join(dir, "browser-done")); err == nil {
			return
		}
		time.Sleep(time.Second)
	}
	t.Fatal("browser acceptance fixture timed out")
}
