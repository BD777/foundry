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

// A workspace new on bob's device (one his assistant created, or a folder he
// added) makes him its owner: his open stream ends so his browser reconnects
// with a reach that includes it; a device reporting a workspace it already
// had leaves the stream alone.
func TestNewWorkspaceOnADeviceEndsItsOwnersEventStream(t *testing.T) {
	f := newIsolationFixture(t)
	live := httptest.NewServer(f.handler)
	t.Cleanup(live.Close) // after the streams below close
	open := func() chan struct{} {
		request, _ := http.NewRequest(http.MethodGet, live.URL+"/api/events", nil)
		request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: f.bob})
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { response.Body.Close() })
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
		return ended
	}
	register := func(workspaceID string) {
		expectStatus(t, doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/register",
			registrationBody("dev_bob", workspaceID), f.bobDevice)), http.StatusOK, "register "+workspaceID)
	}

	ended := open()
	register("ws_bob")
	select {
	case <-ended:
		t.Fatal("a report of a workspace bob already had ended his stream")
	case <-time.After(300 * time.Millisecond):
	}
	register("ws_bob_new")
	select {
	case <-ended:
	case <-time.After(3 * time.Second):
		t.Fatal("bob's event stream kept its old reach after a workspace was added to his device")
	}
}

// Added to a workspace, bob's browser reconnects from the last event its old
// stream delivered and is told to resync, so it reads the workspace it can
// now see instead of resuming with its old view.
func TestAccessChangeMakesTheResumingStreamResync(t *testing.T) {
	f := newIsolationFixture(t)
	live := httptest.NewServer(f.handler)
	defer live.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	open := func(lastEventID string) *streamReaderForTest {
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, live.URL+"/api/events", nil)
		request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: f.bob})
		if lastEventID != "" {
			request.Header.Set("Last-Event-ID", lastEventID)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { response.Body.Close() })
		reader := &streamReaderForTest{response: response, frames: make(chan string, 16)}
		go func() {
			scanner := bufio.NewScanner(response.Body)
			var frame strings.Builder
			for scanner.Scan() {
				line := scanner.Text()
				if line == "" && frame.Len() > 0 {
					reader.frames <- frame.String()
					frame.Reset()
				} else if line != "" && !strings.HasPrefix(line, ":") && !strings.HasPrefix(line, "retry:") {
					frame.WriteString(line + "\n")
				}
			}
			close(reader.frames)
		}()
		return reader
	}
	stream := open("")
	chatListNotifierForTest(f.server).titlesStale("ws_bob")
	lastEventID, _ := stream.next(t)
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/workspaces/ws_alice/members", `{"username":"bob","role":"viewer"}`)),
		http.StatusNoContent, "share with bob")
	deadline := time.After(3 * time.Second)
	for ended := false; !ended; {
		select {
		case _, more := <-stream.frames:
			ended = !more
		case <-deadline:
			t.Fatal("bob's old stream did not end")
		}
	}
	_, envelope := open(lastEventID).next(t)
	if envelope["type"] != "resync" || envelope["payload"].(map[string]any)["reason"] != "reauthorized" {
		t.Fatalf("bob's resumed stream began with %v, want a resync", envelope)
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
