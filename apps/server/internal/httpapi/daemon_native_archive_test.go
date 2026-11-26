package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

func TestArchiveNativeReconcilesOnConnect(t *testing.T) {
	ctx := context.Background()
	db := newEmptyTestStore(t)
	registerQueueDevice(t, db, "claude")
	v, e := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Provider: "claude", Prompt: "archive"})
	if e != nil {
		t.Fatal(e)
	}
	v, e = db.CompleteAgentSession(ctx, v.ID, "done", "native_queued")
	if e != nil {
		t.Fatal(e)
	}
	var st store.ChatArchiveStore = db
	if _, e = st.ArchiveChats(ctx, store.ArchiveChatsInput{WorkspaceID: v.WorkspaceID, ChatIDs: []string{v.ID}}, false); e != nil {
		t.Fatal(e)
	}
	server := NewServer(db)
	live := serveForTest(t, server)
	conn, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", nil)
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	writeWSForTest(t, conn, "hello", map[string]any{"capabilities": []string{}, "activeSessionIds": []string{}, "device": map[string]any{"id": "dev_queue", "label": "Queue Device", "status": "connected"}, "workspace": map[string]any{"id": "ws_queue", "name": "Queue", "localPath": t.TempDir()}, "agents": []any{}, "providerHealth": []any{}})
	for {
		var envelope wsEnvelope
		if e = conn.ReadJSON(&envelope); e != nil {
			t.Fatal(e)
		}
		if envelope.Type != wsNativeArchiveType {
			continue
		}
		var payload wsNativeArchivePayload
		if e = json.Unmarshal(envelope.Payload, &payload); e != nil {
			t.Fatal(e)
		}
		if len(payload.Items) != 1 || payload.Items[0].Desired != "archived" {
			t.Fatal(payload)
		}
		item := payload.Items[0]
		result := store.NativeArchiveTarget{Provider: item.Provider, NativeSessionID: item.NativeSessionID, DeviceID: item.DeviceID, SessionID: item.SessionID, Desired: item.Desired, Generation: item.Generation, State: "archived"}
		writeWSIDForTest(t, conn, envelope.ID, wsNativeArchiveResultType, wsNativeArchiveResultPayload{Items: []store.NativeArchiveTarget{result}})
		break
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		targets, _ := st.NativeArchiveTargets(ctx, "dev_queue")
		if len(targets) == 1 && targets[0].State == "archived" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("native reconcile=%+v want archived", targets)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestAntigravityChatRetainsNativeHistory(t *testing.T) {
	ctx := context.Background()
	db := newEmptyTestStore(t)
	registration := store.DaemonRegistration{
		Device: store.DeviceProjection{ID: "dev_queue", Label: "Device", Status: "connected"}, Workspace: store.WorkspaceProjection{ID: "ws_queue", Name: "Chat", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{
			{ID: "agent_queue", WorkspaceID: "ws_queue", DeviceID: "dev_queue", Provider: "antigravity", ProfileID: "login_a"},
			{ID: "agent_other", WorkspaceID: "ws_queue", DeviceID: "dev_queue", Provider: "antigravity", ProfileID: "login_b"},
		},
	}
	if err := db.RegisterDaemon(ctx, registration); err != nil {
		t.Fatal(err)
	}
	input := store.CreateAgentSessionInput{WorkspaceID: "ws_queue", AgentID: "agent_queue", Prompt: "first"}
	session, err := db.CreateAgentSession(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	session, err = db.CompleteAgentSession(ctx, session.ID, "answer", "agy-native")
	if err != nil {
		t.Fatal(err)
	}
	input.ForkSessionID = session.ID
	if _, err = db.CreateAgentSession(ctx, input); !errors.Is(err, store.ErrSubscriptionHistory) {
		t.Fatalf("fork got %v", err)
	}
	if _, err = db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: "scheduled", InputSource: &store.AgentSessionInputSource{Kind: "scheduled"}}); !errors.Is(err, store.ErrSubscriptionChat) {
		t.Fatalf("scheduled turn got %v", err)
	}
	if _, err = db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: "switch", ProfileID: "login_b"}); !errors.Is(err, store.ErrSubscriptionHistory) {
		t.Fatalf("changed subscription home: %v", err)
	}
	next, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: "next"})
	if err != nil || next.NativeSessionID != "agy-native" || next.Input.ImportedContext != "" {
		t.Fatalf("resume got %+v, %v", next, err)
	}
	if _, err = db.CompleteAgentSession(ctx, session.ID, "answer", "agy-native"); err != nil {
		t.Fatal(err)
	}
	ids := []string{session.ID}
	if preview, err := db.NativeArchivePreview(ctx, session.WorkspaceID, ids); err != nil || len(preview) != 0 {
		t.Fatalf("archive preview %v %v", preview, err)
	}
	if _, err := db.ArchiveChats(ctx, store.ArchiveChatsInput{WorkspaceID: session.WorkspaceID, ChatIDs: ids}, false); err != nil {
		t.Fatal(err)
	}
	if targets, err := db.NativeArchiveTargets(ctx, session.DeviceID); err != nil || len(targets) != 0 {
		t.Fatalf("archive targets %v %v", targets, err)
	}
}
