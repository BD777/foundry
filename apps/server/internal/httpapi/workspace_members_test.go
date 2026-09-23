package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (f isolationFixture) members(t *testing.T, session string) []workspaceMemberView {
	t.Helper()
	recorder := doAuthCall(t, f.handler, f.as(session, http.MethodGet, "/api/workspaces/ws_alice/members", ""))
	expectStatus(t, recorder, http.StatusOK, "list members")
	var members []workspaceMemberView
	if err := json.Unmarshal(recorder.Body.Bytes(), &members); err != nil {
		t.Fatal(err)
	}
	return members
}

func (f isolationFixture) bobRole(t *testing.T) string {
	t.Helper()
	var workspaces []store.WorkspaceProjection
	_ = json.Unmarshal(doAuthCall(t, f.handler, f.as(f.bob, http.MethodGet, "/api/workspaces", "")).Body.Bytes(), &workspaces)
	for _, workspace := range workspaces {
		if workspace.ID == "ws_alice" {
			return workspace.AccessRole
		}
	}
	return ""
}

func TestOwnerSharesAWorkspaceAndRolesTakeEffect(t *testing.T) {
	f := newIsolationFixture(t)
	status := func(session, method, path, body string) int {
		return doAuthCall(t, f.handler, f.as(session, method, path, body)).Code
	}
	membersPath := "/api/workspaces/ws_alice/members"
	bobPath := membersPath + "/" + f.bobID

	if got := status(f.bob, http.MethodGet, membersPath, ""); got != http.StatusNotFound {
		t.Fatalf("a stranger lists members: %d, want 404", got)
	}
	if got := status(f.alice, http.MethodPost, membersPath, `{"username":"nobody","role":"viewer"}`); got != http.StatusNotFound {
		t.Errorf("adding an unknown account: %d, want 404", got)
	}
	if got := status(f.alice, http.MethodPost, membersPath, `{"username":"bob","role":"admin"}`); got != http.StatusBadRequest {
		t.Errorf("adding with an unknown role: %d, want 400", got)
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, membersPath, `{"username":"Bob","role":"viewer"}`)),
		http.StatusNoContent, "share with bob")
	if got := status(f.alice, http.MethodPost, membersPath, `{"username":"bob","role":"member"}`); got != http.StatusConflict {
		t.Errorf("adding an existing member: %d, want 409", got)
	}
	if role := f.bobRole(t); role != store.WorkspaceRoleViewer {
		t.Fatalf("bob's role after sharing = %q, want viewer", role)
	}
	members := f.members(t, f.bob)
	if len(members) != 2 {
		t.Fatalf("members = %+v", members)
	}
	for _, member := range members {
		if member.UserID == f.aliceID && (!member.DeviceOwner || member.Role != store.WorkspaceRoleOwner) {
			t.Errorf("alice must be listed as the device-owning Owner: %+v", member)
		}
	}

	// Only Owners manage members.
	if got := status(f.bob, http.MethodPost, membersPath, `{"username":"owner","role":"viewer"}`); got != http.StatusForbidden {
		t.Errorf("a viewer adds members: %d, want 403", got)
	}
	if got := status(f.bob, http.MethodPatch, bobPath, `{"role":"owner"}`); got != http.StatusForbidden {
		t.Errorf("a viewer promotes itself: %d, want 403", got)
	}

	// The device owner always stays an Owner.
	alicePath := membersPath + "/" + f.aliceID
	if got := status(f.alice, http.MethodPatch, alicePath, `{"role":"member"}`); got != http.StatusConflict {
		t.Errorf("device owner demotes itself: %d, want 409", got)
	}
	if got := status(f.alice, http.MethodDelete, alicePath, ""); got != http.StatusConflict {
		t.Errorf("device owner leaves: %d, want 409", got)
	}

	// Members work on their own Issues; confirming someone else's needs Maintainer.
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPatch, bobPath, `{"role":"member"}`)),
		http.StatusNoContent, "promote bob to member")
	created := doAuthCall(t, f.handler, f.as(f.bob, http.MethodPost, "/api/issues",
		`{"workspaceId":"ws_alice","sourceInput":"bob's issue","runtime":"mock"}`))
	expectStatus(t, created, http.StatusCreated, "member creates an issue")
	var bobIssue store.Issue
	_ = json.Unmarshal(created.Body.Bytes(), &bobIssue)
	verify := `{"expectedContractRevision":1,"expectedCandidateSnapshotId":"x","criterionIds":["c1"]}`
	for _, path := range []string{"/contracts/1/confirm", "/verify"} {
		if got := status(f.bob, http.MethodPost, "/api/issues/"+f.aliceIssue+path, verify); got != http.StatusForbidden {
			t.Errorf("member %s on someone else's issue: %d, want 403", path, got)
		}
		if got := status(f.bob, http.MethodPost, "/api/issues/"+bobIssue.ID+path, verify); got == http.StatusForbidden || got == http.StatusNotFound {
			t.Errorf("member %s on its own issue must pass authorization, got %d", path, got)
		}
	}
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPatch, bobPath, `{"role":"maintainer"}`)),
		http.StatusNoContent, "promote bob to maintainer")
	if got := status(f.bob, http.MethodPost, "/api/issues/"+f.aliceIssue+"/verify", verify); got == http.StatusForbidden {
		t.Errorf("maintainer verifies any issue, got %d", got)
	}

	// A co-owner may be demoted while the device owner remains.
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPatch, bobPath, `{"role":"owner"}`)),
		http.StatusNoContent, "make bob a co-owner")
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, http.MethodPatch, bobPath, `{"role":"viewer"}`)),
		http.StatusNoContent, "a co-owner steps down")

	// Any member may leave.
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, http.MethodDelete, bobPath, "")), http.StatusNoContent, "bob leaves")
	if role := f.bobRole(t); role != "" {
		t.Fatalf("bob still reaches the workspace as %q", role)
	}
	if got := status(f.bob, http.MethodGet, "/api/workspaces/ws_alice", ""); got != http.StatusNotFound {
		t.Errorf("former member reads the workspace: %d, want 404", got)
	}
}

func TestRemovingAMemberStopsTheirSessionsAndAgentTokens(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	db := f.server.store
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/workspaces/ws_alice/members", `{"username":"bob","role":"member"}`)),
		http.StatusNoContent, "share with bob")
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_alice", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_alice", Name: "W", LocalPath: "/tmp/w"},
		Agents: []store.AgentProjection{{
			ID: "agent_bob", WorkspaceID: "ws_alice", DeviceID: "dev_alice", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.bobID, WorkspaceID: "ws_alice", AgentID: "agent_bob", Provider: "claude", Prompt: "work",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	token, err := db.MintAgentSessionToken(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	agentCall := authCall{method: http.MethodGet, path: "/api/agent-sessions?workspaceId=ws_alice",
		headers: map[string]string{"Authorization": "Bearer " + token}}
	expectStatus(t, doAuthCall(t, f.handler, agentCall), http.StatusOK, "bob's agent reads the workspace")

	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodDelete, "/api/workspaces/ws_alice/members/"+f.bobID, "")),
		http.StatusNoContent, "remove bob")
	stopped, err := db.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if activeOrBlocked(stopped.Status) {
		t.Fatalf("bob's session still %s after removal", stopped.Status)
	}
	if got := doAuthCall(t, f.handler, agentCall).Code; got != http.StatusUnauthorized && got != http.StatusNotFound {
		t.Fatalf("bob's agent token after removal: %d, want 401 or 404", got)
	}

	// Even a token that outlives the cancel acts only with bob's current role.
	late, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.bobID, WorkspaceID: "ws_alice", AgentID: "agent_bob", Provider: "claude", Prompt: "late",
	})
	if err != nil {
		t.Fatal(err)
	}
	lateToken, err := db.MintAgentSessionToken(ctx, late.ID)
	if err != nil {
		t.Fatal(err)
	}
	agentCall.headers = map[string]string{"Authorization": "Bearer " + lateToken}
	expectStatus(t, doAuthCall(t, f.handler, agentCall), http.StatusNotFound, "a removed member's agent reads the workspace")
}

func TestMembershipChangesEndTheAccountsEventStream(t *testing.T) {
	f := newIsolationFixture(t)
	live := httptest.NewServer(f.handler)
	defer live.Close()
	request, _ := http.NewRequest(http.MethodGet, live.URL+"/api/events", nil)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: f.bob})
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	if line, _ := reader.ReadString('\n'); !strings.HasPrefix(line, ": connected") {
		t.Fatalf("stream did not open: %q", line)
	}
	ended := make(chan struct{})
	go func() {
		for {
			if _, err := reader.ReadString('\n'); err != nil {
				close(ended)
				return
			}
		}
	}()
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/workspaces/ws_alice/members", `{"username":"bob","role":"viewer"}`)),
		http.StatusNoContent, "share with bob")
	select {
	case <-ended:
	case <-time.After(3 * time.Second):
		t.Fatal("bob's event stream kept its old reach after being added")
	}
}

func TestInviteCanCarryAWorkspaceTheAdminOwns(t *testing.T) {
	f := newIsolationFixture(t)
	if got := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/invites",
		`{"role":"member","workspaceId":"ws_bob","workspaceRole":"viewer"}`)).Code; got != http.StatusNotFound {
		t.Errorf("admin invites into a workspace it cannot see: %d, want 404", got)
	}
	created := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/invites",
		`{"role":"member","workspaceId":"ws_alice","workspaceRole":"maintainer"}`))
	expectStatus(t, created, http.StatusCreated, "invite with a workspace")
	var invite struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(created.Body.Bytes(), &invite)
	preview := doAuthCall(t, f.handler, authCall{method: http.MethodGet, path: "/api/auth/invites/" + invite.Token})
	if !strings.Contains(preview.Body.String(), `"workspaceRole":"maintainer"`) {
		t.Errorf("preview must name the workspace grant: %s", preview.Body.String())
	}
	accepted := doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/auth/invites/" + invite.Token + "/accept",
		body: `{"username":"carol","password":"carol password 1"}`, origin: accountsTestOrigin})
	expectStatus(t, accepted, http.StatusCreated, "carol joins")
	carol := sessionCookieFrom(t, accepted).Value
	var workspaces []store.WorkspaceProjection
	_ = json.Unmarshal(doAuthCall(t, f.handler, f.as(carol, http.MethodGet, "/api/workspaces", "")).Body.Bytes(), &workspaces)
	if len(workspaces) != 1 || workspaces[0].ID != "ws_alice" || workspaces[0].AccessRole != store.WorkspaceRoleMaintainer {
		t.Fatalf("carol's workspaces = %+v", workspaces)
	}
}
