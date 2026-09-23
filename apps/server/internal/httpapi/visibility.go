package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// visibility is one caller's view: workspaces it can see, devices it owns or
// that host those workspaces, and connections it owns.
type visibility struct {
	scope      accessScope
	workspaces []store.WorkspaceProjection
	devices    map[string]bool
}

func (s *Server) visibilityFor(ctx context.Context, actor Actor) (visibility, error) {
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return visibility{}, err
	}
	workspaces, err := s.store.ListWorkspaces(ctx)
	if err != nil {
		return visibility{}, err
	}
	visible := scope.filterWorkspaces(workspaces)
	devices := scope.visibleDevices(visible)
	if scope.all {
		for _, workspace := range workspaces {
			if workspace.DeviceID != "" {
				devices[workspace.DeviceID] = true
			}
		}
	}
	return visibility{scope: scope, workspaces: visible, devices: devices}, nil
}

func (v visibility) seesDevice(deviceID string) bool {
	return v.scope.all || v.devices[deviceID]
}

// filterDevices keeps visible devices; a device seen only through a shared
// workspace hides its execution settings.
func (v visibility) filterDevices(devices []store.DeviceProjection) []store.DeviceProjection {
	result := []store.DeviceProjection{}
	for _, device := range devices {
		if !v.seesDevice(device.ID) {
			continue
		}
		device.Owned = v.scope.ownsDevice(device.ID)
		if !device.Owned {
			device.RuntimeSettings = nil
		}
		result = append(result, device)
	}
	return result
}

func (v visibility) ownsConnection(profile store.ProfileDefinition) bool {
	return v.scope.all || (v.scope.userID != "" && profile.OwnerUserID == v.scope.userID)
}

func (v visibility) filterConnections(profiles []store.ProfileDefinition) []store.ProfileDefinition {
	result := []store.ProfileDefinition{}
	for _, profile := range profiles {
		if v.ownsConnection(profile) {
			result = append(result, profile)
		}
	}
	return result
}

// filterByDevice keeps device-scoped records the caller may see.
func filterByDevice[T any](v visibility, items []T, deviceOf func(T) string) []T {
	result := make([]T, 0, len(items))
	for _, item := range items {
		if v.seesDevice(deviceOf(item)) {
			result = append(result, item)
		}
	}
	return result
}

// filterOwnedDevice keeps records of devices the caller owns (settings that
// a workspace collaborator must not see).
func filterOwnedDevice[T any](v visibility, items []T, deviceOf func(T) string) []T {
	result := make([]T, 0, len(items))
	for _, item := range items {
		if v.scope.ownsDevice(deviceOf(item)) {
			result = append(result, item)
		}
	}
	return result
}

// canUseModelCatalog lets a caller list a profile's models when it owns the
// connection or can see the device it runs on. The stored credential is used
// server-side and never returned.
func (s *Server) canUseModelCatalog(r *http.Request, profile store.CreateAgentProfileInput) bool {
	view, err := s.visibilityFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		return false
	}
	if deviceID := strings.TrimSpace(profile.DeviceID); deviceID != "" {
		return view.seesDevice(deviceID)
	}
	if id := strings.TrimSpace(profile.ID); id != "" {
		connection, err := s.store.GetProfile(r.Context(), id)
		return err == nil && view.ownsConnection(connection)
	}
	return true
}
