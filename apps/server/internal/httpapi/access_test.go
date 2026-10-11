package httpapi

import (
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestEventSubscriptionsOnlyReceiveVisibleWorkspaces(t *testing.T) {
	scope := accessScope{roles: map[string]string{"ws_mine": store.WorkspaceRoleViewer}}
	subscription := streamReach{scope: &scope}
	if !subscription.Receives("ws_mine") {
		t.Fatal("an event of a visible workspace must be delivered")
	}
	if subscription.Receives("ws_other") {
		t.Fatal("an event of another workspace must be dropped")
	}
	if subscription.Receives("") {
		t.Fatal("an event without a workspace must be dropped")
	}
	if (streamReach{}).Receives("ws_mine") {
		t.Fatal("an unauthenticated subscription must receive nothing")
	}
	agent := streamReach{workspace: "ws_agent"}
	if !agent.Receives("ws_agent") || agent.Receives("ws_mine") {
		t.Fatal("agent subscriptions stay on their own workspace")
	}
	if !(streamReach{scope: &accessScope{all: true}}).Receives("") {
		t.Fatal("an event of no workspace must reach those who see every workspace")
	}
}

func TestRoleOrder(t *testing.T) {
	cases := []struct {
		have, need string
		ok         bool
	}{
		{store.WorkspaceRoleOwner, store.WorkspaceRoleMaintainer, true},
		{store.WorkspaceRoleMaintainer, store.WorkspaceRoleMember, true},
		{store.WorkspaceRoleMember, store.WorkspaceRoleMaintainer, false},
		{store.WorkspaceRoleViewer, store.WorkspaceRoleMember, false},
		{"", store.WorkspaceRoleViewer, false},
		{store.WorkspaceRoleOwner, "unknown", false},
	}
	for _, c := range cases {
		if roleAtLeast(c.have, c.need) != c.ok {
			t.Errorf("roleAtLeast(%q, %q) != %v", c.have, c.need, c.ok)
		}
	}
}

// Evidence updates reach the viewers of the Issue's workspace; they used to be
// published without a workspace and were dropped for every signed-in viewer.
func TestEvidenceUpdatesReachTheIssueWorkspace(t *testing.T) {
	server := NewServer(newTestStore(t))
	scope := accessScope{roles: map[string]string{"ws_mine": store.WorkspaceRoleViewer}}
	viewer := subscribeReachForTest(server.stream, streamReach{scope: &scope})
	server.issues.evidenceChanged(store.Issue{ID: "iss_1", WorkspaceID: "ws_mine"}, "verify_1", 2, "passed")
	server.issues.evidenceChanged(store.Issue{ID: "iss_2", WorkspaceID: "ws_other"}, "verify_2", 1, "passed")
	if len(viewer.C) != 1 {
		t.Fatalf("viewer received %d evidence updates, want exactly its workspace's one", len(viewer.C))
	}
}

// A device registered without a workspace has no workspace's viewers to
// reach: its status goes to those who see every workspace, not to everyone.
func TestDeviceStatusWithoutAWorkspaceReachesOnlyThoseWhoSeeEveryWorkspace(t *testing.T) {
	events := newNotifiersForTest(nil)
	admin := subscribeReachForTest(events.stream, streamReach{scope: &accessScope{all: true}})
	member := subscribeReachForTest(events.stream, streamReach{scope: &accessScope{roles: map[string]string{"ws_a": store.WorkspaceRoleOwner}}})
	events.devices.registrationChanged(store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_alone", Status: "connected"}})
	if len(admin.C) != 1 || len(member.C) != 0 {
		t.Fatalf("delivered admin %d, member %d; want 1, 0", len(admin.C), len(member.C))
	}
}
