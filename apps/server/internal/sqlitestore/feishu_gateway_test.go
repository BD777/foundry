package sqlitestore

import (
	"context"
	"errors"
	"fmt"
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
	if removed, err := db.PruneFeishuGatewayGrants(ctx, time.Now().Add(-24*time.Hour)); err != nil || removed != 1 {
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

// DEV-215: a session's grants stand whatever its turns do; prune drops
// those of sessions archived or deleted, and grants a newer one of the same
// session and account superseded long enough ago.
func TestPruneFeishuGatewayGrantsKeepsEverySessionNotArchived(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	now := time.Now().UTC()
	recent, old := formatTime(now.Add(-time.Hour)), formatTime(now.Add(-25*time.Hour))
	insert := func(id, status, completedAt string) {
		execAll(t, db, `INSERT INTO agent_sessions (id, workspace_id, agent_id, device_id, provider, status, payload_json, created_at, updated_at)
			VALUES ('`+id+`', 'ws_p', 'agent_p', 'dev_p', 'claude', '`+status+`', json_object('completedAt', '`+completedAt+`'), '', '')`)
	}
	insert("sess_running", "running", "")
	insert("sess_recent", "completed", recent)
	insert("sess_old", "completed", old)
	insert("sess_failed", "failed", recent)
	insert("sess_canceled", "canceled", recent)
	insert("sess_archived", "completed", recent)
	insert("sess_deleted", "completed", recent)
	execAll(t, db,
		`INSERT INTO chat_archives (workspace_id, archive_key, archived_at, batch_id) VALUES ('ws_p', 'id:sess_archived', '`+recent+`', 'b1')`,
		`INSERT INTO chat_deletions (workspace_id, deletion_key) VALUES ('ws_p', 'id:sess_deleted')`)
	ids := []string{"sess_running", "sess_recent", "sess_old", "sess_failed", "sess_canceled", "sess_archived", "sess_deleted", "sess_gone",
		"sess_old", "sess_old"}
	for i, id := range ids {
		hash := fmt.Sprint(i)
		if err := db.CreateFeishuGatewayGrant(ctx, store.FeishuGatewayGrant{SessionID: id, AccountID: "xacc_1", AppID: "xapp_1", DeviceID: "dev_p", WorkspaceID: "ws_p", UserID: "u", AppHash: "a" + hash, UserHash: "u" + hash, TenantHash: "t" + hash}); err != nil {
			t.Fatal(err)
		}
	}
	// sess_old's first grant (u2) was superseded two days ago by u8, which a
	// renewal superseded an hour ago by u9: u2 goes, u8 stays for now.
	execAll(t, db,
		`UPDATE feishu_gateway_grants SET created_at = '`+formatTime(now.Add(-72*time.Hour))+`' WHERE user_hash = 'u2'`,
		`UPDATE feishu_gateway_grants SET created_at = '`+formatTime(now.Add(-48*time.Hour))+`' WHERE user_hash = 'u8'`,
		`UPDATE feishu_gateway_grants SET created_at = '`+formatTime(now.Add(-time.Hour))+`' WHERE user_hash = 'u9'`)
	removed, err := db.PruneFeishuGatewayGrants(ctx, now.Add(-24*time.Hour))
	if err != nil || removed != 4 {
		t.Fatalf("prune: removed %d, %v; want 4", removed, err)
	}
	for i, id := range ids {
		_, err := db.FindFeishuGatewayGrant(ctx, store.FeishuHandleUser, "u"+fmt.Sprint(i))
		kept := id != "sess_archived" && id != "sess_deleted" && id != "sess_gone" && i != 2
		if kept != (err == nil) {
			t.Fatalf("%s (u%d): kept = %v (%v), want %v", id, i, err == nil, err, kept)
		}
	}
}
