package httpapi

import (
	"cmp"
	"context"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// reconcilePersonalPending brings the person's own pending items (DEV-125)
// up to what Foundry knows now: a connected account that needs authorizing
// again, a device-held connector whose sign-in expired on one of the
// person's devices. Their status can change with the clock alone, so they
// are read when the list is: an item opens once per episode (its expiry),
// and resolves as superseded once the account or sign-in is good again.
// listed is what the list holds now; it reports whether anything changed.
func (s *Server) reconcilePersonalPending(ctx context.Context, userID string, listed []store.PendingItem) bool {
	if s.connectors == nil {
		return false
	}
	open := map[string]bool{}
	// seen: episodes already listed, open or resolved: one the person marked
	// done or dismissed stays so, without a write on every read.
	seen := map[string]bool{}
	for _, item := range listed {
		if !store.PendingPersonal(item.Source) {
			continue
		}
		seen[item.Key+"\x00"+item.EventID] = true
		if item.State == store.PendingOpen {
			open[item.Key] = true
		}
	}
	changed := false
	settle := func(item store.PendingItem, needsPerson bool) {
		isOpen := open[item.Key]
		switch {
		case needsPerson && !seen[item.Key+"\x00"+item.EventID]:
			item.UserID = userID
			if _, recorded, err := s.store.RecordPendingItem(ctx, item); err == nil {
				changed = changed || recorded
			} else {
				s.connectors.ServerHeld.Logf("pending %s: %v", item.Key, err)
			}
		case !needsPerson && isOpen:
			if resolved, err := s.store.ResolvePendingItems(ctx, store.PendingResolution{Key: item.Key, State: store.PendingSuperseded}); err == nil {
				changed = changed || resolved > 0
			}
		}
	}
	if accounts, err := s.connectors.ServerHeld.Accounts(ctx, userID); err == nil {
		for _, account := range accounts {
			key := "account:" + account.ID
			settle(store.PendingItem{
				Source:  store.PendingSourceAccount,
				Rule:    account.Provider,
				Key:     key,
				EventID: strings.Join([]string{key, account.StatusDetail, account.AuthExpiresAt, account.RefreshExpiresAt}, "|"),
				Title:   cmp.Or(account.Label, account.DisplayName, account.AppName, account.Provider),
				Excerpt: account.StatusDetail,
			}, account.Status == store.ExternalAccountNeedsReauth)
		}
	}
	devices, err := s.ownDevices(ctx, userID)
	if err != nil || len(devices) == 0 {
		return changed
	}
	ids := make([]string, 0, len(devices))
	names := map[string]string{}
	for _, device := range devices {
		ids = append(ids, device.ID)
		names[device.ID] = device.Label
	}
	states, err := s.connectors.Devices.States(ctx, ids)
	if err != nil {
		return changed
	}
	for _, state := range states {
		key := "connector:" + state.DeviceID + ":" + state.Kind
		label := state.Kind
		if descriptor, err := s.connectors.Devices.ConnectorOn(ctx, state.DeviceID, state.Kind); err == nil && descriptor.Label != "" {
			label = descriptor.Label
		}
		settle(store.PendingItem{
			Source:  store.PendingSourceConnector,
			Rule:    state.Kind,
			Key:     key,
			EventID: key + "|" + state.ExpiresAt,
			Title:   label + " · " + names[state.DeviceID],
			Excerpt: state.Identity,
		}, state.Status == store.DeviceConnectorExpired)
	}
	return changed
}
