package sqlitestore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The apps that existed when the gateway arrived had their secret sent to
// devices: they are listed once, at that migration, and never again.
func TestFeishuGatewayListsAppsToRotateOnce(t *testing.T) {
	ctx := context.Background()
	path := t.TempDir() + "/foundry.db"
	db := openTestStore(t, path)
	app, err := db.CreateExternalProviderApp(ctx, store.ExternalProviderApp{Provider: "feishu", OwnerUserID: "u", Label: "Old", ClientID: "cli_old"})
	if err != nil {
		t.Fatal(err)
	}
	if apps, _ := db.FeishuAppsToRotate(ctx); len(apps) != 0 {
		t.Fatalf("an app created after the gateway is listed: %v", apps)
	}
	// As if the database predated the gateway.
	if _, err := db.conn().ExecContext(ctx, `DROP TABLE feishu_gateway_rotate_apps`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	db = newTestStoreAtPath(t, path)
	apps, err := db.FeishuAppsToRotate(ctx)
	if err != nil || apps[app.ID] == "" || len(apps) != 1 {
		t.Fatalf("apps to rotate after the migration: %v %v", apps, err)
	}
	if err := db.ClearFeishuAppRotation(ctx, app.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateExternalProviderApp(ctx, store.ExternalProviderApp{Provider: "feishu", OwnerUserID: "u", Label: "New", ClientID: "cli_new"}); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	db = newTestStoreAtPath(t, path)
	if apps, _ := db.FeishuAppsToRotate(ctx); len(apps) != 0 {
		t.Fatalf("a restart listed apps again: %v", apps)
	}
}

func TestFeishuGatewayGrantsAndAudit(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	grant := store.FeishuGatewayGrant{SessionID: "sess_gone", AccountID: "xacc_1", AppID: "xapp_1", DeviceID: "dev_1", WorkspaceID: "ws_1", UserID: "u", AppHash: "a1", UserHash: "u1", TenantHash: "t1"}
	if err := db.CreateFeishuGatewayGrant(ctx, grant); err != nil {
		t.Fatal(err)
	}
	for kind, hash := range map[string]string{store.FeishuHandleApp: "a1", store.FeishuHandleUser: "u1", store.FeishuHandleTenant: "t1"} {
		found, err := db.FindFeishuGatewayGrant(ctx, kind, hash)
		if err != nil || found.SessionID != "sess_gone" || found.ID == "" {
			t.Fatalf("find %s: %+v %v", kind, found, err)
		}
	}
	if _, err := db.FindFeishuGatewayGrant(ctx, store.FeishuHandleUser, "a1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a hash matched another kind: %v", err)
	}
	// The session does not exist (or ended): pruned.
	if removed, err := db.PruneFeishuGatewayGrants(ctx); err != nil || removed != 1 {
		t.Fatalf("prune grants: %d %v", removed, err)
	}
	old := store.FeishuGatewayRequest{At: time.Now().Add(-40 * 24 * time.Hour).UTC().Format(time.RFC3339Nano), UserID: "u", Method: "GET", Path: "/open-apis/x", Status: 200, Outcome: "forwarded"}
	recent := old
	recent.At = time.Now().UTC().Format(time.RFC3339Nano)
	recent.SessionID = "sess_1"
	for _, line := range []store.FeishuGatewayRequest{old, recent} {
		if err := db.AppendFeishuGatewayRequest(ctx, line); err != nil {
			t.Fatal(err)
		}
	}
	if lines, _ := db.ListFeishuGatewayRequests(ctx, store.FeishuGatewayRequestFilter{UserID: "u"}); len(lines) != 2 || lines[0].SessionID != "sess_1" {
		t.Fatalf("audit newest first: %+v", lines)
	}
	if lines, _ := db.ListFeishuGatewayRequests(ctx, store.FeishuGatewayRequestFilter{UserID: "other"}); len(lines) != 0 {
		t.Fatalf("another person's audit: %+v", lines)
	}
	if removed, _ := db.PruneFeishuGatewayRequests(ctx, time.Now().Add(-30*24*time.Hour)); removed != 1 {
		t.Fatalf("pruned %d old lines, want 1", removed)
	}
}
