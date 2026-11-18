package feishu

import (
	"context"
	"log"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// groupPeerBackfillTimeout bounds one pass over the bound groups.
const groupPeerBackfillTimeout = 30 * time.Second

// backfillGroupPeersInBackground runs the group backfill for an app that has just
// connected. Each pass only touches routes still without a person, so a pass on
// every connection is harmless.
func (m *WSManager) backfillGroupPeersInBackground(clientID string) {
	app := m.app(clientID)
	if app == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), groupPeerBackfillTimeout)
		defer cancel()
		m.backfillGroupPeers(ctx, app)
	}()
}

// backfillGroupPeers records the person of each group route that was paired
// before the pairing sender's open_id was kept. The person is derived from the
// group's membership now, which is evidence, not the pairing itself: it is taken
// only when the group has exactly one user member, and the derivation is logged
// as such. A group with several users keeps no person, so the bot asks for a
// pairing code in a direct chat instead.
func (m *WSManager) backfillGroupPeers(ctx context.Context, app *botApp) {
	routes, err := m.store.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{})
	if err != nil {
		log.Printf("[feishu] read the routes for the group backfill: %v", err)
		return
	}
	for _, route := range routes {
		if route.Kind != store.FeishuRouteChat || route.BoundUserID == "" || route.PeerOpenID != "" {
			continue
		}
		providerApp, err := m.store.GetExternalProviderApp(ctx, route.AppID)
		if err != nil || providerApp.ClientID != app.clientID {
			continue
		}
		users, err := app.client.ChatUserOpenIDs(ctx, route.ChatID)
		if err != nil {
			log.Printf("[feishu] group route %s: list its members: %v", route.ID, err)
			continue
		}
		if len(users) != 1 {
			log.Printf("[feishu] group route %s has %d user members: its person is not derived", route.ID, len(users))
			continue
		}
		if err := m.store.SetFeishuGroupPeer(ctx, route.ID, users[0]); err != nil {
			log.Printf("[feishu] record the person of group route %s: %v", route.ID, err)
			continue
		}
		log.Printf("[feishu] group route %s: person derived from its single user member (current membership, not the pairing message)", route.ID)
	}
}
