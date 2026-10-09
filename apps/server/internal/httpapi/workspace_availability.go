package httpapi

import (
	"context"
	"fmt"
	"log"
	"slices"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// workspaceNotServedMessage is what a person or agent reads when a workspace's
// device no longer serves its folder.
func workspaceNotServedMessage(workspace store.WorkspaceProjection) string {
	device := workspace.DeviceLabel
	if device == "" {
		device = "Its device"
	}
	return fmt.Sprintf("%s no longer serves this folder; add it again from the Workspaces page", device)
}

// unservedWorkspace returns the refusal for a workspace its device no longer
// serves, or nil. A workspace that cannot be read is left to the caller's
// own checks.
func unservedWorkspace(ctx context.Context, db store.Store, workspaceID string) error {
	if workspaceID == "" {
		return nil
	}
	workspace, err := db.GetWorkspace(ctx, workspaceID)
	if err != nil || workspace.UnavailableOnDevice == nil {
		return nil
	}
	return fmt.Errorf("%s", workspaceNotServedMessage(workspace))
}

// applyServedWorkspaces takes the workspaces a worker's hello lists as all it
// serves: the device's others are marked unavailable on it. A worker without
// the capability never sends the list, so its workspaces stay as they are.
func (c *daemonConnection) applyServedWorkspaces(registration store.DaemonRegistration) {
	if registration.ServedWorkspaceIDs == nil ||
		!slices.Contains(registration.Capabilities, store.DaemonCapabilityWorkspaceInventory) {
		return
	}
	availability, ok := c.hub.store.(store.WorkspaceAvailabilityStore)
	if !ok {
		return
	}
	changed, err := availability.SetDeviceServedWorkspaces(context.Background(), registration.Device.ID, registration.ServedWorkspaceIDs)
	if err != nil {
		log.Printf("device %s: recording its served workspaces failed: %v", registration.Device.ID, err)
		return
	}
	if changed {
		log.Printf("device %s serves %d workspaces; availability of its others updated", registration.Device.ID, len(registration.ServedWorkspaceIDs))
		c.hub.publishDeviceStatus(registration)
	}
}
