package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestPersonalAgentConnectorsRoundTrip(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	if err := f.db.SetWorkspaceKind(ctx, "ws_alice", store.WorkspaceKindPersonalAgent); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: f.aliceID, WorkspaceID: "ws_alice", HomeDeviceID: f.aliceDevice}); err != nil {
		t.Fatal(err)
	}
	app := f.createApp(f.alice, "")
	account := f.connect(f.alice, app)

	var listed store.PersonalAgentConnectorsView
	f.call(f.alice, http.MethodGet, "/api/personal-agent/connectors", "", http.StatusOK, "list connectors", &listed)
	enabled := map[string]bool{}
	levels := map[string]string{}
	for _, connector := range listed.Connectors {
		enabled[connector.ID] = connector.Enabled
		levels[connector.ID] = connector.Level
	}
	if got, ok := enabled[account.ID]; !ok || !got || levels[account.ID] != store.ConnectorAccessLevelWrite {
		t.Fatalf("server-held account not enabled: %+v", listed.Connectors)
	}

	var readOnly store.PersonalAgentConnectorsView
	f.call(f.alice, http.MethodPut, "/api/personal-agent/connectors",
		`{"levels":[{"accountId":"`+account.ID+`","level":"read"}]}`, http.StatusOK, "set connector read-only", &readOnly)
	for _, connector := range readOnly.Connectors {
		if connector.Level != store.ConnectorAccessLevelRead || !connector.Enabled {
			t.Fatalf("connector read-only = %+v", connector)
		}
	}
	var updated store.PersonalAgentConnectorsView
	f.call(f.alice, http.MethodPut, "/api/personal-agent/connectors",
		`{"disabled":["`+account.ID+`"]}`, http.StatusOK, "disable connectors", &updated)
	for _, connector := range updated.Connectors {
		if connector.Enabled {
			t.Fatalf("connector still enabled: %+v", connector)
		}
	}
	var roundTrip store.PersonalAgentConnectorsView
	f.call(f.alice, http.MethodGet, "/api/personal-agent/connectors", "", http.StatusOK, "list disabled connectors", &roundTrip)
	for _, connector := range roundTrip.Connectors {
		if connector.Enabled {
			t.Fatalf("connector re-enabled: %+v", connector)
		}
	}
	agent, err := f.db.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	pkg, err := f.db.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil || len(pkg.ConnectorAccounts) != 1 || pkg.ConnectorAccounts[0].Level != store.ConnectorAccessLevelOff {
		t.Fatalf("stored connector levels = %+v (%v)", pkg.ConnectorAccounts, err)
	}
}

func TestPersonalAgentPermissionPackageRoundTrip(t *testing.T) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	if err := f.db.SetWorkspaceKind(ctx, "ws_alice", store.WorkspaceKindPersonalAgent); err != nil {
		t.Fatal(err)
	}
	agent, err := f.db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: f.aliceID, WorkspaceID: "ws_alice", HomeDeviceID: f.aliceDevice})
	if err != nil {
		t.Fatal(err)
	}
	var pkg store.PermissionPackage
	f.call(f.alice, http.MethodGet, "/api/personal-agent/permission-package", "", http.StatusOK, "read permission package", &pkg)
	if pkg.ID != agent.PermissionPackageID || pkg.Owner != f.aliceID || len(pkg.Workspaces.Include) != 0 {
		t.Fatalf("default package = %+v", pkg)
	}
	pkg.Workspaces.Include = []string{"ws_alice"}
	pkg.ConnectorAccounts = []store.ConnectorAccountPermission{{AccountID: "acct_a", Level: store.ConnectorAccessLevelRead}}
	body, _ := json.Marshal(pkg)
	var saved store.PermissionPackage
	f.call(f.alice, http.MethodPut, "/api/personal-agent/permission-package", string(body), http.StatusOK, "save permission package", &saved)
	if len(saved.Workspaces.Include) != 1 || saved.Workspaces.Include[0] != "ws_alice" ||
		len(saved.ConnectorAccounts) != 1 || saved.ConnectorAccounts[0].Level != store.ConnectorAccessLevelRead {
		t.Fatalf("saved package = %+v", saved)
	}
}
