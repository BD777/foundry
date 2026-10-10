package httpapi

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// "Subtask running" reports empty the cached list at most once per
// subagentProgressInterval; a subagent starting, finishing or failing
// empties it at once.
func TestSubagentProgressIsCoalescedAndLifecycleIsNot(t *testing.T) {
	cache := newSubagentListCache()
	var reads atomic.Int32
	fetch := func(context.Context) ([]store.AgentSubagentSummary, error) {
		reads.Add(1)
		return []store.AgentSubagentSummary{{TaskID: "task_1", Status: "running"}}, nil
	}
	load := func(want int32, why string) {
		t.Helper()
		if _, err := cache.load(context.Background(), "sess_1", false, fetch); err != nil {
			t.Fatal(err)
		}
		if reads.Load() != want {
			t.Fatalf("%s: %d device reads, want %d", why, reads.Load(), want)
		}
	}
	event := func(label string) store.AgentSessionEvent {
		return store.AgentSessionEvent{SessionID: "sess_1", Label: label, Metadata: &store.AgentSessionEventMetadata{TaskID: "task_1"}}
	}
	backdate := func() {
		cache.mu.Lock()
		cache.entries["sess_1"].readAt = cache.entries["sess_1"].readAt.Add(-subagentProgressInterval)
		cache.mu.Unlock()
	}

	load(1, "first read")
	for range 20 {
		cache.observe(event("Subtask running"))
		load(1, "progress within the interval")
	}
	cache.observe(event("子任务进行中"))
	load(1, "localized progress within the interval")
	backdate()
	load(2, "progress older than the interval")
	backdate()
	load(2, "no progress since the last read")
	for _, label := range []string{"Starting subtask", "Subtask completed", "Subtask failed", "子任务完成"} {
		before := reads.Load()
		cache.observe(event(label))
		load(before+1, label)
	}
	cache.observe(store.AgentSessionEvent{SessionID: "sess_1", Label: "Subtask completed"})
	load(reads.Load(), "an event without a task")
}

type summaryCountingStore struct {
	*sqlitestore.Store
	summaries atomic.Int32
}

func (s *summaryCountingStore) GetAgentSessionSummary(ctx context.Context, id string) (store.AgentSession, error) {
	s.summaries.Add(1)
	return s.Store.GetAgentSessionSummary(ctx, id)
}

// The route's access check reads the session; the handler uses that read.
func TestSessionReadsLookUpTheSessionOnce(t *testing.T) {
	backing := newTestStore(t)
	ctx := context.Background()
	if err := backing.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_once", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_once", Name: "Once", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{{ID: "agent_once", WorkspaceID: "ws_once", DeviceID: "dev_once", Provider: "codex", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online"}},
	}); err != nil {
		t.Fatal(err)
	}
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_once", AgentID: "agent_once", Provider: "codex", Prompt: "once"})
	if err != nil {
		t.Fatal(err)
	}
	counting := &summaryCountingStore{Store: backing}
	server := NewServer(counting)
	if _, err := server.hub.subagents.load(ctx, session.ID, true, func(context.Context) ([]store.AgentSubagentSummary, error) {
		return []store.AgentSubagentSummary{{TaskID: "task_1"}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/agent-sessions/" + session.ID + "/subagents", "/api/agent-sessions/" + session.ID + "?events=none"} {
		counting.summaries.Store(0)
		requestForTest(t, server, http.MethodGet, path, "", http.StatusOK)
		if got := counting.summaries.Load(); got != 1 {
			t.Fatalf("GET %s read the session summary %d times, want 1", path, got)
		}
	}
}

// Only Claude's subagents (local_agent tasks) change the list. A background
// command's end does not name its type, so its start is remembered; a task
// the server did not see start may be a subagent.
func TestSubagentChangesFollowTaskTypes(t *testing.T) {
	cache := newSubagentListCache()
	var reads atomic.Int32
	fetch := func(context.Context) ([]store.AgentSubagentSummary, error) {
		reads.Add(1)
		return []store.AgentSubagentSummary{}, nil
	}
	event := func(label, taskID, taskType string) store.AgentSessionEvent {
		return store.AgentSessionEvent{SessionID: "sess_1", Label: label, Metadata: &store.AgentSessionEventMetadata{TaskID: taskID, TaskType: taskType}}
	}
	if _, err := cache.load(context.Background(), "sess_1", false, fetch); err != nil {
		t.Fatal(err)
	}
	for _, step := range []struct {
		event store.AgentSessionEvent
		want  subagentChange
	}{
		{event("Starting subtask", "bash_1", "local_bash"), subagentUnchanged},
		{event("Subtask completed", "bash_1", ""), subagentUnchanged},
		{event("Subtask completed", "monitor_1", "monitor"), subagentUnchanged},
	} {
		if got := cache.observe(step.event); got != step.want {
			t.Errorf("%s %s = %v, want %v", step.event.Label, step.event.Metadata.TaskID, got, step.want)
		}
	}
	if _, err := cache.load(context.Background(), "sess_1", false, fetch); err != nil {
		t.Fatal(err)
	}
	if reads.Load() != 1 {
		t.Fatalf("a background command's start and end read the list again (%d reads)", reads.Load())
	}
	for _, step := range []struct {
		event store.AgentSessionEvent
		want  subagentChange
	}{
		{event("Starting subtask", "task_1", "local_agent"), subagentStarted},
		{event("Subtask running", "task_1", ""), subagentUnchanged},
		{event("Subtask failed", "task_1", ""), subagentEnded},
		{event("Subtask completed", "task_unseen", ""), subagentTaskEnded},
		{event("Subtask completed", "task_named", "local_agent"), subagentEnded},
		{event("Starting subtask", "task_old", ""), subagentUntypedStart},
		{event("子任务完成", "task_old", ""), subagentTaskEnded},
	} {
		if got := cache.observe(step.event); got != step.want {
			t.Errorf("%s %s = %v, want %v", step.event.Label, step.event.Metadata.TaskID, got, step.want)
		}
	}
}

// A read that started before a subagent ended answers only the readers that
// joined it then: later readers get a read of their own, which the older one
// does not replace when it finishes last.
func TestSubagentReadsAfterAnEndDoNotJoinOlderReads(t *testing.T) {
	cache := newSubagentListCache()
	ctx := context.Background()
	release := make(chan struct{})
	older := make(chan []byte, 1)
	go func() {
		body, _ := cache.load(ctx, "sess_1", false, func(context.Context) ([]store.AgentSubagentSummary, error) {
			<-release
			return []store.AgentSubagentSummary{{TaskID: "task_1", Status: "running"}}, nil
		})
		older <- body
	}()
	for inFlight := false; !inFlight; {
		cache.mu.Lock()
		entry := cache.entries["sess_1"]
		inFlight = entry != nil && entry.inflight != nil
		cache.mu.Unlock()
		time.Sleep(time.Millisecond)
	}
	cache.observe(store.AgentSessionEvent{SessionID: "sess_1", Label: "Subtask completed", Metadata: &store.AgentSessionEventMetadata{TaskID: "task_1", TaskType: "local_agent"}})
	body, err := cache.load(ctx, "sess_1", false, func(context.Context) ([]store.AgentSubagentSummary, error) {
		return []store.AgentSubagentSummary{{TaskID: "task_1", Status: "completed"}}, nil
	})
	if err != nil || !strings.Contains(string(body), `"completed"`) {
		t.Fatalf("a read after the end = %s, %v; want the subagent completed", body, err)
	}
	close(release)
	if body := <-older; !strings.Contains(string(body), `"running"`) {
		t.Fatalf("the older read answered %s", body)
	}
	body, err = cache.load(ctx, "sess_1", false, func(context.Context) ([]store.AgentSubagentSummary, error) {
		t.Fatal("the list was read again")
		return nil, nil
	})
	if err != nil || !strings.Contains(string(body), `"completed"`) {
		t.Fatalf("cached after both reads: %s, %v; want the newer read", body, err)
	}
}
