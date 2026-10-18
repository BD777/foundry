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
)

type recordingAuditor struct{ records []WorkspaceLifecycleRecord }

func (a *recordingAuditor) AuditWorkspaceLifecycle(_ context.Context, record WorkspaceLifecycleRecord) {
	a.records = append(a.records, record)
}

// Archiving keeps everything and refuses new sessions; restoring makes the
// workspace usable again.
func TestArchivedWorkspaceRefusesNewSessionsUntilRestored(t *testing.T) {
	db := newTestStore(t)
	registerMacWorkspaces(t, db)
	earlier, err := db.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		WorkspaceID: "ws_mac_b", AgentID: "agent_ws_mac_b", Provider: "claude", Prompt: "before archiving",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	conn := dialDaemonForTest(t, httpServer)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	writeWSForTest(t, conn, "hello", macHello(nil, nil))
	readWSTypeForTest(t, conn, "registered")

	archived := decodeWorkspaceForTest(t, requestForTest(t, server, http.MethodPatch, "/api/workspaces/ws_mac_b", `{"archived":true}`, http.StatusOK))
	if archived.ArchivedAt == "" || archived.Name != "ws_mac_b" {
		t.Fatalf("archive = %+v", archived)
	}
	refused := postJSONForTest(t, server, "/api/agent-sessions",
		`{"workspaceId":"ws_mac_b","agentId":"agent_ws_mac_b","provider":"claude","prompt":"run here"}`, http.StatusConflict)
	if message, _ := refused["error"].(string); !strings.Contains(message, "archived") {
		t.Fatalf("create in the archived workspace = %v", refused)
	}
	if _, err := db.GetAgentSessionSummary(context.Background(), earlier.ID); err != nil {
		t.Fatalf("archiving lost the earlier session: %v", err)
	}
	listed := requestForTest(t, server, http.MethodGet, "/api/workspaces", "", http.StatusOK)
	if !strings.Contains(listed.Body.String(), `"archivedAt"`) {
		t.Fatalf("the list does not show the archived workspace: %s", listed.Body.String())
	}

	restored := decodeWorkspaceForTest(t, requestForTest(t, server, http.MethodPatch, "/api/workspaces/ws_mac_b", `{"archived":false}`, http.StatusOK))
	if restored.ArchivedAt != "" {
		t.Fatalf("restore = %+v", restored)
	}
	postJSONForTest(t, server, "/api/agent-sessions",
		`{"workspaceId":"ws_mac_b","agentId":"agent_ws_mac_b","provider":"claude","prompt":"run here"}`, http.StatusCreated)
}

// The assistant's workspace cannot be removed, archived or shared.
func TestPersonalAgentWorkspaceCannotBeRemovedArchivedOrShared(t *testing.T) {
	db := newTestStore(t)
	registerMacWorkspaces(t, db)
	if err := db.SetWorkspaceKind(context.Background(), "ws_mac_a", store.WorkspaceKindPersonalAgent); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	requestForTest(t, server, http.MethodDelete, "/api/workspaces/ws_mac_a", "", http.StatusForbidden)
	requestForTest(t, server, http.MethodPost, "/api/workspaces/ws_mac_a/members", `{"username":"someone","role":"member"}`, http.StatusForbidden)
	requestForTest(t, server, http.MethodPatch, "/api/workspaces/ws_mac_a", `{"archived":true}`, http.StatusForbidden)
	workspace, err := db.GetWorkspace(context.Background(), "ws_mac_a")
	if err != nil || workspace.Kind != store.WorkspaceKindPersonalAgent || workspace.ArchivedAt != "" {
		t.Fatalf("the assistant's workspace changed: %+v %v", workspace, err)
	}
	renamed := decodeWorkspaceForTest(t, requestForTest(t, server, http.MethodPatch, "/api/workspaces/ws_mac_a", `{"name":"Assistant"}`, http.StatusOK))
	if renamed.Name != "Assistant" || renamed.Kind != store.WorkspaceKindPersonalAgent {
		t.Fatalf("rename = %+v", renamed)
	}
	// A project's are unchanged.
	requestForTest(t, server, http.MethodPatch, "/api/workspaces/ws_mac_b", `{"archived":true}`, http.StatusOK)
}

// A new folder goes under the device's managed root, named after the
// workspace; the result carries the name, kind and purpose asked for, and
// the write is audited.
func TestCreateWorkspaceMakesANewFolderUnderTheManagedRoot(t *testing.T) {
	db := newEmptyTestStore(t)
	server := NewServer(db)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	conn := dialDaemonForTest(t, httpServer)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	hello := homeRegistration("dev_home")
	hello["capabilities"] = []string{store.DaemonCapabilityWorkspaceInventory, store.DaemonCapabilityWorkspaceCreate}
	hello["device"].(map[string]any)["managedRoots"] = []string{"/home/me/Foundry"}
	writeWSForTest(t, conn, "hello", hello)
	readWSTypeForTest(t, conn, "registered")

	auditor := &recordingAuditor{}
	actor := WorkspaceActor{UserID: "usr_me", SessionID: "sess_pa", Auditor: auditor}
	type result struct {
		workspace store.WorkspaceProjection
		err       error
	}
	done := make(chan result, 1)
	go func() {
		workspace, err := server.CreateWorkspace(context.Background(), actor, WorkspaceCreateRequest{
			DeviceID: "dev_home", Create: &WorkspaceCreateSource{Kind: WorkspaceCreateEmpty, GitInit: true},
			Name: "Family budget", Purpose: "Tracks what the family spends.", Kind: store.WorkspaceKindPersonalAgent,
		})
		done <- result{workspace, err}
	}()
	setup := readWSTypesForTest(t, conn, "setup_workspace")["setup_workspace"]
	var payload wsSetupWorkspacePayload
	if err := json.Unmarshal(setup.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Path != "/home/me/Foundry/family-budget" || payload.Create == nil || payload.Create.Kind != "empty" || !payload.Create.GitInit {
		t.Fatalf("setup payload = %+v create=%+v", payload, payload.Create)
	}
	registration := homeRegistration("dev_home")
	registration["capabilities"], registration["device"] = hello["capabilities"], hello["device"]
	registration["workspace"] = map[string]any{"id": "ws_budget", "name": "family-budget", "localPath": payload.Path, "baseline": "main"}
	writeWSIDForTest(t, conn, setup.ID, "workspace_ready", map[string]any{"registration": registration})
	got := <-done
	if got.err != nil || got.workspace.ID != "ws_budget" || got.workspace.Name != "Family budget" || got.workspace.Kind != store.WorkspaceKindPersonalAgent {
		t.Fatalf("create = %+v %v", got.workspace, got.err)
	}
	if purpose, err := db.WorkspacePurpose(context.Background(), "ws_budget"); err != nil || purpose != "Tracks what the family spends." {
		t.Fatalf("purpose = %q %v", purpose, err)
	}
	if len(auditor.records) != 1 || auditor.records[0].Operation != WorkspaceOpCreate || auditor.records[0].WorkspaceID != "ws_budget" ||
		auditor.records[0].SessionID != "sess_pa" || auditor.records[0].Err != nil {
		t.Fatalf("audit = %+v", auditor.records)
	}

	// Outside the managed roots, or the assistant's kind on an existing
	// folder: refused before the device is asked, and audited.
	for _, request := range []WorkspaceCreateRequest{
		{DeviceID: "dev_home", Path: "/home/me/elsewhere/x", Create: &WorkspaceCreateSource{Kind: WorkspaceCreateEmpty}},
		{DeviceID: "dev_home", Path: "/home/me/Foundry/../x", Create: &WorkspaceCreateSource{Kind: WorkspaceCreateEmpty}},
		{DeviceID: "dev_home", Path: "/home/me/Foundry/x", Create: &WorkspaceCreateSource{Kind: WorkspaceCreateClone, URL: "--upload-pack=x"}},
		{DeviceID: "dev_home", Path: "/home/me/project", Kind: store.WorkspaceKindPersonalAgent},
	} {
		if _, err := server.CreateWorkspace(context.Background(), actor, request); errorStatus(err) != http.StatusBadRequest {
			t.Fatalf("create %+v = %v, want 400", request, err)
		}
	}
	if len(auditor.records) != 5 || auditor.records[4].Err == nil {
		t.Fatalf("refusals not audited: %+v", auditor.records)
	}
}

// A device whose worker cannot create folders is refused without being
// asked.
func TestCreateWorkspaceNeedsTheWorkspaceCreateCapability(t *testing.T) {
	db := newEmptyTestStore(t)
	server := NewServer(db)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	// Hijacked daemon sockets are outside httptest.Server.Close's wait.
	// Drain their handlers before the store and its temp directory are removed.
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			t.Errorf("shutdown daemon handlers: %v", err)
		}
	}()
	conn := dialDaemonForTest(t, httpServer)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	writeWSForTest(t, conn, "hello", homeRegistration("dev_home"))
	readWSTypeForTest(t, conn, "registered")
	_, err := server.CreateWorkspace(context.Background(), WorkspaceActor{UserID: "usr_me"}, WorkspaceCreateRequest{
		DeviceID: "dev_home", Name: "Notes", Create: &WorkspaceCreateSource{Kind: WorkspaceCreateEmpty},
	})
	if errorStatus(err) != http.StatusConflict {
		t.Fatalf("create on an old worker = %v, want 409", err)
	}
	_, err = server.CreateWorkspace(context.Background(), WorkspaceActor{UserID: "usr_me"}, WorkspaceCreateRequest{
		DeviceID: "dev_offline", Name: "Notes", Create: &WorkspaceCreateSource{Kind: WorkspaceCreateEmpty},
	})
	if errorStatus(err) != http.StatusConflict || !errors.Is(err, ErrLocalDaemonNotConnected) {
		t.Fatalf("create on an offline device = %v", err)
	}
}

// Adding and removing skills and connectors keeps the others.
func TestChangedSetKeepsOthersInOrder(t *testing.T) {
	got := changedSet([]string{"a", "b", "c"}, []string{"d", "b", " "}, []string{"a"})
	if strings.Join(got, ",") != "b,c,d" {
		t.Fatalf("changedSet = %v", got)
	}
}

func TestManagedWorkspacePath(t *testing.T) {
	for _, tc := range []struct {
		roots      []string
		path, name string
		want       string
		ok         bool
	}{
		{[]string{"/Users/me/Foundry/"}, "", "Wedding website!", "/Users/me/Foundry/wedding-website", true},
		{[]string{"/Users/me/Foundry"}, "", "家庭 记账", "/Users/me/Foundry/家庭-记账", true},
		{[]string{`C:\Users\me\Foundry`}, "", "Notes", `C:\Users\me\Foundry\notes`, true},
		{[]string{"/a", "/Users/me/Foundry"}, "/Users/me/Foundry/x/y", "", "/Users/me/Foundry/x/y", true},
		{[]string{"/Users/me/Foundry"}, "/Users/me/Foundry", "", "", false},
		{[]string{"/Users/me/Foundry"}, "/Users/me/FoundryX/y", "", "", false},
		{[]string{"/Users/me/Foundry"}, "/Users/me/Foundry/./y", "", "", false},
		{[]string{"/Users/me/Foundry"}, "", "!!!", "", false},
		{nil, "", "Notes", "", false},
	} {
		got, err := managedWorkspacePath(tc.roots, tc.path, tc.name)
		if (err == nil) != tc.ok || got != tc.want {
			t.Errorf("managedWorkspacePath(%v, %q, %q) = %q %v", tc.roots, tc.path, tc.name, got, err)
		}
	}
}

func decodeWorkspaceForTest(t *testing.T, response *httptest.ResponseRecorder) store.WorkspaceProjection {
	t.Helper()
	var workspace store.WorkspaceProjection
	if err := json.Unmarshal(response.Body.Bytes(), &workspace); err != nil {
		t.Fatalf("decode workspace %s: %v", response.Body.String(), err)
	}
	return workspace
}
