package sqlitestore

import (
	"context"
	"errors"
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
