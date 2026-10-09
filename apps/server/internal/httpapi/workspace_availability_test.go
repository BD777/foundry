package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

const unservedMessage = "CanWendeMac-mini no longer serves this folder; add it again from the Workspaces page"

// registerMacWorkspaces records two workspaces of one device, as an earlier
// worker registered them; ws_mac_b also has an agent to queue a session on.
func registerMacWorkspaces(t *testing.T, db *sqlitestore.Store) {
	t.Helper()
	for _, id := range []string{"ws_mac_a", "ws_mac_b"} {
		if err := db.RegisterDaemon(context.Background(), store.DaemonRegistration{
			Device:    store.DeviceProjection{ID: "dev_mac", Label: "CanWendeMac-mini", Status: "connected", LastSeenLabel: "online"},
			Workspace: store.WorkspaceProjection{ID: id, Name: id, LocalPath: "/Volumes/work/" + id},
			Agents: []store.AgentProjection{{
				ID: "agent_" + id, WorkspaceID: id, DeviceID: "dev_mac", Provider: "claude", Status: "healthy",
				AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
			}},
		}); err != nil {
			t.Fatal(err)
		}
	}
}

func dialDaemonForTest(t *testing.T, httpServer *httptest.Server) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/api/daemon/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func macHello(capabilities []string, served []string) map[string]any {
	hello := map[string]any{
		"capabilities":     capabilities,
		"activeSessionIds": []string{},
		"device":           map[string]any{"id": "dev_mac", "label": "CanWendeMac-mini", "status": "connected"},
		"workspace":        map[string]any{"id": "ws_mac_a", "name": "ws_mac_a", "localPath": "/Volumes/work/ws_mac_a"},
	}
	if served != nil {
		hello["servedWorkspaceIds"] = served
	}
	return hello
}

func workspaceAvailability(t *testing.T, db store.Store, id string) *store.WorkspaceUnavailability {
	t.Helper()
	workspace, err := db.GetWorkspace(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return workspace.UnavailableOnDevice
}

// A worker that lists what it serves takes the device's other workspaces out
// of service, without deleting them; sessions there fail with a plain reason,
// and serving the folder again brings it back.
func TestHelloMarksWorkspacesTheWorkerNoLongerServes(t *testing.T) {
	db := newTestStore(t)
	registerMacWorkspaces(t, db)
	queued, err := db.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		WorkspaceID: "ws_mac_b", AgentID: "agent_ws_mac_b", Provider: "claude", Prompt: "queued before the update",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()

	conn := dialDaemonForTest(t, httpServer)
	writeWSForTest(t, conn, "hello", macHello([]string{store.DaemonCapabilityWorkspaceInventory}, []string{"ws_mac_a"}))
	readWSTypeForTest(t, conn, "registered")

	if got := workspaceAvailability(t, db, "ws_mac_a"); got != nil {
		t.Fatalf("served workspace marked unavailable: %+v", got)
	}
	got := workspaceAvailability(t, db, "ws_mac_b")
	if got == nil || got.Reason != store.WorkspaceNotServed || got.Since == "" {
		t.Fatalf("unserved workspace availability = %+v, want not_served", got)
	}

	// The session queued there is failed with the reason, not sent.
	deadline := time.Now().Add(3 * time.Second)
	for {
		session, err := db.GetAgentSessionSummary(context.Background(), queued.ID)
		if err != nil {
			t.Fatal(err)
		}
		if session.Status == "failed" {
			full, err := db.GetAgentSession(context.Background(), queued.ID)
			if err != nil {
				t.Fatal(err)
			}
			if raw, _ := json.Marshal(full); !strings.Contains(string(raw), unservedMessage) {
				t.Fatalf("queued session failed without the reason: %s", raw)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("queued session in the unserved workspace stayed %s", session.Status)
		}
		time.Sleep(20 * time.Millisecond)
	}

	refused := postJSONForTest(t, server, "/api/agent-sessions",
		`{"workspaceId":"ws_mac_b","provider":"claude","prompt":"run here"}`, http.StatusConflict)
	if refused["error"] != unservedMessage {
		t.Fatalf("create in the unserved workspace = %v, want %q", refused, unservedMessage)
	}

	// The worker serves the folder again (the person added it again).
	writeWSForTest(t, conn, "workspace_ready", map[string]any{"registration": map[string]any{
		"capabilities": []string{store.DaemonCapabilityWorkspaceInventory},
		"device":       map[string]any{"id": "dev_mac", "label": "CanWendeMac-mini", "status": "connected"},
		"workspace":    map[string]any{"id": "ws_mac_b", "name": "ws_mac_b", "localPath": "/Volumes/work/ws_mac_b"},
	}})
	readWSTypeForTest(t, conn, "registered")
	if got := workspaceAvailability(t, db, "ws_mac_b"); got != nil {
		t.Fatalf("re-registered workspace still unavailable: %+v", got)
	}
}

// A later hello that lists the workspace again makes it available again.
func TestHelloListingAWorkspaceAgainMakesItAvailable(t *testing.T) {
	db := newTestStore(t)
	registerMacWorkspaces(t, db)
	if _, err := db.SetDeviceServedWorkspaces(context.Background(), "dev_mac", []string{"ws_mac_a"}); err != nil {
		t.Fatal(err)
	}
	if workspaceAvailability(t, db, "ws_mac_b") == nil {
		t.Fatal("setup: ws_mac_b should start unavailable")
	}
	httpServer := httptest.NewServer(NewServer(db).Routes())
	defer httpServer.Close()
	conn := dialDaemonForTest(t, httpServer)
	writeWSForTest(t, conn, "hello", macHello([]string{store.DaemonCapabilityWorkspaceInventory}, []string{"ws_mac_a", "ws_mac_b"}))
	readWSTypeForTest(t, conn, "registered")
	if got := workspaceAvailability(t, db, "ws_mac_b"); got != nil {
		t.Fatalf("listed workspace still unavailable: %+v", got)
	}
}

// An older worker never lists what it serves: its workspaces stay as they
// are, even when its hello names only one of them.
func TestOldWorkerHelloLeavesWorkspacesAvailable(t *testing.T) {
	for name, hello := range map[string]map[string]any{
		"no capability":         macHello(nil, []string{"ws_mac_a"}),
		"capability, no list":   macHello([]string{store.DaemonCapabilityWorkspaceInventory}, nil),
		"no capability no list": macHello([]string{"issue_sessions"}, nil),
	} {
		t.Run(name, func(t *testing.T) {
			db := newTestStore(t)
			registerMacWorkspaces(t, db)
			httpServer := httptest.NewServer(NewServer(db).Routes())
			defer httpServer.Close()
			conn := dialDaemonForTest(t, httpServer)
			writeWSForTest(t, conn, "hello", hello)
			readWSTypeForTest(t, conn, "registered")
			for _, id := range []string{"ws_mac_a", "ws_mac_b"} {
				if got := workspaceAvailability(t, db, id); got != nil {
					t.Fatalf("%s marked unavailable for an old worker: %+v", id, got)
				}
			}
		})
	}
}

// Agents see the state in list_workspaces, and create_session / send_message
// stop with the plain reason instead of reaching the device.
func TestMCPToolsRefuseUnservedWorkspace(t *testing.T) {
	db, parent := lineageFixture(t)
	ctx := context.Background()
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude",
		Prompt: "earlier child", Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, child.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.(store.WorkspaceAvailabilityStore).SetDeviceServedWorkspaces(ctx, "dev_lineage", []string{}); err != nil {
		t.Fatal(err)
	}
	token, err := db.MintAgentSessionToken(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	call := func(tool, arguments string) (string, bool) {
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + tool + `","arguments":` + arguments + `}}`
		request := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, request)
		var envelope struct {
			Result struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
				IsError bool `json:"isError"`
			} `json:"result"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || len(envelope.Result.Content) == 0 {
			t.Fatalf("%s: %d %s", tool, response.Code, response.Body.String())
		}
		return envelope.Result.Content[0].Text, envelope.Result.IsError
	}
	const want = "Studio no longer serves this folder; add it again from the Workspaces page"

	listed, isError := call("list_workspaces", `{}`)
	var workspaces []map[string]any
	if err := json.Unmarshal([]byte(listed), &workspaces); err != nil || isError {
		t.Fatalf("list_workspaces = %s (error %v)", listed, isError)
	}
	found := false
	for _, workspace := range workspaces {
		if workspace["id"] == "ws_lineage" {
			found = true
			if workspace["unavailable"] != want {
				t.Fatalf("list_workspaces ws_lineage = %v, want unavailable %q", workspace, want)
			}
		}
	}
	if !found {
		t.Fatalf("list_workspaces = %s, want ws_lineage listed", listed)
	}

	if text, isError := call("create_session", `{"prompt":"work"}`); !isError || text != want {
		t.Fatalf("create_session = %q (error %v), want %q", text, isError, want)
	}
	if text, isError := call("send_message", `{"sessionId":"`+child.ID+`","message":"more"}`); !isError || text != want {
		t.Fatalf("send_message = %q (error %v), want %q", text, isError, want)
	}
}
