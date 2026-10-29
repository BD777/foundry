package httpapi

import (
	"context"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Workers that report local TCP listeners (service_listeners_v1).
const serviceListenersCapability = "service_listeners_v1"

const listenerCacheTTL = 4 * time.Second

type listenerSnapshot struct {
	at        time.Time
	listeners []wsServiceListener
}

// workspaceListeners asks the workspace's device which ports listen. ok is
// false when the device is offline, too old or did not answer: callers then
// report no liveness rather than "not listening".
func (s *Server) workspaceListeners(ctx context.Context, workspace store.WorkspaceProjection) ([]wsServiceListener, bool) {
	c := s.hub.connectionFor(workspace.DeviceID)
	if c == nil || !c.hasCapability(serviceListenersCapability) {
		return nil, false
	}
	t := &s.tunnels
	t.listenMu.Lock()
	if snap, hit := t.listeners[workspace.ID]; hit && time.Since(snap.at) < listenerCacheTTL {
		t.listenMu.Unlock()
		return snap.listeners, true
	}
	t.listenMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	value, err := callDevice[wsServiceListenersListedPayload](ctx, c, wsListServiceListenersType, wsListServiceListenersPayload{WorkspaceID: workspace.ID})
	if err != nil {
		return nil, false
	}
	t.listenMu.Lock()
	if t.listeners == nil {
		t.listeners = map[string]listenerSnapshot{}
	}
	for id, snap := range t.listeners {
		if time.Since(snap.at) > time.Minute {
			delete(t.listeners, id)
		}
	}
	t.listeners[workspace.ID] = listenerSnapshot{at: time.Now(), listeners: value.Listeners}
	t.listenMu.Unlock()
	return value.Listeners, true
}

// observeServiceTunnels adds liveness to ready rows and, for the owner of
// this workspace's device, unpublished listeners started from its folder.
func (s *Server) observeServiceTunnels(ctx context.Context, workspace store.WorkspaceProjection, rows []store.ServiceTunnelView, ownsDevice bool) []store.DetectedService {
	backing, _ := s.tunnelStore()
	reports := map[string][]wsServiceListener{}
	known := map[string]bool{}
	report := func(id string) ([]wsServiceListener, bool) {
		if listeners, done := reports[id]; done || known[id] {
			return listeners, done
		}
		known[id] = true
		target, err := s.store.GetWorkspace(ctx, id)
		if err != nil {
			return nil, false
		}
		listeners, ok := s.workspaceListeners(ctx, target)
		if ok {
			reports[id] = listeners
		}
		return listeners, ok
	}
	now := time.Now().UTC()
	for i := range rows {
		row := &rows[i]
		// Liveness is worth knowing before web access is routed, too.
		if row.Status != "ready" && row.Status != "preview_unrouted" && row.Status != "preview_domain_unconfigured" {
			continue
		}
		listeners, ok := report(row.TargetWorkspaceID)
		if !ok {
			continue
		}
		listening := false
		for _, l := range listeners {
			listening = listening || l.Port == row.Port
		}
		if !listening {
			// A stopped server is the more useful thing to say, routed or not.
			row.Status = "not_listening"
			continue
		}
		previous, _ := time.Parse(time.RFC3339Nano, row.LastSeenAt)
		row.LastSeenAt = now.Format(time.RFC3339Nano)
		// One write a minute keeps "last seen" useful across restarts.
		if backing != nil && now.Sub(previous) > time.Minute {
			_ = backing.MarkServiceTunnelSeen(ctx, row.ID, row.LastSeenAt)
		}
	}
	if !ownsDevice {
		return nil
	}
	listeners, ok := report(workspace.ID)
	if !ok {
		return nil
	}
	mapped := map[int]bool{}
	for _, row := range rows {
		if row.TargetWorkspaceID == workspace.ID {
			mapped[row.Port] = true
		}
	}
	detected := []store.DetectedService{}
	for _, l := range listeners {
		if l.InWorkspace && !l.Debugger && !mapped[l.Port] && validTunnelPort(l.Port) {
			detected = append(detected, store.DetectedService{Port: l.Port, Process: l.Process, TLS: l.TLS})
		}
	}
	return detected
}
