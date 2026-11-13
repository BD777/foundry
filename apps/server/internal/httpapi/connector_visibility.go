package httpapi

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	connectorVisibilityMaxAge = 24 * time.Hour
	connectorVisibilityWait   = 3 * time.Second
	connectorVisibilityCheck  = 30 * time.Second
)

func visibilityCheckKey(deviceID, result, kind, via, repository string) string {
	return strings.Join([]string{deviceID, result, kind, via, repository}, "\x00")
}

// refreshConnectorVisibility starts the stale checks on online devices and
// returns when all of them finish. The caller may wait only a short time;
// the checks continue in the background.
func (s *Server) refreshConnectorVisibility(ctx context.Context, devices []store.DeviceProjection, force bool) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		ids := make([]string, 0, len(devices))
		online := map[string]bool{}
		for _, device := range devices {
			ids = append(ids, device.ID)
			online[device.ID] = s.hub.connectionFor(device.ID) != nil
		}
		targets, err := s.connectors.VisibilityTargets(context.WithoutCancel(ctx), ids)
		if err != nil {
			s.connectors.ServerHeld.Logf("connector visibility targets: %v", err)
			return
		}
		checks, err := s.store.ListConnectorVisibilityChecks(context.WithoutCancel(ctx), ids)
		if err != nil {
			s.connectors.ServerHeld.Logf("connector visibility cache: %v", err)
			return
		}
		byKey := map[string]store.ConnectorVisibilityCheck{}
		for _, check := range checks {
			byKey[visibilityCheckKey(check.DeviceID, check.Result, check.Kind, check.Via, check.Repository)] = check
		}
		var waits []<-chan struct{}
		for _, target := range targets {
			if !online[target.DeviceID] {
				continue
			}
			key := visibilityCheckKey(target.DeviceID, target.Result, target.Kind, target.Via, target.Repository)
			if !force {
				if check, ok := byKey[key]; ok {
					if checked, err := time.Parse(time.RFC3339, check.CheckedAt); err == nil && time.Since(checked) < connectorVisibilityMaxAge {
						continue
					}
				}
			}
			target := target
			waits = append(waits, s.connectorVisibility.start(target.DeviceID,
				target.Result+"\x00"+target.Kind+"\x00"+target.Via+"\x00"+target.Repository,
				func() {
					s.checkConnectorVisibility(context.WithoutCancel(ctx), target)
				}))
		}
		for _, wait := range waits {
			select {
			case <-wait:
			case <-ctx.Done():
				return
			}
		}
	}()
	return done
}

func (s *Server) checkConnectorVisibility(ctx context.Context, target connectors.VisibilityTarget) {
	action := "requirements"
	payload := store.ConnectorRequestPayload{}
	if target.Result == store.ConnectorVisibilityRepository {
		action = "repository_access"
		payload.Repository = target.Repository
	}
	checkCtx, cancel := context.WithTimeout(ctx, connectorVisibilityCheck)
	defer cancel()
	reply, err := s.askDeviceConnector(checkCtx, target.DeviceID, target.Connector, action, true, connectorVisibilityCheck, payload)
	now := time.Now().UTC().Format(time.RFC3339)
	check := store.ConnectorVisibilityCheck{
		DeviceID: target.DeviceID, Result: target.Result, Kind: target.Kind,
		Via: target.Via, Repository: target.Repository, CheckedAt: now,
	}
	switch target.Result {
	case store.ConnectorVisibilityRequirements:
		if err != nil {
			check.Status = "error"
			check.Detail = visibilityDetail(err.Error())
		} else if reply.RequirementsCheck == nil {
			check.Status = "error"
			check.Detail = "the device answered without a requirement result"
		} else {
			result := reply.RequirementsCheck
			check.Status = "ok"
			if !result.OK {
				check.Status = "unreachable"
			}
			check.Requirement = visibilityDetail(result.Requirement)
		}
	case store.ConnectorVisibilityRepository:
		if err != nil {
			check.Status = "error"
			check.Detail = visibilityDetail(err.Error())
		} else if reply.SourceAccessCheck == nil {
			check.Status = "error"
			check.Detail = "the device answered without a repository result"
		} else {
			result := reply.SourceAccessCheck
			check.Status = result.Status
			check.Identity = visibilityIdentity(result.Identity)
			check.Detail = visibilityDetail(result.Detail)
		}
	}
	check.CheckedAt = now
	if err := s.store.SaveConnectorVisibilityCheck(context.WithoutCancel(ctx), check); err != nil {
		s.connectors.ServerHeld.Logf("save connector visibility %s/%s: %v", target.DeviceID, target.Kind, err)
	}
}

func visibilityDetail(value string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 {
			return ' '
		}
		return r
	}, strings.TrimSpace(value))[:min(len(strings.TrimSpace(value)), 300)]
}

func visibilityIdentity(value string) string {
	value, _, _ = strings.Cut(strings.TrimSpace(value), "@")
	if len(value) > 64 {
		value = value[:64]
	}
	return value
}

func waitConnectorVisibility(done <-chan struct{}, wait time.Duration) {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
	}
}

func (s *Server) connectorCatalogView(ctx context.Context, ownerUserID string, devices []store.DeviceProjection) (store.ConnectorCatalogView, error) {
	ids := make([]string, 0, len(devices))
	for _, device := range devices {
		ids = append(ids, device.ID)
	}
	listed, restricted, err := s.connectors.CatalogFor(ctx, ids)
	if err != nil {
		return store.ConnectorCatalogView{}, err
	}
	names := map[string]string{}
	online := map[string]bool{}
	for _, device := range devices {
		names[device.ID] = device.Label
		online[device.ID] = s.hub.connectionFor(device.ID) != nil
	}
	for i := range restricted {
		for j := range restricted[i].Devices {
			deviceID := restricted[i].Devices[j].DeviceID
			restricted[i].Devices[j].Name = names[deviceID]
			restricted[i].Devices[j].Online = online[deviceID]
			if source := restricted[i].Connector.Access; source != nil {
				restricted[i].Devices[j].ViaLabel = source.Via
				if provider, ok := s.connectors.Lookup(source.Via); ok {
					restricted[i].Devices[j].ViaLabel = provider.Label
				}
			}
		}
	}
	bundles, err := s.connectorSkillBundles(ctx, ownerUserID, "", listed)
	if err != nil {
		return store.ConnectorCatalogView{}, err
	}
	return store.ConnectorCatalogView{Connectors: listed, RestrictedConnectors: restricted, SkillBundles: bundles}, nil
}

func (s *Server) handleRecheckConnectorVisibility(w http.ResponseWriter, r *http.Request) {
	actor, ok := personActor(w, r)
	if !ok {
		return
	}
	devices, err := s.ownDevices(r.Context(), actor.AccountID())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	waitConnectorVisibility(s.refreshConnectorVisibility(r.Context(), devices, true), connectorVisibilityCheck)
	view, err := s.connectorCatalogView(r.Context(), actor.AccountID(), devices)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}
