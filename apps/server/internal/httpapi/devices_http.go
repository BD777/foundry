package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// allEffectiveSkillRoots reports every device's effective scan roots in one
// list so the global device-skills views do not issue N store reads.
func (s *Server) allEffectiveSkillRoots(ctx context.Context, devices []store.DeviceProjection) ([]store.DeviceSkillRoot, error) {
	custom, err := s.store.ListDeviceSkillRoots(ctx, "")
	if err != nil {
		return nil, err
	}
	byDevice := map[string][]store.DeviceSkillRoot{}
	for _, root := range custom {
		byDevice[root.DeviceID] = append(byDevice[root.DeviceID], root)
	}
	isDefault := map[string]bool{}
	for _, path := range defaultSkillRoots {
		isDefault[path] = true
	}
	result := []store.DeviceSkillRoot{}
	for _, device := range devices {
		// A removed device scans nothing; its roots were purged with it.
		if device.Status == deviceStatusRemoved {
			continue
		}
		rows := byDevice[device.ID]
		if len(rows) == 0 {
			for _, path := range defaultSkillRoots {
				result = append(result, store.DeviceSkillRoot{DeviceID: device.ID, Path: path, IsDefault: true})
			}
			continue
		}
		for _, root := range rows {
			root.IsDefault = isDefault[root.Path]
			result = append(result, root)
		}
	}
	return result, nil
}

// deviceNamer is the store capability behind device renaming.
type deviceNamer interface {
	RenameDevice(ctx context.Context, id string, name string) (store.DeviceProjection, error)
}

// handleRenameDevice sets the name people see for a device; the worker's
// hostname stays in its system details.
func (s *Server) handleRenameDevice(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name string `json:"name"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	name := strings.TrimSpace(input.Name)
	if name == "" || len([]rune(name)) > 120 || strings.ContainsAny(name, "\r\n\t") {
		writeError(w, http.StatusBadRequest, "display name must be 1–120 characters on one line")
		return
	}
	item, err := s.store.RenameDevice(r.Context(), r.PathValue("deviceId"), name)
	if err == nil {
		// Workspaces, connections and skills show the device's name too.
		s.projectionsChanged("", append([]string{fieldDevices, fieldWorkspaces, fieldPromotedSkills}, connectionFields...)...)
	}
	writeResult(w, item, err)
}

func (s *Server) handleListDevices(w http.ResponseWriter, r *http.Request) {
	view, err := s.visibilityFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	items, err := s.store.ListDevices(r.Context())
	writeResult(w, view.filterDevices(items), err)
}

func (s *Server) handleUpsertAgentRuntimeSettings(w http.ResponseWriter, r *http.Request) {
	var input store.UpsertAgentRuntimeSettingsInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceOwner(w, r, strings.TrimSpace(input.DeviceID)) {
		return
	}
	if input.Settings.ActiveRuntimeTtlMs <= 0 {
		writeError(w, http.StatusBadRequest, "activeRuntimeTtlMs must be positive")
		return
	}
	if input.Settings.MaxConcurrentTasks < 1 || input.Settings.MaxConcurrentTasks > 16 {
		writeError(w, http.StatusBadRequest, "maxConcurrentTasks must be between 1 and 16")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	settings, err := s.hub.UpsertAgentRuntimeSettings(ctx, input)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "local daemon is not connected")
		return
	}
	writeResult(w, settings, err)
}

// handleRefreshDeviceResources re-detects a device's resources, first asking
// the person at the device for access to one resource when the owner asks.
func (s *Server) handleRefreshDeviceResources(w http.ResponseWriter, r *http.Request) {
	var input struct {
		RequestAccess string `json:"requestAccess"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	deviceID := r.PathValue("id")
	if !s.requireDeviceOwner(w, r, deviceID) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	value, err := s.hub.RefreshDeviceResources(ctx, deviceID, strings.TrimSpace(input.RequestAccess))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "local daemon is not connected")
		return
	}
	resources := value.Resources
	if resources == nil {
		resources = []store.DeviceResource{}
	}
	writeResult(w, struct {
		Resources []store.DeviceResource `json:"resources"`
		Opened    []string               `json:"opened"`
	}{resources, append([]string{}, value.Opened...)}, err)
}

func (s *Server) handleProviderHealth(w http.ResponseWriter, r *http.Request) {
	view, err := s.visibilityFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	items, err := s.store.ListProviderHealth(r.Context(), r.URL.Query().Get("deviceId"))
	writeResult(w, filterByDevice(view, items, func(item store.ProviderHealth) string { return item.DeviceID }), err)
}
