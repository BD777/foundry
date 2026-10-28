package httpapi

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// SteerAgentSession moves a message into the session's running turn.
// inputID, the message's id when it has one, lets the device apply a steer
// sent again only once.
func (h *DaemonHub) SteerAgentSession(ctx context.Context, session store.AgentSession, inputID string, message string, attachments []store.ChatAttachment, sentBySessionID string) error {
	return h.SteerAgentSessionWith(ctx, session, wsSteerSessionPayload{SentBySessionID: sentBySessionID, SessionID: session.ID, Message: message, Attachments: attachments, InputID: strings.TrimSpace(inputID)})
}

// SteerAgentSessionWith steers with every field of the steer: a message
// from another session also names how its turn takes it (Delivery).
func (h *DaemonHub) SteerAgentSessionWith(ctx context.Context, session store.AgentSession, steer wsSteerSessionPayload) error {
	if holds, ok := h.store.(store.NativeAccountHoldStore); ok {
		if err := holds.BindNativeAccount(ctx, session); err != nil {
			return err
		}
	}
	steer.SessionID, steer.InputID = session.ID, strings.TrimSpace(steer.InputID)
	_, err := callDevice[wsSessionSteeredPayload](ctx, h.connectionFor(session.DeviceID), wsSteerSessionType, steer)
	return err
}

// CancelAgentSession stops a session on its device. answered reports that
// the turn had already answered: the device completes it with that answer.
func (h *DaemonHub) CancelAgentSession(ctx context.Context, session store.AgentSession) (answered bool, err error) {
	value, err := callDevice[wsSessionCanceledPayload](ctx, h.connectionFor(session.DeviceID), wsCancelSessionType,
		wsCancelSessionPayload{SessionID: session.ID, InputID: session.Input.ID})
	return value.Answered, err
}

func (h *DaemonHub) ReadWorkspaceFile(ctx context.Context, workspace store.WorkspaceProjection, path string) (store.WorkspaceFileRead, error) {
	return h.connectionFor(workspace.DeviceID).readWorkspaceFile(ctx, workspace.ID, path)
}

func (c *daemonConnection) readWorkspaceFile(ctx context.Context, workspaceID string, path string) (store.WorkspaceFileRead, error) {
	value, err := callDevice[wsFileReadPayload](ctx, c, wsReadFileType, wsReadFilePayload{WorkspaceID: workspaceID, Path: path})
	return store.WorkspaceFileRead{
		WorkspaceID: value.WorkspaceID,
		Path:        value.Path,
		Content:     value.Content,
		Truncated:   value.Truncated,
	}, err
}

func (h *DaemonHub) ReadAgentSubagentTranscript(ctx context.Context, session store.AgentSession, taskID string) (store.AgentSubagentTranscript, error) {
	value, err := callDevice[wsSubagentTranscriptReadPayload](ctx, h.connectionFor(session.DeviceID), wsReadSubagentTranscriptType,
		wsReadSubagentTranscriptPayload{WorkspaceID: session.WorkspaceID, SessionID: session.ID, TaskID: taskID})
	return value.AgentSubagentTranscript, err
}

// ReadSessionFile reads a file the session recorded from the session's
// device. The device checks the path against the session's file ledger and
// answers with the entry's origin; the caller decides who may see it.
func (h *DaemonHub) ReadSessionFile(ctx context.Context, session store.AgentSession, path string) (store.SessionFileRead, error) {
	value, err := callDevice[wsSessionFileReadPayload](ctx, h.connectionFor(session.DeviceID), wsReadSessionFileType,
		wsReadSessionFilePayload{WorkspaceID: session.WorkspaceID, SessionID: session.ID, Path: path})
	return value.SessionFileRead, err
}

// ReadSessionFileDiff reads what the session's writes changed in a file it
// recorded, from the session's device: one turn's (inputID) or all of them.
func (h *DaemonHub) ReadSessionFileDiff(ctx context.Context, session store.AgentSession, path string, inputID string) (store.SessionFileDiff, error) {
	value, err := callDevice[wsSessionFileDiffReadPayload](ctx, h.connectionFor(session.DeviceID), wsReadSessionFileDiffType,
		wsReadSessionFileDiffPayload{WorkspaceID: session.WorkspaceID, SessionID: session.ID, Path: path, InputID: inputID})
	return value.SessionFileDiff, err
}

func (h *DaemonHub) ListAgentSubagents(ctx context.Context, session store.AgentSession) ([]store.AgentSubagentSummary, error) {
	listed, err := h.listAgentSubagents(ctx, session, "")
	if err != nil {
		return nil, err
	}
	var subagents []store.AgentSubagentSummary
	return subagents, decodeListedSubagents(listed.Subagents, &subagents)
}

// ListAgentSubagentDigests reads the session's subagents as a chat lists
// them. Its device sends no prompts and only fingerprints of the answers;
// those of a worker that sends the whole list anyway are made here.
func (h *DaemonHub) ListAgentSubagentDigests(ctx context.Context, session store.AgentSession) ([]store.AgentSubagentDigest, error) {
	listed, err := h.listAgentSubagents(ctx, session, subagentDigestView)
	if err != nil {
		return nil, err
	}
	var digests []store.AgentSubagentDigest
	if listed.View == subagentDigestView {
		return digests, decodeListedSubagents(listed.Subagents, &digests)
	}
	var subagents []store.AgentSubagentSummary
	if err := decodeListedSubagents(listed.Subagents, &subagents); err != nil || subagents == nil {
		return nil, err
	}
	digests = make([]store.AgentSubagentDigest, 0, len(subagents))
	for _, subagent := range subagents {
		digests = append(digests, subagent.Digest())
	}
	return digests, nil
}

// listAgentSubagents asks the session's device for its subagents in view
// ("" or subagentDigestView); the answer says the view it is in.
func (h *DaemonHub) listAgentSubagents(ctx context.Context, session store.AgentSession, view string) (wsSubagentsListedPayload, error) {
	return callDevice[wsSubagentsListedPayload](ctx, h.connectionFor(session.DeviceID), wsListSubagentsType,
		wsListSubagentsPayload{WorkspaceID: session.WorkspaceID, SessionID: session.ID, View: view})
}

// decodeListedSubagents decodes a device's list; one it left out is nil.
func decodeListedSubagents(raw json.RawMessage, target any) error {
	if len(raw) == 0 {
		return nil
	}
	return decodeWebSocketPayload(raw, target)
}

func (h *DaemonHub) ListSubdirectories(ctx context.Context, deviceID string, path string) ([]store.WorkspaceDirectoryEntry, error) {
	value, err := callDevice[wsDirectoriesListedPayload](ctx, h.connectionFor(deviceID), wsListDirectoriesType, wsListDirectoriesPayload{Path: path})
	return value.Directories, err
}

func (h *DaemonHub) ListWorkspaceTree(ctx context.Context, workspace store.WorkspaceProjection, path string) ([]store.WorkspaceTreeEntry, error) {
	value, err := callDevice[wsWorkspaceTreeListedPayload](ctx, h.connectionFor(workspace.DeviceID), wsListWorkspaceTreeType,
		wsListWorkspaceTreePayload{WorkspaceID: workspace.ID, Path: path})
	return value.Entries, err
}

func (h *DaemonHub) SetupWorkspace(ctx context.Context, deviceID string, path string) (store.WorkspaceProjection, error) {
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return store.WorkspaceProjection{}, store.ErrNotFound
	}
	return connection.setupWorkspace(ctx, wsSetupWorkspacePayload{Path: path})
}

func (c *daemonConnection) setupWorkspace(ctx context.Context, payload wsSetupWorkspacePayload) (store.WorkspaceProjection, error) {
	if err := c.allowWorkspaceFolder(ctx, payload.Path); err != nil {
		return store.WorkspaceProjection{}, err
	}
	value, err := callDevice[wsWorkspaceReadyPayload](ctx, c, wsSetupWorkspaceType, payload)
	if err != nil {
		return store.WorkspaceProjection{}, err
	}
	registration := value.Registration
	registration.Workspace.DeviceID = registration.Device.ID
	registration.Workspace.DeviceLabel = registration.Device.Label
	if err := c.syncRegistration(registration); err != nil {
		return store.WorkspaceProjection{}, err
	}
	go c.dispatchQueuedAgentSessions(registration.Workspace.ID)
	return registration.Workspace, nil
}

// allowWorkspaceFolder takes back the person's deletion of the workspace at
// folder on this device: they are adding the folder again, so the device's
// reports of it count again (an answer that comes after the request timed
// out included).
func (c *daemonConnection) allowWorkspaceFolder(ctx context.Context, folder string) error {
	deviceID, _ := c.registrationSnapshot()
	c.workspaceChoiceMu.Lock()
	defer c.workspaceChoiceMu.Unlock()
	return c.hub.store.ClearWorkspaceDeletion(ctx, deviceID, folder)
}

func (h *DaemonHub) ForgetWorkspace(ctx context.Context, workspace store.WorkspaceProjection) error {
	connection := h.connectionFor(workspace.DeviceID)
	if connection == nil {
		return store.ErrNotFound
	}
	// The workspace is gone whatever the device answers: the connection
	// must not report it again, not even when it closes.
	connection.registrationMu.Lock()
	if connection.registration.Workspace.ID == workspace.ID {
		connection.registration.Workspace = store.WorkspaceProjection{}
	}
	delete(connection.registrations, workspace.ID)
	connection.registrationMu.Unlock()
	return connection.forgetWorkspace(ctx, workspace.ID, workspace.LocalPath)
}

// forgetDeletedWorkspace tells the device, once per connection, to forget a
// workspace the person deleted from it that it still reports: it was
// offline when the person deleted it, or its worker reports the folder it
// was installed with.
func (c *daemonConnection) forgetDeletedWorkspace(deviceID string, workspace store.WorkspaceProjection) {
	if workspace.ID == "" {
		return
	}
	// Held across the request, so the person adding the folder again
	// cannot slip in between the check and the forget.
	c.workspaceChoiceMu.Lock()
	defer c.workspaceChoiceMu.Unlock()
	if c.deletedWorkspacesForgotten[workspace.ID] {
		return
	}
	deleted, err := c.hub.store.WorkspaceDeletedFromDevice(c.lifetime, workspace.ID, deviceID)
	if err != nil || !deleted {
		return
	}
	ctx, cancel := context.WithTimeout(c.lifetime, 10*time.Second)
	defer cancel()
	if err := c.forgetWorkspace(ctx, workspace.ID, workspace.LocalPath); err != nil {
		log.Printf("device %s: forgetting deleted workspace %s failed: %v", deviceID, workspace.ID, err)
		return
	}
	c.deletedWorkspacesForgotten[workspace.ID] = true
	log.Printf("device %s still served deleted workspace %s (%s); told it to forget the folder", deviceID, workspace.ID, workspace.LocalPath)
}

func (c *daemonConnection) forgetWorkspace(ctx context.Context, workspaceID string, path string) error {
	_, err := callDevice[wsWorkspaceForgottenPayload](ctx, c, wsForgetWorkspaceType, wsForgetWorkspacePayload{WorkspaceID: workspaceID, Path: path})
	return err
}

func (h *DaemonHub) UpsertAgentProfile(ctx context.Context, input store.CreateAgentProfileInput) (store.AgentProfileProjection, error) {
	connection := h.connectionFor(input.DeviceID)
	value, err := callDevice[wsAgentProfileUpsertedPayload](ctx, connection, wsUpsertAgentProfileType, wsUpsertAgentProfilePayload{Profile: input})
	if err != nil {
		return store.AgentProfileProjection{}, err
	}
	if err := connection.registrationAnswered(value.Registration); err != nil {
		return store.AgentProfileProjection{}, err
	}
	return value.Profile, nil
}

func (h *DaemonHub) UpsertAgentRuntimeSettings(ctx context.Context, input store.UpsertAgentRuntimeSettingsInput) (store.AgentRuntimeSettings, error) {
	connection := h.connectionFor(input.DeviceID)
	value, err := callDevice[wsAgentRuntimeSettingsUpsertedPayload](ctx, connection, wsUpsertRuntimeSettingsType,
		wsUpsertAgentRuntimeSettingsPayload{Settings: input.Settings})
	if err != nil {
		return store.AgentRuntimeSettings{}, err
	}
	if err := connection.registrationAnswered(value.Registration); err != nil {
		return store.AgentRuntimeSettings{}, err
	}
	return value.Settings, nil
}

func (h *DaemonHub) ListAgentModels(ctx context.Context, input store.CreateAgentProfileInput) ([]store.AgentModelOption, error) {
	value, err := callDevice[wsAgentModelsListedPayload](ctx, h.connectionFor(input.DeviceID), wsListAgentModelsType, wsListAgentModelsPayload{Profile: input})
	return value.Models, err
}

// ReadProviderKey asks the device for the key one of its API providers'
// configuration names, so promotion can seal it server-side. It targets one
// device explicitly: the key is machine-local state and no other daemon can
// answer for it. The value is returned to the caller for sealing and never
// logged, echoed in an error, or persisted anywhere but the secret store.
func (h *DaemonHub) ReadProviderKey(ctx context.Context, deviceID string, profileID string) (keySource string, credential string, err error) {
	value, err := callDevice[wsProviderKeyReadPayload](ctx, h.connectionFor(deviceID), wsReadProviderKeyType,
		wsReadProviderKeyPayload{ProfileID: profileID})
	return value.KeySource, value.Credential, err
}

// RefreshDeviceResources has a device detect its resources again, after
// asking the person there for access to requestAccess when it is set, and
// stores what it reports.
func (h *DaemonHub) RefreshDeviceResources(ctx context.Context, deviceID, requestAccess string) (wsResourcesRefreshedPayload, error) {
	connection := h.connectionFor(deviceID)
	value, err := callDevice[wsResourcesRefreshedPayload](ctx, connection, wsRefreshResourcesType, wsRefreshResourcesPayload{RequestAccess: requestAccess})
	if err != nil {
		return wsResourcesRefreshedPayload{}, err
	}
	if value.Registration.Device.ID != "" {
		if err := connection.syncRegistration(value.Registration); err != nil {
			return wsResourcesRefreshedPayload{}, err
		}
		connection.reportLegacyResources(ctx, value.Registration)
	}
	return value, nil
}

func (h *DaemonHub) cancelExactAssistantInput(ctx context.Context, session store.AgentSession) (wsSessionCanceledPayload, error) {
	return callDevice[wsSessionCanceledPayload](ctx, h.connectionFor(session.DeviceID), wsCancelSessionType, wsCancelSessionPayload{SessionID: session.ID, InputID: session.Input.ID})
}
