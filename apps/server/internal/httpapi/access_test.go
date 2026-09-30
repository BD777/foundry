package httpapi

import (
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestEventSubscriptionsOnlyReceiveVisibleWorkspaces(t *testing.T) {
	scope := accessScope{roles: map[string]string{"ws_mine": store.WorkspaceRoleViewer}}
	subscription := &eventSubscription{scope: &scope}
	if !subscription.receives("ws_mine") {
		t.Fatal("an event of a visible workspace must be delivered")
	}
	if subscription.receives("ws_other") {
		t.Fatal("an event of another workspace must be dropped")
	}
	if subscription.receives("") {
		t.Fatal("an event without a workspace must be dropped")
	}
	if (&eventSubscription{}).receives("ws_mine") {
		t.Fatal("an unauthenticated subscription must receive nothing")
	}
	agent := &eventSubscription{workspace: "ws_agent"}
	if !agent.receives("ws_agent") || agent.receives("ws_mine") {
		t.Fatal("agent subscriptions stay on their own workspace")
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
	viewer := &eventSubscription{ch: make(chan []byte, 4), scope: &scope, ended: make(chan struct{})}
	server.events.mu.Lock()
	server.events.subscribers[viewer] = struct{}{}
	server.events.mu.Unlock()
	server.publishEvidenceUpdate(store.Issue{ID: "iss_1", WorkspaceID: "ws_mine"}, "verify_1", 2, "passed")
	server.publishEvidenceUpdate(store.Issue{ID: "iss_2", WorkspaceID: "ws_other"}, "verify_2", 1, "passed")
	if len(viewer.ch) != 1 {
		t.Fatalf("viewer received %d evidence updates, want exactly its workspace's one", len(viewer.ch))
	}
}
