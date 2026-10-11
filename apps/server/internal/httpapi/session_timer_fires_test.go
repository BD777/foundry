package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// timerSnapshotEvent is what a device reports when its agent's timers change.
func timerSnapshotEvent(sessionID, id string, tasks []store.AgentScheduledTask) store.AgentSessionEvent {
	return store.AgentSessionEvent{
		ID: id, SessionID: sessionID, Label: "Scheduled tasks updated", Level: "info",
		Metadata: &store.AgentSessionEventMetadata{TimerSnapshot: &tasks},
	}
}

var inspectionTimer = store.AgentScheduledTask{
	ID: "9b17c9d2", Kind: "cron", Schedule: "28,58 * * * *", HumanSchedule: "每 30 分钟", Recurring: true,
	Prompt: "巡检 20 台容器", NextFireAt: "2026-10-11T02:37:05Z",
}

// A device whose session no process runs sends a due timer: the server makes
// its prompt the session's next input, once per fire time, marked as the
// timer firing, and refuses a session that is busy, deleted, or no longer
// runs that native session.
func TestDaemonTimerFireResumesTheSessionOnce(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "inspect every 30 minutes", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := backing.AppendAgentSessionEvent(ctx, timerSnapshotEvent(session.ID, "evt_timers_1", []store.AgentScheduledTask{inspectionTimer})); err != nil {
		t.Fatal(err)
	}
	if _, err := backing.CompleteAgentSession(ctx, session.ID, "scheduled", "native_inspect"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	daemon := connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", "claude", []string{})
	client := queueClient{t: t, server: server, url: live.URL}
	path := "/api/daemon/sessions/" + session.ID + "/timer-fires"
	fireAt := func(dueAt, nativeSessionID string) string {
		return `{"timerId":"9b17c9d2","prompt":"巡检 20 台容器","dueAt":"` + dueAt + `","nativeSessionId":"` + nativeSessionID + `"}`
	}
	fire := fireAt("2026-10-11T02:37:05.248Z", "native_inspect")

	status, raw := client.call(http.MethodPost, path, fire, "")
	if status != http.StatusAccepted {
		t.Fatalf("timer fire = %d %s", status, raw)
	}
	runs := daemon.waitForRuns(1)
	input := runs[0].Input
	if input.Prompt != "巡检 20 台容器" || input.TimerFire == nil || input.TimerFire.ID != "9b17c9d2" || input.TimerFire.Origin != "scheduled" {
		t.Fatalf("dispatched input = %+v", input)
	}
	if runs[0].NativeSessionID != "native_inspect" {
		t.Fatalf("the input resumes %q, want the timers' native session", runs[0].NativeSessionID)
	}
	// A timer may fire long after the session last used its tools: the
	// turn it starts carries a token of its own.
	daemon.mu.Lock()
	timerToken := daemon.tokens[0]
	daemon.mu.Unlock()
	if identity, err := backing.ResolveSessionToken(ctx, timerToken); err != nil || identity.SessionID != session.ID {
		t.Fatalf("the timer turn's token = %+v, %v; want a fresh token of the session", identity, err)
	}
	recorded, err := backing.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	var inputEvent *store.AgentSessionEvent
	for index := range recorded.Events {
		if recorded.Events[index].ID == "evt_"+input.ID {
			inputEvent = &recorded.Events[index]
		}
	}
	if inputEvent == nil || inputEvent.Metadata == nil || inputEvent.Metadata.TimerFire == nil || inputEvent.Metadata.TimerFire.ID != "9b17c9d2" {
		t.Fatalf("the input's transcript event does not show the timer firing: %+v", inputEvent)
	}

	// While its turn runs the device holds the timers; a late copy waits.
	if status, raw := client.call(http.MethodPost, path, fire, ""); status != http.StatusConflict {
		t.Fatalf("fire during the turn = %d %s, want 409", status, raw)
	}
	daemon.complete(runs[0], "20 containers checked")
	var resumed store.AgentSession
	waitFor(t, "the timer turn completes", func() bool {
		resumed, err = backing.GetAgentSessionSummary(ctx, session.ID)
		return err == nil && resumed.Status == "completed"
	})
	if status, raw := client.call(http.MethodPost, path, fireAt("2026-10-11T02:37:05.248Z", resumed.NativeSessionID), ""); status != http.StatusOK {
		t.Fatalf("the same fire time again = %d %s, want 200 (already sent)", status, raw)
	}
	if runs := daemon.dispatched(); len(runs) != 1 {
		t.Fatalf("dispatched %d inputs for one fire time", len(runs))
	}

	if status, raw := client.call(http.MethodPost, path, fireAt("2026-10-11T03:07:05Z", "native_older"), ""); status != http.StatusGone {
		t.Fatalf("fire for another native session = %d %s, want 410", status, raw)
	}
	if current, _ := backing.GetAgentSessionSummary(ctx, session.ID); current.Scheduled != nil {
		t.Fatalf("a session whose timers are gone still shows them: %+v", current.Scheduled)
	}
	if status, _ := client.call(http.MethodPost, "/api/daemon/sessions/sess_missing/timer-fires", fire, ""); status != http.StatusNotFound {
		t.Fatalf("fire for an unknown session = %d, want 404", status)
	}

	// Claude fires a timer itself while its process lives: the device asks
	// for a token for the turn, the session settled or not.
	status, raw = client.call(http.MethodPost, "/api/daemon/sessions/"+session.ID+"/session-tokens", "", "")
	var minted struct {
		SessionToken string `json:"sessionToken"`
	}
	if status != http.StatusOK || json.Unmarshal(raw, &minted) != nil || minted.SessionToken == "" {
		t.Fatalf("session token for a timer turn = %d %s", status, raw)
	}
	if identity, err := backing.ResolveSessionToken(ctx, minted.SessionToken); err != nil || identity.SessionID != session.ID {
		t.Fatalf("minted token = %+v, %v", identity, err)
	}
	if status, _ := client.call(http.MethodPost, "/api/daemon/sessions/sess_missing/session-tokens", "", ""); status != http.StatusNotFound {
		t.Fatalf("token for an unknown session = %d, want 404", status)
	}
}
