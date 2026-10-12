package sqlitestore

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func insertTestWorkspace(t *testing.T, s *Store, id string) {
	t.Helper()
	if _, err := s.conn().ExecContext(context.Background(), `INSERT INTO workspaces (id, name, local_path, baseline, context_summary, accepted_count, resolved_count, payload_json, updated_at)
		VALUES (?, ?, '/path/'||?, 'main', '', 0, 0, '{}', '2026-01-01T00:00:00Z')`, id, "Workspace "+id, id); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
}

func createFeishuApp(t *testing.T, s *Store, clientID, owner string) store.ExternalProviderApp {
	t.Helper()
	app, err := s.CreateExternalProviderApp(context.Background(), store.ExternalProviderApp{
		Provider: "feishu", OwnerUserID: owner, Label: "App " + clientID, ClientID: clientID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return app
}

func pairChat(t *testing.T, s *Store, workspaceID, chatID, code string, kind store.FeishuRouteKind) (store.FeishuBotRoute, error) {
	t.Helper()
	ctx := context.Background()
	pairing, err := s.SetFeishuPairingCode(ctx, workspaceID, code, "u_"+workspaceID, time.Now().Add(time.Minute).UTC().Format(time.RFC3339))
	if err != nil {
		t.Fatal(err)
	}
	return s.BindFeishuChat(ctx, pairing, store.FeishuBotRoute{Kind: kind, ChatID: chatID, ChatName: "Chat " + chatID, BoundUserID: pairing.PairingCodeCreatedBy})
}

// A bot is a Connectors app plus routes: one pairing route per workspace,
// a chat routes to one workspace per Feishu app, and a pairing code is
// spent once.
func TestFeishuBotRoutes(t *testing.T) {
	ctx := context.Background()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, id := range []string{"ws_a", "ws_b"} {
		insertTestWorkspace(t, s, id)
	}
	shared := createFeishuApp(t, s, "cli_shared", "u_1")
	sameFeishuApp := createFeishuApp(t, s, "cli_shared", "u_2")
	other := createFeishuApp(t, s, "cli_other", "u_1")

	if _, err := s.SetFeishuPairingCode(ctx, "ws_a", "hash", "u_1", ""); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a code for a workspace without a bot: %v, want not found", err)
	}
	if err := s.SetWorkspaceFeishuBotApp(ctx, "ws_a", "xapp_missing"); !errors.Is(err, store.ErrExternalAppNotFound) {
		t.Fatalf("an unknown app: %v", err)
	}
	for _, workspace := range []string{"ws_a", "ws_b"} {
		if err := s.SetWorkspaceFeishuBotApp(ctx, workspace, shared.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.SetWorkspaceFeishuBotApp(ctx, "ws_a", shared.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pairChat(t, s, "ws_a", "oc_1", "code_a", store.FeishuRouteChat); err != nil {
		t.Fatal(err)
	}
	if _, err := pairChat(t, s, "ws_b", "oc_dm", "code_b", store.FeishuRouteP2P); err != nil {
		t.Fatal(err)
	}
	route, err := s.FindFeishuChatRoute(ctx, "cli_shared", "oc_1")
	if err != nil || route.WorkspaceID != "ws_a" || route.Kind != store.FeishuRouteChat || route.BoundUserID != "u_ws_a" {
		t.Fatalf("oc_1 routes to %+v %v", route, err)
	}
	if _, err := s.FindFeishuChatRoute(ctx, "cli_other", "oc_1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("oc_1 on another Feishu app: %v", err)
	}
	// A spent code binds nothing.
	pairing, err := s.SetFeishuPairingCode(ctx, "ws_b", "code_b2", "u_b", time.Now().Add(time.Minute).UTC().Format(time.RFC3339))
	if err != nil {
		t.Fatal(err)
	}
	found, err := s.FindFeishuPairingRoute(ctx, "cli_shared", "code_b2")
	if err != nil || found.ID != pairing.ID {
		t.Fatalf("find the code: %+v %v", found, err)
	}
	if _, err := s.FindFeishuPairingRoute(ctx, "cli_other", "code_b2"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("the code on another Feishu app: %v", err)
	}
	// Pairing oc_1 with ws_b moves it there.
	if _, err := s.BindFeishuChat(ctx, found, store.FeishuBotRoute{Kind: store.FeishuRouteChat, ChatID: "oc_1", BoundUserID: "u_b"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BindFeishuChat(ctx, found, store.FeishuBotRoute{Kind: store.FeishuRouteChat, ChatID: "oc_2"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a spent code bound again: %v", err)
	}
	if route, _ := s.FindFeishuChatRoute(ctx, "cli_shared", "oc_1"); route.WorkspaceID != "ws_b" {
		t.Fatalf("oc_1 routes to %q after pairing with ws_b", route.WorkspaceID)
	}
	if routes, _ := s.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{WorkspaceID: "ws_b"}); len(routes) != 3 || routes[0].Kind != store.FeishuRoutePairing {
		t.Fatalf("ws_b routes = %+v, want its pairing route first, then two chats", routes)
	}

	// Another record of the same Feishu app keeps the chats; another
	// Feishu app unbinds them.
	if err := s.SetWorkspaceFeishuBotApp(ctx, "ws_b", sameFeishuApp.ID); err != nil {
		t.Fatal(err)
	}
	if routes, _ := s.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{WorkspaceID: "ws_b"}); len(routes) != 3 || routes[1].AppID != sameFeishuApp.ID {
		t.Fatalf("after moving to the same Feishu app: %+v", routes)
	}
	if err := s.SetWorkspaceFeishuBotApp(ctx, "ws_b", other.ID); err != nil {
		t.Fatal(err)
	}
	if routes, _ := s.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{WorkspaceID: "ws_b"}); len(routes) != 1 || routes[0].AppID != other.ID {
		t.Fatalf("after moving to another Feishu app: %+v", routes)
	}

	routes, _ := s.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{AppID: shared.ID})
	if len(routes) != 1 || routes[0].WorkspaceID != "ws_a" {
		t.Fatalf("routes of the shared app = %+v", routes)
	}
	if _, err := pairChat(t, s, "ws_a", "oc_3", "code_a3", store.FeishuRouteChat); err != nil {
		t.Fatal(err)
	}
	chat, _ := s.FindFeishuChatRoute(ctx, "cli_shared", "oc_3")
	if err := s.DeleteFeishuBotRoute(ctx, "ws_b", chat.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another workspace unbound the chat: %v", err)
	}
	if err := s.DeleteFeishuBotRoute(ctx, "ws_a", routes[0].ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("the pairing route was deleted as a chat: %v", err)
	}
	if err := s.DeleteFeishuBotRoute(ctx, "ws_a", chat.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteWorkspaceFeishuBot(ctx, "ws_a"); err != nil {
		t.Fatal(err)
	}
	if routes, _ := s.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{WorkspaceID: "ws_a"}); len(routes) != 0 {
		t.Fatalf("ws_a routes after removing its bot: %+v", routes)
	}

	// Threads are unchanged.
	thread := store.FeishuChatThread{RootMessageID: "om_root", WorkspaceID: "ws_a", ChatID: "oc_1", LatestSessionID: "sess_1", CardMessageID: "om_card"}
	if err := s.SaveFeishuChatThread(ctx, thread); err != nil {
		t.Fatal(err)
	}
	if saved, err := s.GetFeishuChatThread(ctx, "om_root"); err != nil || saved.LatestSessionID != "sess_1" {
		t.Fatalf("thread = %+v %v", saved, err)
	}
}

// An event id is new once per app inside the window.
func TestFeishuEventReceipts(t *testing.T) {
	ctx := context.Background()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now()
	for _, step := range []struct {
		app, event string
		at         time.Time
		first      bool
	}{
		{"cli_a", "ev_1", now, true},
		{"cli_a", "ev_1", now.Add(time.Minute), false},
		{"cli_b", "ev_1", now.Add(time.Minute), true},
		{"cli_a", "", now, true},
		{"cli_a", "", now, true},
		// The first receipt expired.
		{"cli_a", "ev_1", now.Add(25 * time.Hour), true},
	} {
		first, err := s.RecordFeishuEvent(ctx, step.app, step.event, step.at, 24*time.Hour)
		if err != nil || first != step.first {
			t.Fatalf("%s/%s at %s: first = %t %v, want %t", step.app, step.event, step.at, first, err, step.first)
		}
	}
	var kept int
	if err := s.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM feishu_event_receipts`).Scan(&kept); err != nil || kept != 1 {
		t.Fatalf("%d receipts kept, want the expired ones gone: %v", kept, err)
	}
}

// legacyBotRow is a workspace bot of before the move onto Connectors apps.
type legacyBotRow struct {
	workspace, app, chat, code, creator, bound, updated, secret string
}

func seedLegacyBots(t *testing.T, s *Store, rows []legacyBotRow) {
	t.Helper()
	ctx := context.Background()
	if _, err := s.conn().ExecContext(ctx, `CREATE TABLE workspace_feishu_bots (
		workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
		app_id TEXT NOT NULL, chat_id TEXT NOT NULL DEFAULT '', chat_name TEXT NOT NULL DEFAULT '',
		pairing_code TEXT NOT NULL DEFAULT '', pairing_code_expires_at TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL DEFAULT 'unconfigured', status_detail TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		insertTestWorkspace(t, s, row.workspace)
		if _, err := s.conn().ExecContext(ctx, `INSERT INTO workspace_feishu_bots (workspace_id, app_id, chat_id, chat_name, pairing_code, pairing_code_expires_at, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, '2026-01-01T00:10:00Z', 'connected', ?, ?)`, row.workspace, row.app, row.chat, "Group "+row.chat, row.code, row.updated, row.updated); err != nil {
			t.Fatal(err)
		}
		if row.secret != "" {
			if err := s.PutSecret(ctx, legacyBotSecretPrefix+row.workspace, []byte(row.secret), "feishu-app-secret"); err != nil {
				t.Fatal(err)
			}
		}
	}
	// The columns later versions added.
	for _, column := range []string{"pairing_code_created_by", "bound_user_id"} {
		if _, err := s.conn().ExecContext(ctx, `ALTER TABLE workspace_feishu_bots ADD COLUMN `+column+` TEXT NOT NULL DEFAULT ''`); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range rows {
		if _, err := s.conn().ExecContext(ctx, `UPDATE workspace_feishu_bots SET pairing_code_created_by = ?, bound_user_id = ? WHERE workspace_id = ?`,
			row.creator, row.bound, row.workspace); err != nil {
			t.Fatal(err)
		}
	}
}

// The bots of before move onto Connectors apps: one app per Feishu app id
// (an existing Connectors app of it when there is one), the newest secret
// resealed under it, the app marked for rotation, each workspace's pairing
// route with its pending code and its bound chat. Opening again changes
// nothing.
func TestWorkspaceFeishuBotsMoveOntoConnectorsApps(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	options := Options{SecretKeyPath: filepath.Join(dir, "foundry-secret.key")}
	path := filepath.Join(dir, "foundry.db")
	s, err := OpenWithOptions(path, options)
	if err != nil {
		t.Fatal(err)
	}
	existing := createFeishuApp(t, s, "cli_known", "u_known")
	if err := s.PutSecret(ctx, externalAppSecretPrefix+existing.ID, []byte("connectors-secret"), externalAppSecretPrefix+existing.ID); err != nil {
		t.Fatal(err)
	}
	seedLegacyBots(t, s, []legacyBotRow{
		{workspace: "ws_old", app: "cli_shared", chat: "oc_old", bound: "u_old", updated: "2026-01-01T00:00:00Z", secret: "old-secret"},
		{workspace: "ws_new", app: "cli_shared", chat: "oc_new", code: "hash_new", creator: "u_new", bound: "u_new", updated: "2026-02-01T00:00:00Z", secret: "new-secret"},
		{workspace: "ws_known", app: "cli_known", updated: "2026-01-15T00:00:00Z", secret: "bot-secret"},
		{workspace: "ws_never", app: "", code: "hash_never", creator: "u_never", updated: "2026-01-20T00:00:00Z"},
	})
	if err := s.SaveFeishuChatThread(ctx, store.FeishuChatThread{RootMessageID: "om_topic", WorkspaceID: "ws_old", ChatID: "oc_old", LatestSessionID: "sess_1"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	for run := range 2 {
		s, err = OpenWithOptions(path, options)
		if err != nil {
			t.Fatalf("open %d: %v", run, err)
		}
		shared, err := s.FeishuProviderAppsByClientID(ctx, "cli_shared")
		if err != nil || len(shared) != 1 {
			t.Fatalf("run %d: apps of cli_shared = %+v %v, want one", run, shared, err)
		}
		app := shared[0]
		if app.CreatedVia != "migrated_bot" || app.OwnerUserID != "u_new" || app.Visibility != store.ExternalAppPersonal {
			t.Fatalf("run %d: migrated app = %+v", run, app)
		}
		if secret, err := s.GetSecret(ctx, externalAppSecretPrefix+app.ID); err != nil || string(secret) != "new-secret" {
			t.Fatalf("run %d: the app's secret = %q %v, want the newest bot's", run, secret, err)
		}
		if known, _ := s.FeishuProviderAppsByClientID(ctx, "cli_known"); len(known) != 1 || known[0].ID != existing.ID {
			t.Fatalf("run %d: cli_known apps = %+v, want the existing Connectors app only", run, known)
		}
		if secret, _ := s.GetSecret(ctx, externalAppSecretPrefix+existing.ID); string(secret) != "connectors-secret" {
			t.Fatalf("run %d: the Connectors app's own secret was replaced: %q", run, secret)
		}
		rotate, err := s.FeishuAppsToRotate(ctx)
		if _, marked := rotate[app.ID]; err != nil || !marked {
			t.Fatalf("run %d: rotation list = %v %v, want the migrated app", run, rotate, err)
		}
		if _, marked := rotate[existing.ID]; !marked {
			t.Fatalf("run %d: rotation list = %v, want the existing app the bot used", run, rotate)
		}
		for workspace, want := range map[string]struct {
			app, chat, bound, code string
		}{
			"ws_old":   {app.ID, "oc_old", "u_old", ""},
			"ws_new":   {app.ID, "oc_new", "u_new", "hash_new"},
			"ws_known": {existing.ID, "", "", ""},
		} {
			routes, err := s.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{WorkspaceID: workspace})
			chats := 0
			if want.chat != "" {
				chats = 1
			}
			if err != nil || len(routes) != 1+chats || routes[0].Kind != store.FeishuRoutePairing || routes[0].AppID != want.app || routes[0].PairingCode != want.code {
				t.Fatalf("run %d: %s routes = %+v %v", run, workspace, routes, err)
			}
			if chats == 1 && (routes[1].ChatID != want.chat || routes[1].BoundUserID != want.bound || routes[1].Kind != store.FeishuRouteChat || routes[1].ChatName != "Group "+want.chat) {
				t.Fatalf("run %d: %s chat route = %+v", run, workspace, routes[1])
			}
		}
		if routes, _ := s.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{WorkspaceID: "ws_never"}); len(routes) != 0 {
			t.Fatalf("run %d: a bot never set up got routes: %+v", run, routes)
		}
		if route, err := s.FindFeishuChatRoute(ctx, "cli_shared", "oc_old"); err != nil || route.WorkspaceID != "ws_old" {
			t.Fatalf("run %d: oc_old routes to %+v %v", run, route, err)
		}
		if thread, err := s.GetFeishuChatThread(ctx, "om_topic"); err != nil || thread.WorkspaceID != "ws_old" {
			t.Fatalf("run %d: the topic thread = %+v %v", run, thread, err)
		}
		var leftovers int
		if err := s.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE name = 'workspace_feishu_bots'`).Scan(&leftovers); err != nil || leftovers != 0 {
			t.Fatalf("run %d: the old table stayed: %d %v", run, leftovers, err)
		}
		if err := s.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM secret_records WHERE id LIKE 'feishu:app_secret:%'`).Scan(&leftovers); err != nil || leftovers != 0 {
			t.Fatalf("run %d: %d old bot secrets stayed: %v", run, leftovers, err)
		}
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

// Without a secret store the bots of before wait: their secrets are sealed.
func TestWorkspaceFeishuBotsWaitForTheSecretStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "foundry.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	seedLegacyBots(t, s, []legacyBotRow{{workspace: "ws_1", app: "cli_x", chat: "oc_1", updated: "2026-01-01T00:00:00Z"}})
	s.Close()
	if s, err = Open(path); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var rows int
	if err := s.conn().QueryRowContext(context.Background(), `SELECT COUNT(*) FROM workspace_feishu_bots`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("old rows = %d %v, want them kept", rows, err)
	}
}
