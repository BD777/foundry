package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

var folderCapabilities = []string{store.DaemonCapabilityWorkspaceInventory, store.DaemonCapabilityWorkspaceFolders}

// connectMacWithMissingFolder connects dev_mac serving ws_mac_a, with the
// folder of ws_mac_b gone.
func connectMacWithMissingFolder(t *testing.T, server *Server) *websocket.Conn {
	t.Helper()
	httpServer := httptest.NewServer(server.Routes())
	t.Cleanup(httpServer.Close)
	conn := dialDaemonForTest(t, httpServer)
	hello := macHello(folderCapabilities, []string{"ws_mac_a"})
	hello["missingWorkspaceIds"] = []string{"ws_mac_b"}
	writeWSForTest(t, conn, "hello", hello)
	var registered struct {
		Features []string `json:"features"`
	}
	readWSPayloadForTest(t, conn, "registered", &registered)
	if !strings.Contains(strings.Join(registered.Features, ","), store.DaemonCapabilityWorkspaceFolders) {
		t.Fatalf("registered features = %v, want workspace_folders", registered.Features)
	}
	return conn
}

// answerRelink plays the worker: it reads the relink request and answers it
// with the workspace served from the requested folder.
func answerRelink(t *testing.T, conn *websocket.Conn, moved store.WorkspaceNativeSessionsMoved) wsRelinkWorkspacePayload {
	t.Helper()
	var request wsRelinkWorkspacePayload
	id := readWSPayloadEnvelopeForTest(t, conn, wsRelinkWorkspaceType, &request)
	writeWSIDForTest(t, conn, id, wsWorkspaceRelinkedType, map[string]any{
		"registration": map[string]any{
			"capabilities": folderCapabilities,
			"device":       map[string]any{"id": "dev_mac", "label": "CanWendeMac-mini", "status": "connected"},
			"workspace":    map[string]any{"id": request.WorkspaceID, "name": "moved", "localPath": request.Path},
		},
		"nativeSessions": moved,
	})
	return request
}

// A worker that lost a workspace's folder says so: the workspace shows the
// folder missing, sessions there are refused with what to do, and locating
// the folder serves the same workspace from it.
func TestMissingFolderIsReportedAndLocated(t *testing.T) {
	db := newTestStore(t)
	registerMacWorkspaces(t, db)
	ctx := context.Background()
	done, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_mac_b", AgentID: "agent_ws_mac_b", Provider: "claude", Prompt: "earlier"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, done.ID, "ok", "cb01fab2-e71a-416f-b9cb-86d9ee11ce30"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	conn := connectMacWithMissingFolder(t, server)

	if got := workspaceAvailability(t, db, "ws_mac_b"); got == nil || got.Reason != store.WorkspaceFolderMissing {
		t.Fatalf("availability = %+v, want folder_missing", got)
	}
	refused := postJSONForTest(t, server, "/api/agent-sessions",
		`{"workspaceId":"ws_mac_b","provider":"claude","prompt":"run here"}`, http.StatusConflict)
	if message, _ := refused["error"].(string); !strings.Contains(message, "/Volumes/work/ws_mac_b no longer exists on CanWendeMac-mini") ||
		!strings.Contains(message, "Locate folder") {
		t.Fatalf("refusal = %v", refused)
	}

	// The folder comes back, then goes again: the worker tells.
	writeWSForTest(t, conn, wsWorkspaceFoldersType, map[string]any{"servedWorkspaceIds": []string{"ws_mac_a", "ws_mac_b"}, "missingWorkspaceIds": []string{}})
	readWSTypeForTest(t, conn, wsAckType)
	if got := workspaceAvailability(t, db, "ws_mac_b"); got != nil {
		t.Fatalf("availability after the folder came back = %+v", got)
	}
	writeWSForTest(t, conn, wsWorkspaceFoldersType, map[string]any{"servedWorkspaceIds": []string{"ws_mac_a"}, "missingWorkspaceIds": []string{"ws_mac_b"}})
	readWSTypeForTest(t, conn, wsAckType)
	if got := workspaceAvailability(t, db, "ws_mac_b"); got == nil || got.Reason != store.WorkspaceFolderMissing {
		t.Fatalf("availability after it went again = %+v", got)
	}

	// Another workspace's folder is refused before the device is asked.
	taken := postJSONForTest(t, server, "/api/workspaces/ws_mac_b/relink", `{"path":"/Volumes/work/ws_mac_a"}`, http.StatusConflict)
	if message, _ := taken["error"].(string); !strings.Contains(message, "already the workspace “ws_mac_a”") {
		t.Fatalf("taken folder = %v", taken)
	}

	result := make(chan map[string]any, 1)
	go func() {
		result <- postJSONForTest(t, server, "/api/workspaces/ws_mac_b/relink", `{"path":"/Volumes/work/research"}`, http.StatusOK)
	}()
	request := answerRelink(t, conn, store.WorkspaceNativeSessionsMoved{Copied: 1})
	if request.WorkspaceID != "ws_mac_b" || request.Path != "/Volumes/work/research" || request.PreviousPath != "/Volumes/work/ws_mac_b" {
		t.Fatalf("relink request = %+v", request)
	}
	if len(request.NativeSessions) != 1 || request.NativeSessions[0] != (wsNativeSessionRef{Provider: "claude", ID: "cb01fab2-e71a-416f-b9cb-86d9ee11ce30"}) {
		t.Fatalf("native sessions sent = %+v", request.NativeSessions)
	}
	answer := <-result
	located, _ := answer["workspace"].(map[string]any)
	moved, _ := answer["nativeSessions"].(map[string]any)
	if located["id"] != "ws_mac_b" || located["localPath"] != "/Volumes/work/research" || located["unavailableOnDevice"] != nil || moved["copied"] != float64(1) {
		t.Fatalf("relink answer = %v", answer)
	}
	if session, err := db.GetAgentSession(ctx, done.ID); err != nil || session.WorkspaceID != "ws_mac_b" {
		t.Fatalf("session after relink = %+v %v", session, err)
	}
}

// removeAndForget removes ws_mac_b, answering the device's forget for it:
// with its folder gone, that is all the device does.
func removeAndForget(t *testing.T, server *Server, conn *websocket.Conn) {
	t.Helper()
	removed := make(chan struct{})
	go func() {
		defer close(removed)
		requestForTest(t, server, http.MethodDelete, "/api/workspaces/ws_mac_b", "", http.StatusOK)
	}()
	var forget map[string]any
	id := readWSPayloadEnvelopeForTest(t, conn, wsForgetWorkspaceType, &forget)
	writeWSIDForTest(t, conn, id, wsWorkspaceForgottenType, map[string]any{"workspaceId": "ws_mac_b"})
	<-removed
}

// Removing a workspace whose folder is gone deletes it at once, with what
// it owned; the device only forgets it.
func TestRemovingAMissingFolderWorkspaceDeletesIt(t *testing.T) {
	db := newTestStore(t)
	registerMacWorkspaces(t, db)
	ctx := context.Background()
	done, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_mac_b", AgentID: "agent_ws_mac_b", Provider: "claude", Prompt: "earlier"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, done.ID, "ok", "native_b"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	conn := connectMacWithMissingFolder(t, server)

	removeAndForget(t, server, conn)

	if _, err := db.GetWorkspace(ctx, "ws_mac_b"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("workspace after removal: %v", err)
	}
	if _, err := db.GetAgentSession(ctx, done.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("session after removal: %v", err)
	}
}

// Nothing selected stays nothing selected: a read for "none" never picks the
// first workspace.
func TestDataReadForNoWorkspace(t *testing.T) {
	db := newTestStore(t)
	registerMacWorkspaces(t, db)
	server := NewServer(db)
	response := requestForTest(t, server, http.MethodGet, "/api/foundry-data?workspaceId=none&fields=workspaces", "", http.StatusOK)
	var data struct {
		Workspace  store.WorkspaceProjection   `json:"workspace"`
		Workspaces []store.WorkspaceProjection `json:"workspaces"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if data.Workspace.ID != "" || len(data.Workspaces) < 2 {
		t.Fatalf("data for no workspace = %+v", data)
	}
}
