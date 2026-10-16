package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// deviceWaitNotices are the session's notices that it waits for its
// offline device.
func deviceWaitNotices(t *testing.T, backing store.Store, sessionID string) []store.AgentSessionEvent {
	t.Helper()
	full, err := backing.GetAgentSession(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	found := []store.AgentSessionEvent{}
	for _, event := range full.Events {
		if strings.HasSuffix(event.ID, "_waiting_for_device_online") {
			found = append(found, event)
		}
	}
	return found
}

// Work sent to an offline device is accepted and waits, saying so; when
// the device connects, it starts in the order it was sent: a follow-up
// queued between two new chats starts between them, though its session is
// the oldest.
func TestWorkForAnOfflineDeviceWaitsAndStartsInOrder(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	earlier, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "an earlier chat", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := backing.StartAgentSession(ctx, earlier.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := backing.CompleteAgentSession(ctx, earlier.ID, "done", "native_earlier"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	start := func(prompt string) store.AgentSession {
		t.Helper()
		session, err := server.startAgentSession(ctx, store.CreateAgentSessionInput{
			WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: prompt, Source: "chat",
		})
		if err != nil || session.Status != "queued" {
			t.Fatalf("new chat for the offline device: %s %v", session.Status, err)
		}
		return session
	}

	first := start("first")
	time.Sleep(5 * time.Millisecond)
	followUp, err := server.sendSessionMessage(ctx, earlier.ID, store.SendAgentSessionInput{Prompt: "second"})
	if err != nil || followUp.Status != "queued" {
		t.Fatalf("follow-up for the offline device: %s %v", followUp.Status, err)
	}
	time.Sleep(5 * time.Millisecond)
	third := start("third")

	notices := deviceWaitNotices(t, backing, first.ID)
	if len(notices) != 1 || notices[0].Label != waitingForDeviceLabel || notices[0].Level != "warning" ||
		notices[0].Detail != "Queue Device is offline. This waits and starts by itself when it is back online; it fails if it stays offline for 24 h." {
		t.Fatalf("notices = %+v", notices)
	}
	if got := deviceWaitNotices(t, backing, earlier.ID); len(got) != 1 || !strings.Contains(got[0].ID, followUp.Input.ID) {
		t.Fatalf("follow-up notices = %+v", got)
	}
	if note := server.deviceWaitNote(ctx, first); !strings.Contains(note, "starts by itself") || !strings.Contains(note, "do not send it again") {
		t.Fatalf("note for the agent = %q", note)
	}

	daemon := connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", "claude", []string{})
	runs := daemon.waitForRuns(3)
	order := []string{runs[0].Input.Prompt, runs[1].Input.Prompt, runs[2].Input.Prompt}
	if order[0] != "first" || order[1] != "second" || order[2] != "third" {
		t.Fatalf("started in order %v", order)
	}
	if runs[0].ID != first.ID || runs[1].ID != earlier.ID || runs[2].ID != third.ID {
		t.Fatalf("started %s %s %s", runs[0].ID, runs[1].ID, runs[2].ID)
	}
	time.Sleep(100 * time.Millisecond)
	if len(daemon.dispatched()) != 3 {
		t.Fatalf("each waiting input is sent once: %d runs", len(daemon.dispatched()))
	}
}

// Work that waits longer than offlineWaitLimit fails with the reason;
// until then, and once its device is back, it waits.
func TestWorkWaitingTooLongForItsDeviceFails(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	server := NewServer(backing)
	session, err := server.startAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "hello", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.expireDeviceWaits(ctx, time.Now().Add(offlineWaitLimit-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if current, _ := backing.GetAgentSessionSummary(ctx, session.ID); current.Status != "queued" {
		t.Fatalf("expired early: %s", current.Status)
	}
	if err := server.expireDeviceWaits(ctx, time.Now().Add(offlineWaitLimit+time.Minute)); err != nil {
		t.Fatal(err)
	}
	current, err := backing.GetAgentSessionSummary(ctx, session.ID)
	if err != nil || current.Status != "failed" ||
		current.Error != "Queue Device stayed offline for 24 h, so this was not started. Send it again once Queue Device is back online." {
		t.Fatalf("after the limit: %s %q %v", current.Status, current.Error, err)
	}
}

// Waiting work is canceled on the server alone, and is not sent when its
// device comes back.
func TestCancelWorkWaitingForItsDevice(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	server := NewServer(backing)
	live := httptest.NewServer(server.Routes())
	defer live.Close()
	session, err := server.startAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "never mind", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	canceled, err := server.cancelSession(ctx, Actor{Kind: ActorAccount}, session.ID)
	if err != nil || canceled.Status != "canceled" {
		t.Fatalf("cancel waiting work: %s %v", canceled.Status, err)
	}
	daemon := connectQueueDaemon(t, live.URL, "dev_queue", "ws_queue", "claude", []string{})
	time.Sleep(200 * time.Millisecond)
	if runs := daemon.dispatched(); len(runs) != 0 {
		t.Fatalf("canceled work was sent: %+v", runs)
	}
}

// The assistant's helpers take the same path: create_session and
// send_message for a project on an offline computer answer the queued
// session and say plainly that it starts when the computer is back,
// without waiting on it even when asked to.
func TestAssistantHelperForAnOfflineComputerWaits(t *testing.T) {
	f := newAssistantFixture(t)
	text, failed := f.tool(t, f.token, "create_session", map[string]any{"workspaceId": "ws_alice", "prompt": "tidy the photos", "wait": true, "timeoutMs": 60_000})
	if failed {
		t.Fatalf("create_session on an offline computer: %s", text)
	}
	var created struct {
		ID               string `json:"id"`
		Status           string `json:"status"`
		WaitingForDevice string `json:"waitingForDevice"`
	}
	if err := json.Unmarshal([]byte(text), &created); err != nil {
		t.Fatalf("decode %s: %v", text, err)
	}
	if created.Status != "queued" || !strings.Contains(created.WaitingForDevice, "starts by itself") {
		t.Fatalf("created = %+v", created)
	}
	tasks, err := f.server.store.ListPersonalAgentTasks(context.Background(), f.aliceID, nil)
	if err != nil || len(tasks) != 1 || tasks[0].SessionID != created.ID || tasks[0].Status != store.PersonalAgentTaskRunning {
		t.Fatalf("tasks = %+v %v", tasks, err)
	}
	// What it is doing says the task waits for that computer.
	text, failed = f.tool(t, f.token, "list_tasks", map[string]any{})
	var listed []store.PersonalAgentTask
	if failed || json.Unmarshal([]byte(text), &listed) != nil || len(listed) != 1 || listed[0].WaitingFor == "" {
		t.Fatalf("list_tasks while the computer is offline: %s", text)
	}
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/personal-agent/tasks", ""))
	if recorder.Code != http.StatusOK || json.Unmarshal(recorder.Body.Bytes(), &listed) != nil || len(listed) != 1 || listed[0].WaitingFor == "" {
		t.Fatalf("GET tasks while the computer is offline: %d %s", recorder.Code, recorder.Body.String())
	}

	if _, err := f.server.cancelSession(context.Background(), Actor{Kind: ActorAccount}, created.ID); err != nil {
		t.Fatal(err)
	}
	text, failed = f.tool(t, f.token, "send_message", map[string]any{"sessionId": created.ID, "prompt": "tidy them after all", "wait": true})
	var sent struct {
		Status           string `json:"status"`
		WaitingForDevice string `json:"waitingForDevice"`
	}
	if failed || json.Unmarshal([]byte(text), &sent) != nil || sent.Status != "queued" || !strings.Contains(sent.WaitingForDevice, "starts by itself") {
		t.Fatalf("send_message on an offline computer: %s", text)
	}
}
