package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The person's own pending items (DEV-125): an account to authorize again
// and a device's expired sign-in open once per episode, only for their
// owner, stay as the person left them, and resolve once fixed.
func TestPendingItemsForAccountsAndExpiredSignIns(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	backing := f.server.store
	list := func(cookie string) pendingItemList {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(cookie, http.MethodGet, "/api/pending-items", ""))
		expectStatus(t, recorder, http.StatusOK, "list pending items")
		var items pendingItemList
		if err := json.Unmarshal(recorder.Body.Bytes(), &items); err != nil {
			t.Fatal(err)
		}
		return items
	}
	find := func(items pendingItemList, source string) []pendingItemView {
		found := []pendingItemView{}
		for _, item := range items.Items {
			if item.Source == source {
				found = append(found, item)
			}
		}
		return found
	}

	app, err := backing.CreateExternalProviderApp(ctx, store.ExternalProviderApp{ID: "fs-app", Provider: "feishu", OwnerUserID: f.aliceID, ClientID: "fixture-public", CreatedVia: "dynamic_registration"})
	if err != nil {
		t.Fatal(err)
	}
	account, err := backing.SaveExternalAccount(ctx, store.ExternalAccount{ID: "fs-account", AppID: app.ID, Provider: "feishu", OwnerUserID: f.aliceID, Label: "Alice Feishu",
		Mode: store.ExternalCredentialServerHeld, Status: store.ExternalAccountNeedsReauth, StatusDetail: "refresh_token_expired", Subject: "ou_alice"})
	if err != nil {
		t.Fatal(err)
	}
	reportCorpExtension(t, f)
	expired := store.DeviceConnectorState{DeviceID: "dev_alice", Kind: "corpcli", Status: store.DeviceConnectorReady, Installed: true, SignedIn: true,
		Identity: "alice@corp", ExpiresAt: time.Now().Add(-time.Hour).UTC().Format(time.RFC3339), CheckedAt: time.Now().UTC().Format(time.RFC3339)}
	if err := backing.SaveDeviceConnectorState(ctx, expired); err != nil {
		t.Fatal(err)
	}

	items := list(f.alice)
	accounts, connectors := find(items, store.PendingSourceAccount), find(items, store.PendingSourceConnector)
	if len(accounts) != 1 || accounts[0].Title != "Alice Feishu" || accounts[0].Rule != "feishu" || accounts[0].State != store.PendingOpen || accounts[0].SessionID != "" {
		t.Fatalf("account items = %+v", accounts)
	}
	if len(connectors) != 1 || connectors[0].Rule != "corpcli" || connectors[0].State != store.PendingOpen || connectors[0].Excerpt != "alice@corp" {
		t.Fatalf("connector items = %+v", connectors)
	}
	if items.Open != 2 || len(items.BySession) != 0 {
		t.Fatalf("counts = %d %+v", items.Open, items.BySession)
	}
	// Read again: the same episode is the same item, seen once.
	if again := find(list(f.alice), store.PendingSourceAccount); len(again) != 1 || again[0].Occurrences != 1 || again[0].ID != accounts[0].ID {
		t.Fatalf("account items read again = %+v", again)
	}
	// Bob owns neither.
	if other := list(f.bob); len(find(other, store.PendingSourceAccount))+len(find(other, store.PendingSourceConnector)) != 0 {
		t.Fatalf("bob sees %+v", other.Items)
	}

	// Dismissed stays dismissed while the episode lasts.
	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/pending-items/"+connectors[0].ID+"/state", `{"state":"dismissed"}`))
	expectStatus(t, recorder, http.StatusOK, "dismiss the connector item")
	if got := find(list(f.alice), store.PendingSourceConnector); len(got) != 1 || got[0].State != store.PendingDismissed {
		t.Fatalf("dismissed connector item = %+v", got)
	}

	// Fixed: the account is authorized again, the sign-in renewed.
	account.Status, account.StatusDetail = store.ExternalAccountReady, ""
	account.RefreshExpiresAt = time.Now().Add(30 * 24 * time.Hour).UTC().Format(time.RFC3339)
	if _, err := backing.SaveExternalAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	if got := find(list(f.alice), store.PendingSourceAccount); len(got) != 1 || got[0].State != store.PendingSuperseded {
		t.Fatalf("account item once fixed = %+v", got)
	}

	// A new episode (the sign-in expired again later) opens a new item.
	expired.ExpiresAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	if err := backing.SaveDeviceConnectorState(ctx, expired); err != nil {
		t.Fatal(err)
	}
	got := find(list(f.alice), store.PendingSourceConnector)
	open := 0
	for _, item := range got {
		if item.State == store.PendingOpen {
			open++
		}
	}
	if open != 1 || len(got) != 2 {
		t.Fatalf("connector items after a new expiry = %+v", got)
	}
}
