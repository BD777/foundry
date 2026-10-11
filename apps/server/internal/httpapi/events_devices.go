package httpapi

import (
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A device's message.
var deviceStatusChangedEvent = browserevent.Define[browserevent.DeviceStatusChangedPayload](browserevent.DeviceStatusChanged, eventstream.Options{})

// deviceEvents tells browsers what changed about the devices that serve
// workspaces. A device going online or offline (or its worker update moving
// on) travels as the device itself; what a device's report changed beyond
// that is announced as foundry-data fields to read again (dataChanges).
type deviceEvents struct {
	stream  eventstream.Publisher
	store   store.Store
	data    *dataChanges
	devices deviceProjector
}

// deviceProjector is the device as its event carries it (see
// Server.deviceForEvent).
type deviceProjector interface {
	deviceForEvent(ctx context.Context, deviceID string) (store.DeviceProjection, bool)
}

func newDeviceEvents(stream eventstream.Publisher, db store.Store, data *dataChanges, devices deviceProjector) *deviceEvents {
	return &deviceEvents{stream: stream, store: db, data: data, devices: devices}
}

// registrationChanged tells whoever can see the registration's workspace
// that its device's status changed; a device registered without one
// reaches only those who see every workspace.
func (e *deviceEvents) registrationChanged(registration store.DaemonRegistration) {
	event := browserevent.DeviceStatusChangedPayload{
		WorkspaceID: registration.Workspace.ID,
		DeviceID:    registration.Device.ID,
		Status:      registration.Device.Status,
	}
	if device, ok := e.devices.deviceForEvent(context.Background(), registration.Device.ID); ok {
		event.Device = &device
	}
	deviceStatusChangedEvent.Publish(e.stream, eventstream.Route{Workspace: event.WorkspaceID}, event)
}

// changed tells whoever sees the device what it is now, with one device
// event per workspace on it: they reach its workspaces' viewers and its
// owner, an owner of each (see ensureDeviceOwnerMembership). False when it
// is on none, so no device event reaches those who see it.
func (e *deviceEvents) changed(ctx context.Context, deviceID string) bool {
	device, ok := e.devices.deviceForEvent(ctx, deviceID)
	if !ok {
		return false
	}
	workspaces, err := e.store.ListWorkspaces(ctx)
	if err != nil {
		return false
	}
	published := false
	for _, workspace := range workspaces {
		if workspace.DeviceID != deviceID {
			continue
		}
		deviceStatusChangedEvent.Publish(e.stream, eventstream.Route{Workspace: workspace.ID}, browserevent.DeviceStatusChangedPayload{
			WorkspaceID: workspace.ID,
			DeviceID:    deviceID,
			Status:      device.Status,
			Device:      &device,
		})
		published = true
	}
	return published
}

// reported announces what a device's report changed that its status event
// does not carry.
func (e *deviceEvents) reported(changes store.DaemonChanges) {
	global, workspace := daemonChangeFields(changes.Parts)
	if changes.Global {
		e.data.changed("", global...)
	}
	for _, workspaceID := range changes.Workspaces {
		if workspaceID != "" {
			e.data.changed(workspaceID, workspace...)
		}
	}
}

// daemonChangeFields names the foundry-data fields a device report's
// global change and its workspace change touched; none names any.
func daemonChangeFields(parts store.DaemonChangedParts) (global, workspace []string) {
	if !parts.Known {
		return nil, nil
	}
	add := func(fields *[]string, changed bool, names ...string) {
		if changed {
			*fields = append(*fields, names...)
		}
	}
	// Workspaces show their device's name and the catalog the devices
	// skills came from; agents and agent profiles derive from the device,
	// its health and its profiles; a device's scan folders default until
	// set.
	add(&global, parts.Device, fieldDevices, fieldWorkspaces, fieldPromotedSkills, fieldAgentProfiles, fieldAgents, fieldDeviceSkillRoots)
	add(&global, parts.ProviderHealth, fieldProviderHealth, fieldAgentProfiles, fieldAgents)
	add(&global, parts.AgentProfiles, fieldAgentProfiles, fieldAgents)
	add(&global, parts.NewWorkspace, fieldWorkspaces)
	add(&workspace, parts.Workspace, fieldWorkspaces)
	add(&workspace, parts.Agents, fieldAgents, fieldAgentProfiles)
	add(&workspace, parts.Assets, fieldAssets)
	add(&workspace, parts.Skills, fieldSkills)
	add(&workspace, parts.WorkspaceFiles, fieldWorkspaceFiles)
	add(&workspace, parts.Chats, fieldChats)
	return global, workspace
}
