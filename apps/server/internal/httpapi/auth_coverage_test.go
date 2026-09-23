package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var pathParameter = regexp.MustCompile(`\{[^}]+\}`)

func concretePath(pattern string) string {
	return pathParameter.ReplaceAllString(pattern, "x")
}

// Every API route is registered from routeTable with a rule; server.go adds
// only OPTIONS, /healthz and the static web app.
func TestEveryAPIRouteDeclaresAnAccessRule(t *testing.T) {
	source, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	if direct := regexp.MustCompile(`mux\.Handle(Func)?\("[A-Z]+ /api`).FindAllString(string(source), -1); len(direct) > 0 {
		t.Fatalf("API routes registered outside routeTable: %v", direct)
	}
	server, _ := newAccountsTestServer(t)
	routes := server.routeTable()
	if len(routes) < 100 {
		t.Fatalf("routeTable has only %d routes", len(routes))
	}
	seen := map[string]bool{}
	for _, route := range routes {
		if route.rule.check == nil || route.rule.kind == "" {
			t.Errorf("%s has no access rule", route.pattern)
		}
		if seen[route.pattern] {
			t.Errorf("%s is registered twice", route.pattern)
		}
		seen[route.pattern] = true
	}
}

func TestEveryNonPublicAPIRouteRequiresCredentials(t *testing.T) {
	server, handler := newAccountsTestServer(t)
	for _, route := range server.routeTable() {
		if route.rule.kind == "public" {
			continue
		}
		method, path, _ := strings.Cut(route.pattern, " ")
		recorder := doAuthCall(t, handler, authCall{method: method, path: concretePath(path), body: `{}`, origin: accountsTestOrigin})
		if recorder.Code != http.StatusUnauthorized {
			t.Errorf("%s without credentials: status %d, want 401 (body %s)", route.pattern, recorder.Code, recorder.Body.String())
		}
	}
}

// isolationFixture: the first admin ("owner", alice's session) and bob each
// paired a device that registered one workspace; alice owns a connection and
// an issue.
type isolationFixture struct {
	server          *Server
	handler         http.Handler
	alice, bob      string
	aliceID, bobID  string
	aliceDevice     string
	bobDevice       string
	aliceIssue      string
	aliceConnection string
}

func newIsolationFixture(t *testing.T) isolationFixture {
	t.Helper()
	server, handler := newAccountsTestServer(t)
	f := isolationFixture{server: server, handler: handler}
	f.alice = setupOwner(t, server, handler)
	f.bob = inviteAndJoin(t, handler, f.alice, store.RoleMember, "bob")
	_, f.aliceDevice = pairOverHTTP(t, handler, f.alice, "machine-alice", "dev_alice")
	_, f.bobDevice = pairOverHTTP(t, handler, f.bob, "machine-bob", "dev_bob")
	for _, register := range []struct{ device, workspace, credential string }{
		{"dev_alice", "ws_alice", f.aliceDevice}, {"dev_bob", "ws_bob", f.bobDevice},
	} {
		expectStatus(t, doAuthCall(t, handler, deviceCall(http.MethodPost, "/api/daemon/register",
			registrationBody(register.device, register.workspace), register.credential)), http.StatusOK, "register "+register.workspace)
	}
	var users []store.User
	_ = json.Unmarshal(doAuthCall(t, handler, authCall{method: http.MethodGet, path: "/api/users", cookie: f.alice}).Body.Bytes(), &users)
	for _, user := range users {
		switch user.Username {
		case "owner":
			f.aliceID = user.ID
		case "bob":
			f.bobID = user.ID
		}
	}
	issue := doAuthCall(t, handler, f.as(f.alice, http.MethodPost, "/api/issues",
		`{"workspaceId":"ws_alice","sourceInput":"alice's issue","runtime":"mock"}`))
	expectStatus(t, issue, http.StatusCreated, "alice creates an issue")
	var created store.Issue
	_ = json.Unmarshal(issue.Body.Bytes(), &created)
	f.aliceIssue = created.ID
	connection := doAuthCall(t, handler, f.as(f.alice, http.MethodPost, "/api/profiles",
		`{"runtime":"claude","label":"Alice relay","authMode":"custom","connectionType":"anthropic_compatible","baseUrl":"https://relay.example"}`))
	expectStatus(t, connection, http.StatusCreated, "alice creates a connection")
	var profile store.ProfileDefinition
	_ = json.Unmarshal(connection.Body.Bytes(), &profile)
	f.aliceConnection = profile.ID
	return f
}

func (f isolationFixture) as(session string, method, path, body string) authCall {
	return authCall{method: method, path: path, body: body, cookie: session, origin: accountsTestOrigin,
		headers: map[string]string{"Idempotency-Key": method + path + body}}
}

func TestAccountsCannotReachEachOthersResources(t *testing.T) {
	f := newIsolationFixture(t)
	call := func(method, path, body string) int {
		return doAuthCall(t, f.handler, f.as(f.bob, method, path, body)).Code
	}

	// Lists and the projection only show bob's own world.
	var workspaces []store.WorkspaceProjection
	_ = json.Unmarshal(doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, "/api/workspaces", "")).Body.Bytes(), &workspaces)
	if len(workspaces) != 1 || workspaces[0].ID != "ws_bob" {
		t.Fatalf("bob's workspaces = %+v", workspaces)
	}
	projection := doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, "/api/foundry-data", ""))
	expectStatus(t, projection, http.StatusOK, "bob's projection")
	for _, leaked := range []string{"ws_alice", "dev_alice", "Alice relay", f.aliceIssue} {
		if strings.Contains(projection.Body.String(), leaked) {
			t.Errorf("bob's projection leaks %q", leaked)
		}
	}
	var devices []store.DeviceProjection
	_ = json.Unmarshal(doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, "/api/devices", "")).Body.Bytes(), &devices)
	if len(devices) != 1 || devices[0].ID != "dev_bob" {
		t.Fatalf("bob's devices = %+v", devices)
	}
	if profiles := doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, "/api/profiles", "")).Body.String(); strings.Contains(profiles, "Alice relay") {
		t.Fatalf("bob sees alice's connection: %s", profiles)
	}

	// Direct access to alice's resources answers 404 (existence not leaked).
	for _, attempt := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/workspaces/ws_alice", ""},
		{http.MethodGet, "/api/foundry-data?workspaceId=ws_alice", ""},
		{http.MethodGet, "/api/issues?workspaceId=ws_alice", ""},
		{http.MethodGet, "/api/issues/" + f.aliceIssue, ""},
		{http.MethodPost, "/api/issues/" + f.aliceIssue + "/clarify", `{}`},
		{http.MethodPost, "/api/issues/" + f.aliceIssue + "/accept", `{}`},
		{http.MethodPost, "/api/issues", `{"workspaceId":"ws_alice","sourceInput":"intrude","runtime":"mock"}`},
		{http.MethodPost, "/api/agent-sessions", `{"workspaceId":"ws_alice","provider":"claude","prompt":"intrude"}`},
		{http.MethodPost, "/api/chat-layout", `{"workspaceId":"ws_alice","layout":{}}`},
		{http.MethodPatch, "/api/workspaces/ws_alice", `{"name":"mine now"}`},
		{http.MethodDelete, "/api/devices/dev_alice", ""},
		{http.MethodPut, "/api/devices/dev_alice/skill-roots", `{"roots":[]}`},
		{http.MethodPost, "/api/devices/runtime-settings", `{"deviceId":"dev_alice","settings":{"activeRuntimeTtlMs":1000,"maxConcurrentTasks":2}}`},
		{http.MethodPost, "/api/workspaces", `{"deviceId":"dev_alice","path":"/tmp/steal"}`},
		{http.MethodPut, "/api/profiles/" + f.aliceConnection, `{"runtime":"claude","label":"x","authMode":"custom","connectionType":"anthropic_compatible"}`},
		{http.MethodDelete, "/api/profiles/" + f.aliceConnection, ""},
		{http.MethodGet, "/api/device-skills?deviceId=dev_alice", ""},
		{http.MethodGet, "/api/workspace-files/tree?workspaceId=ws_alice", ""},
		{http.MethodGet, "/api/workspace-files/read?workspaceId=ws_alice&path=README.md", ""},
	} {
		if status := call(attempt.method, attempt.path, attempt.body); status != http.StatusNotFound {
			t.Errorf("bob %s %s: status %d, want 404", attempt.method, attempt.path, status)
		}
	}
	if status := call(http.MethodGet, "/api/users", ""); status != http.StatusForbidden {
		t.Errorf("bob lists users: %d, want 403", status)
	}

	// Bob's device credential is bound to bob's device and workspace.
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodGet, "/api/issues?workspaceId=ws_alice", "", f.bobDevice)),
		http.StatusNotFound, "bob's device reads alice's issues")
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/chats/sync", `{"workspaceId":"ws_alice","chats":[]}`, f.bobDevice)),
		http.StatusNotFound, "bob's device syncs chats into alice's workspace")
	expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/issues/"+f.aliceIssue+"/complete", `{}`, f.bobDevice)),
		http.StatusNotFound, "bob's device completes alice's issue")
}

func TestWorkspaceRolesGateActions(t *testing.T) {
	f := newIsolationFixture(t)
	ownership := f.server.store.(store.OwnershipStore)
	grant := func(role string) {
		if err := ownership.SetWorkspaceMember(context.Background(), "ws_alice", f.bobID, role, f.aliceID); err != nil {
			t.Fatal(err)
		}
	}
	status := func(method, path, body string) int {
		return doAuthCall(t, f.handler, f.as(f.bob, method, path, body)).Code
	}
	issuePath := "/api/issues/" + f.aliceIssue
	createIssue := `{"workspaceId":"ws_alice","sourceInput":"bob's idea","runtime":"mock"}`

	grant(store.WorkspaceRoleViewer)
	if got := status(http.MethodGet, issuePath, ""); got != http.StatusOK {
		t.Errorf("viewer reads an issue: %d", got)
	}
	if got := status(http.MethodPost, "/api/issues", createIssue); got != http.StatusForbidden {
		t.Errorf("viewer creates an issue: %d, want 403", got)
	}
	var devices []store.DeviceProjection
	_ = json.Unmarshal(doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, "/api/devices", "")).Body.Bytes(), &devices)
	sawHost := false
	for _, device := range devices {
		if device.ID == "dev_alice" {
			sawHost = true
			if device.RuntimeSettings != nil {
				t.Error("a shared workspace must not reveal the device's execution settings")
			}
		}
	}
	if !sawHost {
		t.Error("a collaborator sees the device hosting the shared workspace")
	}
	for _, device := range devices {
		if device.ID == "dev_alice" && device.Owned {
			t.Error("a collaborator must not be told it owns the host device")
		}
	}
	var workspaces []store.WorkspaceProjection
	_ = json.Unmarshal(doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, "/api/workspaces", "")).Body.Bytes(), &workspaces)
	for _, workspace := range workspaces {
		if workspace.ID == "ws_alice" && workspace.AccessRole != store.WorkspaceRoleViewer {
			t.Errorf("shared workspace accessRole = %q, want viewer", workspace.AccessRole)
		}
	}
	var data store.FoundryDataProjection
	_ = json.Unmarshal(doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, "/api/foundry-data?workspaceId=ws_alice", "")).Body.Bytes(), &data)
	if data.Workspace.AccessRole != store.WorkspaceRoleViewer {
		t.Errorf("foundry-data accessRole = %q, want viewer", data.Workspace.AccessRole)
	}
	denied := doAuthCall(t, f.handler, f.as(f.bob, http.MethodPost, issuePath+"/accept", `{}`))
	if !strings.Contains(denied.Body.String(), "You are a Viewer in this workspace; this action needs Maintainer") {
		t.Errorf("403 must name the caller's role and the required role: %s", denied.Body.String())
	}
	if got := status(http.MethodDelete, "/api/devices/dev_alice", ""); got != http.StatusNotFound {
		t.Errorf("a collaborator removes the host device: %d, want 404", got)
	}

	var own []store.DeviceProjection
	_ = json.Unmarshal(doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, "/api/devices", "")).Body.Bytes(), &own)
	for _, device := range own {
		if device.ID == "dev_alice" && !device.Owned {
			t.Error("the device owner must see owned=true")
		}
	}

	grant(store.WorkspaceRoleMember)
	if got := status(http.MethodPost, "/api/issues", createIssue); got != http.StatusCreated {
		t.Errorf("member creates an issue: %d, want 201", got)
	}
	if got := status(http.MethodPost, issuePath+"/accept", `{}`); got != http.StatusForbidden {
		t.Errorf("member accepts: %d, want 403", got)
	}
	if got := status(http.MethodPut, "/api/workspaces/ws_alice/skills", `{"skillIds":[]}`); got != http.StatusForbidden {
		t.Errorf("member manages skills: %d, want 403", got)
	}

	grant(store.WorkspaceRoleMaintainer)
	if got := status(http.MethodPost, issuePath+"/accept", `{}`); got == http.StatusForbidden || got == http.StatusNotFound || got == http.StatusUnauthorized {
		t.Errorf("maintainer accept must pass authorization, got %d", got)
	}
	if got := status(http.MethodPatch, "/api/workspaces/ws_alice", `{"name":"renamed"}`); got != http.StatusForbidden {
		t.Errorf("maintainer renames the workspace: %d, want 403", got)
	}

	grant(store.WorkspaceRoleOwner)
	if got := status(http.MethodPatch, "/api/workspaces/ws_alice", `{"name":"renamed"}`); got == http.StatusForbidden || got == http.StatusNotFound {
		t.Errorf("owner rename must pass authorization, got %d", got)
	}
}
