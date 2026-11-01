package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/gorilla/websocket"
)

const (
	homeFolder    = "/home/me/Foundry"
	homeWorkspace = "ws_home"
)

// homeRegistration is what a worker installed before devices started
// without a workspace reports: the ~/Foundry folder its service names.
func homeRegistration(deviceID string) map[string]any {
	return map[string]any{
		"capabilities":   []string{store.DaemonCapabilityWorkspaceInventory},
		"device":         map[string]any{"id": deviceID, "label": "linux-dev", "status": "connected", "lastSeenLabel": "online"},
		"workspace":      map[string]any{"id": homeWorkspace, "name": "Foundry", "localPath": homeFolder, "baseline": "main"},
		"providerHealth": []any{},
		"assets":         []any{},
		"agents":         []any{},
		"skills":         []any{},
		"workspaceFiles": []any{},
	}
}

func jsonForTest(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// readWSTypesForTest reads until every wanted type arrived, in any order,
// skipping other requests the server makes of a new connection.
func readWSTypesForTest(t *testing.T, conn *websocket.Conn, wanted ...string) map[string]wsEnvelope {
	t.Helper()
	got := map[string]wsEnvelope{}
	for len(got) < len(wanted) {
		var envelope wsEnvelope
		if err := conn.ReadJSON(&envelope); err != nil {
			t.Fatalf("read websocket %v (got %v): %v", wanted, got, err)
		}
		for _, want := range wanted {
			if envelope.Type == want {
				got[want] = envelope
			}
		}
	}
	return got
}

func deleteWorkspaceForTest(httpServer *httptest.Server, id string) <-chan int {
	status := make(chan int, 1)
	go func() {
		request, _ := http.NewRequest(http.MethodDelete, httpServer.URL+"/api/workspaces/"+id, nil)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			status <- 0
			return
		}
		response.Body.Close()
		status <- response.StatusCode
	}()
	return status
}

func assertWorkspaceGone(t *testing.T, db store.Store, label string) {
	t.Helper()
	if workspace, err := db.GetWorkspace(context.Background(), homeWorkspace); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("%s: the deleted workspace came back: %+v %v", label, workspace, err)
	}
}

// The evidence: the person deleted linux-dev's "Foundry" workspace, and its
// worker re-created it with the same id on its next start, from the
// registration its service sends for ~/Foundry. Every way a device reports
// the folder now keeps it deleted.
func TestDeletedWorkspaceStaysDeletedWhenItsDeviceReportsIt(t *testing.T) {
	server, handler := newAccountsTestServer(t)
	owner := setupOwner(t, server, handler)
	_, home := pairOverHTTP(t, handler, owner, "machine-home", "dev_home")
	register := func(label string) {
		t.Helper()
		expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodPost, "/api/daemon/register", jsonForTest(t, homeRegistration("dev_home")), home)),
			http.StatusOK, label)
	}
	register("register the folder")
	expectStatus(t, doAuthCall(t, handler, authCall{method: http.MethodDelete, path: "/api/workspaces/" + homeWorkspace, cookie: owner, origin: accountsTestOrigin}),
		http.StatusOK, "delete the workspace")

	// The worker starts again and registers the folder its service names.
	register("startup registration of the deleted folder")
	assertWorkspaceGone(t, server.store, "startup registration")
	expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodGet, "/api/issues?workspaceId="+homeWorkspace, "", home)),
		http.StatusNotFound, "the deleted workspace's Issues")

	// It connects and names the folder (it was offline when the person
	// deleted it, or an older worker's reply carries it): kept out, and the
	// device is told to forget the folder, once.
	httpServer := httptest.NewServer(handler)
	defer httpServer.Close()
	headers := http.Header{}
	headers.Set(deviceCredentialHeader, home)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/api/daemon/ws", headers)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	hello := homeRegistration("dev_home")
	hello["servedWorkspaceIds"] = []string{homeWorkspace}
	writeWSForTest(t, conn, "hello", hello)
	forget := readWSTypesForTest(t, conn, "registered", "forget_workspace")["forget_workspace"]
	var payload wsForgetWorkspacePayload
	if err := json.Unmarshal(forget.Payload, &payload); err != nil || payload.WorkspaceID != homeWorkspace || payload.Path != homeFolder {
		t.Fatalf("forget payload = %+v %v", payload, err)
	}
	writeWSIDForTest(t, conn, forget.ID, "workspace_forgotten", map[string]any{"workspaceId": homeWorkspace})
	writeWSForTest(t, conn, "workspace_ready", map[string]any{"registration": homeRegistration("dev_home")})
	readWSTypeForTest(t, conn, "registered")
	_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	for {
		var envelope wsEnvelope
		if err := conn.ReadJSON(&envelope); err != nil {
			break
		}
		if envelope.Type == "forget_workspace" {
			t.Fatal("the device was told to forget the same folder twice on one connection")
		}
	}
	assertWorkspaceGone(t, server.store, "hello and replies")
	listed := doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/workspaces", cookie: owner})
	expectStatus(t, listed, http.StatusOK, "list workspaces")
	if strings.Contains(listed.Body.String(), homeWorkspace) {
		t.Fatalf("the Workspaces page lists the deleted workspace: %s", listed.Body.String())
	}
}

// A connection remembers the registrations it carried. Deleting the
// workspace while the device does not answer the forget, then losing the
// connection (here: the server stopping), must not write it back.
func TestEndingAConnectionDoesNotRecreateAWorkspaceDeletedDuringIt(t *testing.T) {
	db := newEmptyTestStore(t)
	server := NewServer(db)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	conn := dialDaemonForTest(t, httpServer)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	writeWSForTest(t, conn, "hello", homeRegistration("dev_home"))
	readWSTypeForTest(t, conn, "registered")

	deleted := deleteWorkspaceForTest(httpServer, homeWorkspace)
	readWSTypesForTest(t, conn, "forget_workspace")
	if status := <-deleted; status != http.StatusOK {
		t.Fatalf("delete = %d", status)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.hub.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	assertWorkspaceGone(t, db, "connection ended")
}

// "Add again" (and Add workspace with the same folder) is the way back: the
// deletion is taken back before the device is asked, so its answer — even
// one that comes after the request gave up — registers the workspace, and
// deleting it again holds again.
func TestAddingAFolderAgainBringsBackItsDeletedWorkspace(t *testing.T) {
	db := newEmptyTestStore(t)
	server := NewServer(db)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	conn := dialDaemonForTest(t, httpServer)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	writeWSForTest(t, conn, "hello", homeRegistration("dev_home"))
	readWSTypeForTest(t, conn, "registered")

	deleteAnswered := func() {
		t.Helper()
		deleted := deleteWorkspaceForTest(httpServer, homeWorkspace)
		forget := readWSTypesForTest(t, conn, "forget_workspace")["forget_workspace"]
		writeWSIDForTest(t, conn, forget.ID, "workspace_forgotten", map[string]any{"workspaceId": homeWorkspace})
		if status := <-deleted; status != http.StatusOK {
			t.Fatalf("delete = %d", status)
		}
	}
	deleteAnswered()

	created := make(chan int, 1)
	go func() {
		response, err := http.Post(httpServer.URL+"/api/workspaces", "application/json",
			strings.NewReader(`{"deviceId":"dev_home","path":"`+homeFolder+`/"}`))
		if err != nil {
			created <- 0
			return
		}
		response.Body.Close()
		created <- response.StatusCode
	}()
	setup := readWSTypesForTest(t, conn, "setup_workspace")["setup_workspace"]
	if deleted, err := db.WorkspaceDeletedFromDevice(context.Background(), homeWorkspace, "dev_home"); err != nil || deleted {
		t.Fatalf("the deletion still holds while the device sets the folder up: %v %v", deleted, err)
	}
	writeWSIDForTest(t, conn, setup.ID, "workspace_ready", map[string]any{"registration": homeRegistration("dev_home")})
	if status := <-created; status != http.StatusCreated {
		t.Fatalf("add again = %d", status)
	}
	if _, err := db.GetWorkspace(context.Background(), homeWorkspace); err != nil {
		t.Fatalf("workspace added again: %v", err)
	}

	// Its later reports count again.
	renamed := homeRegistration("dev_home")
	renamed["workspace"].(map[string]any)["baseline"] = "trunk"
	writeWSForTest(t, conn, "workspace_ready", map[string]any{"registration": renamed})
	readWSTypeForTest(t, conn, "registered")
	if workspace, err := db.GetWorkspace(context.Background(), homeWorkspace); err != nil || workspace.Baseline != "trunk" {
		t.Fatalf("report after adding again = %+v %v", workspace, err)
	}

	// Deleted again, it stays deleted again.
	deleteAnswered()
	writeWSForTest(t, conn, "workspace_ready", map[string]any{"registration": homeRegistration("dev_home")})
	forget := readWSTypesForTest(t, conn, "registered", "forget_workspace")["forget_workspace"]
	writeWSIDForTest(t, conn, forget.ID, "workspace_forgotten", map[string]any{"workspaceId": homeWorkspace})
	assertWorkspaceGone(t, db, "deleted again")
}
