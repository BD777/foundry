package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

// A device that says hello is sent the timers its sessions hold, prompts
// included, so a worker that never saw them reported (an older worker ran
// the session) keeps and fires them; a session whose timers were deleted
// sends none.
func TestDeviceHelloSendsItsSessionsTimers(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	registerQueueDevice(t, backing, "claude")
	create := func(prompt string) store.AgentSession {
		t.Helper()
		session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: prompt, Source: "chat",
		})
		if err != nil {
			t.Fatal(err)
		}
		return session
	}
	scheduled := create("inspect every 30 minutes")
	if err := backing.AppendAgentSessionEvent(ctx, timerSnapshotEvent(scheduled.ID, "evt_timers_1", []store.AgentScheduledTask{inspectionTimer})); err != nil {
		t.Fatal(err)
	}
	if _, err := backing.CompleteAgentSession(ctx, scheduled.ID, "scheduled", "native_inspect"); err != nil {
		t.Fatal(err)
	}
	stopped := create("inspect, then stop")
	if err := backing.AppendAgentSessionEvent(ctx, timerSnapshotEvent(stopped.ID, "evt_stop_1", []store.AgentScheduledTask{inspectionTimer})); err != nil {
		t.Fatal(err)
	}
	if err := backing.AppendAgentSessionEvent(ctx, timerSnapshotEvent(stopped.ID, "evt_stop_2", []store.AgentScheduledTask{})); err != nil {
		t.Fatal(err)
	}
	if _, err := backing.CompleteAgentSession(ctx, stopped.ID, "stopped", "native_stopped"); err != nil {
		t.Fatal(err)
	}

	live := httptest.NewServer(NewServer(backing).Routes())
	defer live.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	writeWSForTest(t, conn, "hello", map[string]any{
		"activeSessionIds": []string{},
		"device":           map[string]any{"id": "dev_queue", "label": "Queue Device", "status": "connected", "lastSeenLabel": "online"},
		"workspace":        map[string]any{"id": "ws_queue", "name": "Queue", "localPath": t.TempDir(), "baseline": "main"},
		"providerHealth":   []map[string]any{},
		"assets":           []map[string]any{},
		"agents": []map[string]any{{
			"id": "agent_queue", "workspaceId": "ws_queue", "deviceId": "dev_queue", "deviceLabel": "Queue Device",
			"provider": "claude", "status": "healthy", "authMode": "local_config", "secretStored": "local",
			"configScope": "workspace", "configLabel": "device local login", "lastSeenLabel": "online",
		}},
	})
	var sent []store.SessionTimers
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(deadline)
		var envelope struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := conn.ReadJSON(&envelope); err != nil {
			break
		}
		if envelope.Type != wsSessionTimersType {
			continue
		}
		var timers store.SessionTimers
		if err := json.Unmarshal(envelope.Payload, &timers); err != nil {
			t.Fatal(err)
		}
		sent = append(sent, timers)
	}
	if len(sent) != 1 || sent[0].SessionID != scheduled.ID || sent[0].NativeSessionID != "native_inspect" ||
		len(sent[0].Timers) != 1 || sent[0].Timers[0].ID != inspectionTimer.ID || sent[0].Timers[0].Prompt != inspectionTimer.Prompt ||
		sent[0].Timers[0].FirstSeenAt == "" {
		t.Fatalf("session timers sent on hello = %+v", sent)
	}
}
