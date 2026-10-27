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

func TestArchiveNativeReconcilesOnConnectAndOldWorkerUnsupported(t *testing.T) {
	for _, capable := range []bool{false, true} {
		t.Run(map[bool]string{true: "capable", false: "old"}[capable], func(t *testing.T) {
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
			live := httptest.NewServer(server.Routes())
			defer live.Close()
			conn, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(live.URL, "http")+"/api/daemon/ws", nil)
			if e != nil {
				t.Fatal(e)
			}
			defer conn.Close()
			capabilities := []string{}
			if capable {
				capabilities = append(capabilities, nativeArchiveCapability)
			}
			writeWSForTest(t, conn, "hello", map[string]any{"capabilities": capabilities, "activeSessionIds": []string{}, "device": map[string]any{"id": "dev_queue", "label": "Queue Device", "status": "connected"}, "workspace": map[string]any{"id": "ws_queue", "name": "Queue", "localPath": t.TempDir()}, "agents": []any{}, "providerHealth": []any{}})
			if capable {
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
			}
			deadline := time.Now().Add(5 * time.Second)
			want := "unsupported"
			if capable {
				want = "archived"
			}
			for {
				targets, _ := st.NativeArchiveTargets(ctx, "dev_queue")
				if len(targets) == 1 && targets[0].State == want {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("native reconcile=%+v want %s", targets, want)
				}
				time.Sleep(10 * time.Millisecond)
			}
		})
	}
}
