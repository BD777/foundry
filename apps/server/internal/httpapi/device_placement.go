package httpapi

import (
	"context"
	"log"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Device labels and detected facts (docs/devices-and-workspaces.md): the
// owner states what a computer has (GET /api/device-placements, PUT
// /api/devices/{id}/labels); Foundry adds what the worker's reports show
// (system, toolchains, GPUs, a connector's network check) and how much of
// the last week the device was connected. The assistant reads both in its
// snapshot and places new projects by them (personalagent.Place).

// devicePresenceTick is how often a connected device's presence is saved.
var devicePresenceTick = 5 * time.Minute

// trackDevicePresence saves each device connection, moved on while it
// lasts, so the online share survives restarts.
func (s *Server) trackDevicePresence() {
	connected := s.hub.onDeviceConnected
	s.hub.onDeviceConnected = func(ctx context.Context, deviceID string, capabilities []string) {
		if connected != nil {
			connected(ctx, deviceID, capabilities)
		}
		go s.followDevicePresence(ctx, deviceID)
	}
}

func (s *Server) followDevicePresence(ctx context.Context, deviceID string) {
	started := time.Now()
	record := func(at time.Time) {
		if err := s.store.RecordDevicePresence(context.WithoutCancel(ctx), deviceID, started, at); err != nil {
			log.Printf("device %s presence: %v", deviceID, err)
		}
	}
	record(started)
	if err := s.store.PruneDevicePresence(ctx, started.Add(-2*personalagent.OnlineShareWindow)); err != nil {
		log.Printf("prune device presence: %v", err)
	}
	ticker := time.NewTicker(devicePresenceTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			record(time.Now())
			return
		case at := <-ticker.C:
			record(at)
		}
	}
}

// devicePlacements is the labels and detected facts of devices, by id.
func (s *Server) devicePlacements(ctx context.Context, devices []store.DeviceProjection, now time.Time) (map[string]store.DevicePlacement, error) {
	ids := make([]string, 0, len(devices))
	placements := map[string]store.DevicePlacement{}
	for _, device := range devices {
		ids = append(ids, device.ID)
		placements[device.ID] = store.DevicePlacement{DeviceID: device.ID, Labels: []store.DeviceLabel{}, Facts: systemFacts(device.System)}
	}
	if len(ids) == 0 {
		return placements, nil
	}
	sets, err := s.store.ListDeviceLabels(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, set := range sets {
		placement := placements[set.DeviceID]
		placement.Labels, placement.LabelsUpdatedAt = set.Labels, set.UpdatedAt
		placements[set.DeviceID] = placement
	}
	instances, err := s.store.ListResourceInstances(ctx, store.ResourceFilter{})
	if err != nil {
		return nil, err
	}
	for _, instance := range instances {
		placement, ok := placements[instance.Source.ID]
		if !ok || instance.Source.Kind != "device" {
			continue
		}
		if fact, ok := resourceFact(instance); ok {
			placement.Facts = appendFact(placement.Facts, fact)
			placements[instance.Source.ID] = placement
		}
	}
	if err := s.addConnectorFacts(ctx, ids, placements); err != nil {
		return nil, err
	}
	// Connections from before the window tell that the device was followed
	// for all of it.
	intervals, err := s.store.ListDevicePresence(ctx, ids, now.Add(-2*personalagent.OnlineShareWindow))
	if err != nil {
		return nil, err
	}
	byDevice := map[string][]store.DevicePresenceInterval{}
	for _, interval := range intervals {
		byDevice[interval.DeviceID] = append(byDevice[interval.DeviceID], interval)
	}
	for id, placement := range placements {
		placement.OnlineShare = personalagent.OnlineShare(byDevice[id], s.hub.HasConnection(id), now, personalagent.OnlineShareWindow)
		if personalagent.DetectedAlwaysOn(placement.OnlineShare) {
			placement.Facts = appendFact(placement.Facts, store.DeviceFact{Key: "always-on", Source: "presence"})
		}
		sort.SliceStable(placement.Facts, func(i, j int) bool {
			a, b := placement.Facts[i], placement.Facts[j]
			return a.Key < b.Key || (a.Key == b.Key && a.Value < b.Value)
		})
		placements[id] = placement
	}
	return placements, nil
}

func appendFact(facts []store.DeviceFact, fact store.DeviceFact) []store.DeviceFact {
	for _, known := range facts {
		if known.Key == fact.Key && known.Value == fact.Value {
			return facts
		}
	}
	return append(facts, fact)
}

// systemFacts are the os and arch the worker reported.
func systemFacts(system *store.DeviceSystem) []store.DeviceFact {
	facts := []store.DeviceFact{}
	if system == nil {
		return facts
	}
	os := map[string]string{"darwin": "macos", "macos": "macos", "linux": "linux", "win32": "windows", "windows": "windows"}[strings.ToLower(system.OS)]
	if os == "" && strings.Contains(strings.ToLower(system.OS), "linux") {
		os = "linux"
	}
	if os != "" {
		facts = append(facts, store.DeviceFact{Key: "os", Value: os, Detail: strings.TrimSpace(system.OS + " " + system.OSVersion), Source: "system"})
	}
	if arch := strings.ToLower(strings.TrimSpace(system.Arch)); arch != "" {
		facts = append(facts, store.DeviceFact{Key: "arch", Value: arch, Source: "system"})
	}
	return facts
}

// resourceFact is what a detected resource says about its device: a
// toolchain or container runtime, or a GPU by vendor.
func resourceFact(instance store.ResourceInstance) (store.DeviceFact, bool) {
	if !instance.Readiness.Ready || instance.State == store.ResourceGone {
		return store.DeviceFact{}, false
	}
	switch instance.Type {
	case "toolchain", "container_runtime":
		_, id, _ := strings.Cut(instance.Key, "/")
		if id == "" {
			return store.DeviceFact{}, false
		}
		return store.DeviceFact{Key: "toolchain", Value: strings.ToLower(id), Detail: instance.Name, Source: "toolchain"}, true
	case "gpu":
		vendor := ""
		if words := strings.Fields(instance.Details["vendor"]); len(words) > 0 {
			vendor = strings.ToLower(words[0])
		}
		return store.DeviceFact{Key: "gpu", Value: vendor, Detail: instance.Name, Source: "gpu"}, true
	}
	return store.DeviceFact{}, false
}

// addConnectorFacts adds the networks a device-held connector's check
// found reachable: reaches:<host>. A check it failed adds nothing; the
// state names the requirement it failed.
func (s *Server) addConnectorFacts(ctx context.Context, ids []string, placements map[string]store.DevicePlacement) error {
	if s.connectors == nil || s.connectors.Devices == nil {
		return nil
	}
	requires := map[string][]store.ConnectorRequirement{}
	for _, connector := range s.connectors.Devices.Connectors() {
		if len(connector.Requires) > 0 {
			requires[connector.Kind] = connector.Requires
		}
	}
	if len(requires) == 0 {
		return nil
	}
	states, err := s.store.ListDeviceConnectorStates(ctx, ids)
	if err != nil {
		return err
	}
	for _, state := range states {
		placement, ok := placements[state.DeviceID]
		if !ok {
			continue
		}
		for _, requirement := range requires[state.Kind] {
			if state.Status == store.DeviceConnectorUnavailable || state.Status == store.DeviceConnectorError {
				continue
			}
			placement.Facts = appendFact(placement.Facts, store.DeviceFact{
				Key: "reaches", Value: strings.ToLower(requirement.Host), Detail: requirement.Label, Source: "connector",
			})
		}
		placements[state.DeviceID] = placement
	}
	return nil
}

func (s *Server) handleListDevicePlacements(w http.ResponseWriter, r *http.Request) {
	view, err := s.visibilityFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	devices, err := s.store.ListDevices(r.Context())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	owned := []store.DeviceProjection{}
	for _, device := range view.filterDevices(devices) {
		if device.Owned && device.Status != "removed" {
			owned = append(owned, device)
		}
	}
	placements, err := s.devicePlacements(r.Context(), owned, time.Now())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	list := make([]store.DevicePlacement, 0, len(owned))
	for _, device := range owned {
		list = append(list, placements[device.ID])
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleSetDeviceLabels(w http.ResponseWriter, r *http.Request) {
	var input store.SetDeviceLabelsInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	labels, err := personalagent.NormalizeLabels(input.Labels)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	deviceID := r.PathValue("deviceId")
	devices, err := s.store.ListDevices(r.Context())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	index := slices.IndexFunc(devices, func(device store.DeviceProjection) bool { return device.ID == deviceID })
	if index < 0 || devices[index].Status == "removed" {
		writeError(w, http.StatusNotFound, "device not found")
		return
	}
	device := devices[index]
	userID := ""
	if account := actorFromContext(r.Context()).Account; account != nil {
		userID = account.ID
	}
	if err := s.store.SetDeviceLabels(r.Context(), deviceID, labels, userID); err != nil {
		writeResult(w, nil, err)
		return
	}
	placements, err := s.devicePlacements(r.Context(), []store.DeviceProjection{device}, time.Now())
	writeResult(w, placements[deviceID], err)
}
