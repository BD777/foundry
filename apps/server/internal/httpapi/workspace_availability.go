package httpapi

import (
	"context"
	"fmt"
	"log"
	"slices"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// workspaceNotServedMessage is what a person or agent reads when a workspace's
// device no longer serves its folder, or no longer has it.
func workspaceNotServedMessage(workspace store.WorkspaceProjection) string {
	device := workspace.DeviceLabel
	if device == "" {
		device = "its device"
	}
	if workspace.UnavailableOnDevice != nil && workspace.UnavailableOnDevice.Reason == store.WorkspaceFolderMissing {
		return fmt.Sprintf(`The folder %s no longer exists on %s (moved, renamed or deleted). Use "Locate folder…" or "Remove" for this workspace on the Workspaces page.`, workspace.LocalPath, device)
	}
	if workspace.DeviceLabel == "" {
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
	var missing []string
	if slices.Contains(registration.Capabilities, store.DaemonCapabilityWorkspaceFolders) {
		missing = registration.MissingWorkspaceIDs
	}
	if c.recordWorkspaceFolders(registration.Device.ID, registration.ServedWorkspaceIDs, missing) {
		c.hub.devices.registrationChanged(registration)
	}
}

// recordWorkspaceFolders stores which of the device's workspaces it serves
// and which it has lost the folder of, and tells every view when that
// changed.
func (c *daemonConnection) recordWorkspaceFolders(deviceID string, served, missing []string) bool {
	changed, err := c.hub.store.SetDeviceServedWorkspaces(context.Background(), deviceID, served, missing)
	if err != nil {
		log.Printf("device %s: recording its served workspaces failed: %v", deviceID, err)
		return false
	}
	if changed {
		log.Printf("device %s serves %d workspaces, %d with their folder missing; availability of its workspaces updated", deviceID, len(served), len(missing))
		// Which of its workspaces changed is not known here; the workspace
		// list every view shows did.
		c.hub.dataChanges.changed("", fieldWorkspaces)
	}
	return changed
}

// workspaceFoldersChanged takes a worker's news that the folders of its
// workspaces changed: one disappeared (moved, renamed, deleted) or came back.
func (c *daemonConnection) workspaceFoldersChanged(envelope wsEnvelope) error {
	var payload struct {
		ServedWorkspaceIDs  []string `json:"servedWorkspaceIds"`
		MissingWorkspaceIDs []string `json:"missingWorkspaceIds"`
	}
	if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
		return err
	}
	deviceID, _ := c.registrationSnapshot()
	if deviceID != "" && payload.ServedWorkspaceIDs != nil {
		c.recordWorkspaceFolders(deviceID, payload.ServedWorkspaceIDs, payload.MissingWorkspaceIDs)
	}
	c.reply(wsEnvelope{Type: wsAckType, ID: envelope.ID})
	return nil
}
