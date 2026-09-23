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
