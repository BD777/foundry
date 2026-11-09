package httpapi

import (
	"context"
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

	var listed personalAgentConnectorsView
	f.call(f.alice, http.MethodGet, "/api/personal-agent/connectors", "", http.StatusOK, "list connectors", &listed)
	enabled := map[string]bool{}
	for _, connector := range listed.Connectors {
		enabled[connector.ID] = connector.Enabled
	}
	if got, ok := enabled[account.ID]; !ok || !got {
		t.Fatalf("server-held account not enabled: %+v", listed.Connectors)
	}

	var updated personalAgentConnectorsView
	f.call(f.alice, http.MethodPut, "/api/personal-agent/connectors",
		`{"disabled":["`+account.ID+`"]}`, http.StatusOK, "disable connectors", &updated)
	for _, connector := range updated.Connectors {
		if connector.Enabled {
			t.Fatalf("connector still enabled: %+v", connector)
		}
	}
	var roundTrip personalAgentConnectorsView
	f.call(f.alice, http.MethodGet, "/api/personal-agent/connectors", "", http.StatusOK, "list disabled connectors", &roundTrip)
	for _, connector := range roundTrip.Connectors {
		if connector.Enabled {
			t.Fatalf("connector re-enabled: %+v", connector)
		}
	}
	agent, err := f.db.GetPersonalAgent(ctx, f.aliceID)
	if err != nil || len(agent.ConnectorOptOut) != 1 {
		t.Fatalf("stored opt-out = %+v (%v)", agent.ConnectorOptOut, err)
	}
}
