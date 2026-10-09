package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A message steered into a running session keeps its files: the daemon gets
// them in steer_session, normalized like a dispatched input's. A message of
// files alone steers too; one with neither is refused.
func TestSteerCarriesAttachmentsToTheDaemon(t *testing.T) {
	backing := newEmptyTestStore(t)
	ctx := context.Background()
	if err := backing.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_steer", Label: "Steer Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_steer", Name: "Steer", LocalPath: t.TempDir(), Baseline: "main"},
		Agents: []store.AgentProjection{{
			ID: "agent_steer_claude", WorkspaceID: "ws_steer", DeviceID: "dev_steer", DeviceLabel: "Steer Device",
			Provider: "claude", Status: "healthy", AuthMode: "local_config", SecretStored: "local",
			ConfigScope: "workspace", ConfigLabel: "device local login", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register daemon seed: %v", err)
	}
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_steer", AgentID: "agent_steer_claude", Provider: "claude",
		Prompt: "run the long task", Source: "chat",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if _, err := backing.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatalf("start session: %v", err)
	}

	testServer := httptest.NewServer(NewServer(backing).Routes())
	defer testServer.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(testServer.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	writeWSForTest(t, conn, "hello", map[string]any{
		"activeSessionIds": []string{session.ID},
		"device":           map[string]any{"id": "dev_steer", "label": "Steer Device", "status": "connected", "lastSeenLabel": "online"},
		"workspace":        map[string]any{"id": "ws_steer", "name": "Steer", "localPath": t.TempDir(), "baseline": "main"},
		"providerHealth":   []map[string]any{},
		"assets":           []map[string]any{},
	})
	readWSTypeForTest(t, conn, "registered")

	image := store.ChatAttachment{
		ID: "att_green", Name: "green.png", Path: "/ws/.foundry/attachments/green.png",
		MIMEType: "image/png", Size: 326, Kind: "image",
	}
	post := func(body string) (int, string) {
		response, err := http.Post(testServer.URL+"/api/agent-sessions/"+session.ID+"/messages", "application/json", strings.NewReader(body))
		if err != nil {
			return -1, err.Error()
		}
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(raw)
	}
	// steer posts a message and plays the daemon: it acknowledges the
	// steer_session it receives and returns what that carried.
	steer := func(body string) wsSteerSessionPayload {
		t.Helper()
		type reply struct {
			status int
			body   string
		}
		replies := make(chan reply, 1)
		go func() {
			status, body := post(body)
			replies <- reply{status, body}
		}()
		for {
			var envelope struct {
				ID      string          `json:"id"`
				Type    string          `json:"type"`
				Payload json.RawMessage `json:"payload"`
			}
			if err := conn.ReadJSON(&envelope); err != nil {
				t.Fatalf("read daemon message: %v", err)
			}
			if envelope.Type != wsSteerSessionType {
				continue
			}
			var payload wsSteerSessionPayload
			if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
				t.Fatalf("decode steer payload: %v", err)
			}
			writeWSIDForTest(t, conn, envelope.ID, wsSessionSteeredType, map[string]any{"sessionId": session.ID})
			if got := <-replies; got.status != http.StatusOK {
				t.Fatalf("steer status = %d: %s", got.status, got.body)
			}
			return payload
		}
	}

	payload := steer(`{"prompt":"What color is this image?","attachments":[` +
		`{"id":"att_green","name":"green.png","path":" /ws/.foundry/attachments/green.png ","mimeType":"image/png","size":326,"kind":"image"},` +
		`{"id":"","name":"no-id.png","path":"/ws/x.png","kind":"image"}]}`)
	if payload.SessionID != session.ID || payload.Message != "What color is this image?" {
		t.Fatalf("steer payload = %+v", payload)
	}
	if len(payload.Attachments) != 1 || payload.Attachments[0] != image {
		t.Fatalf("steered attachments = %+v, want only %+v", payload.Attachments, image)
	}

	payload = steer(`{"prompt":"","attachments":[{"id":"att_green","name":"green.png","path":"/ws/.foundry/attachments/green.png","mimeType":"image/png","size":326,"kind":"image"}]}`)
	if payload.Message != "" || len(payload.Attachments) != 1 || payload.Attachments[0] != image {
		t.Fatalf("files-only steer payload = %+v", payload)
	}

	if status, body := post(`{"prompt":"  "}`); status != http.StatusBadRequest {
		t.Fatalf("empty steer status = %d, want 400: %s", status, body)
	}
}
