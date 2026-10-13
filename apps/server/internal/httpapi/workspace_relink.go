package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Locating a workspace's folder: the person moved or renamed it on the
// device, and points Foundry at it. The workspace keeps its id and with it
// its chats, sessions, Issues, settings, Feishu routes and connector
// bindings; its device makes its native chats resumable in the new folder.

type wsNativeSessionRef struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
}

type wsRelinkWorkspacePayload struct {
	WorkspaceID    string               `json:"workspaceId"`
	Path           string               `json:"path"`
	PreviousPath   string               `json:"previousPath"`
	NativeSessions []wsNativeSessionRef `json:"nativeSessions"`
}

type wsWorkspaceRelinkedPayload struct {
	Registration   store.DaemonRegistration           `json:"registration"`
	NativeSessions store.WorkspaceNativeSessionsMoved `json:"nativeSessions"`
	Error          string                             `json:"error,omitempty"`
}

type wsFindMovedWorkspacePayload struct {
	WorkspaceID  string `json:"workspaceId"`
	PreviousPath string `json:"previousPath"`
}

type wsMovedWorkspaceFoundPayload struct {
	Suggestions []store.WorkspaceRelinkSuggestion `json:"suggestions"`
	Error       string                            `json:"error,omitempty"`
}

// errWorkerCannotRelink: the device's worker predates locating folders.
var errWorkerCannotRelink = errors.New("this device's worker is too old to locate a workspace's folder; update the worker from the device's page and try again")

// errDeviceRefused carries the device's own refusal (the folder does not
// exist, is not readable, …): the person reads it as it is.
type errDeviceRefused struct{ message string }

func (e errDeviceRefused) Error() string { return e.message }

// errFolderTaken: the folder is another live workspace of the device.
type errFolderTaken struct{ name, device string }

func (e errFolderTaken) Error() string {
	return fmt.Sprintf("This folder is already the workspace “%s” on %s. Remove that workspace first, then try again.", e.name, e.device)
}

// workspaceNativeSessionLister lists the native sessions of a live
// workspace's chats.
type workspaceNativeSessionLister interface {
	WorkspaceNativeSessions(ctx context.Context, workspaceID string) ([]store.NativeSessionRef, error)
}

func (c *daemonConnection) relinkWorkspace(ctx context.Context, payload wsRelinkWorkspacePayload) (wsWorkspaceRelinkedPayload, error) {
	if !c.hasCapability(store.DaemonCapabilityWorkspaceFolders) {
		return wsWorkspaceRelinkedPayload{}, errWorkerCannotRelink
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return wsWorkspaceRelinkedPayload{}, err
	}
	value, err := daemonRequest[wsWorkspaceRelinkedPayload](ctx, c, wsRelinkWorkspaceType, encoded)
	if err != nil {
		return wsWorkspaceRelinkedPayload{}, err
	}
	if value.Error != "" {
		return wsWorkspaceRelinkedPayload{}, errDeviceRefused{value.Error}
	}
	if value.Registration.Device.ID == "" || value.Registration.Workspace.ID != payload.WorkspaceID {
		return wsWorkspaceRelinkedPayload{}, errors.New("the device answered without the workspace")
	}
	return value, nil
}

func (c *daemonConnection) findMovedWorkspace(ctx context.Context, workspaceID, previousPath string) ([]store.WorkspaceRelinkSuggestion, error) {
	if !c.hasCapability(store.DaemonCapabilityWorkspaceFolders) {
		return []store.WorkspaceRelinkSuggestion{}, nil
	}
	encoded, err := json.Marshal(wsFindMovedWorkspacePayload{WorkspaceID: workspaceID, PreviousPath: previousPath})
	if err != nil {
		return nil, err
	}
	value, err := daemonRequest[wsMovedWorkspaceFoundPayload](ctx, c, wsFindMovedWorkspaceType, encoded)
	if err != nil {
		return nil, err
	}
	if value.Error != "" {
		return nil, errors.New(value.Error)
	}
	if value.Suggestions == nil {
		value.Suggestions = []store.WorkspaceRelinkSuggestion{}
	}
	return value.Suggestions, nil
}

// relinkFolder asks the workspace's device to serve it from folder. Nothing
// changes on the server when the device refuses.
func (s *Server) relinkFolder(ctx context.Context, workspace store.WorkspaceProjection, folder string,
	refs []store.NativeSessionRef) (store.WorkspaceRelinkResult, error) {
	connection := s.hub.connectionFor(workspace.DeviceID)
	if workspace.DeviceID == "" || connection == nil {
		return store.WorkspaceRelinkResult{}, store.ErrNotFound
	}
	if err := s.folderFree(ctx, workspace, folder); err != nil {
		return store.WorkspaceRelinkResult{}, err
	}
	sessions := make([]wsNativeSessionRef, 0, len(refs))
	for _, ref := range refs {
		sessions = append(sessions, wsNativeSessionRef{Provider: ref.Provider, ID: ref.NativeSessionID})
	}
	value, err := connection.relinkWorkspace(ctx, wsRelinkWorkspacePayload{
		WorkspaceID:    workspace.ID,
		Path:           folder,
		PreviousPath:   workspace.LocalPath,
		NativeSessions: sessions,
	})
	if err != nil {
		return store.WorkspaceRelinkResult{}, err
	}
	registration := value.Registration
	registration.Workspace.DeviceID = registration.Device.ID
	registration.Workspace.DeviceLabel = registration.Device.Label
	if err := connection.syncRegistration(registration); err != nil {
		return store.WorkspaceRelinkResult{}, err
	}
	go connection.dispatchQueuedAgentSessions(workspace.ID)
	// Its folder and availability changed for every view.
	s.projectionsChanged("", workspaceRemovalFields...)
	s.feishuBotsChanged(ctx)
	located, err := s.store.GetWorkspace(ctx, workspace.ID)
	if err != nil {
		return store.WorkspaceRelinkResult{}, err
	}
	log.Printf("workspace %s now at %s on %s (was %s); native sessions copied=%d already=%d not found=%d",
		workspace.ID, located.LocalPath, located.DeviceLabel, workspace.LocalPath,
		value.NativeSessions.Copied, value.NativeSessions.AlreadyThere, value.NativeSessions.NotFound)
	return store.WorkspaceRelinkResult{Workspace: located, NativeSessions: value.NativeSessions}, nil
}

// folderFree refuses a folder that is another live workspace of the device.
func (s *Server) folderFree(ctx context.Context, workspace store.WorkspaceProjection, folder string) error {
	workspaces, err := s.store.ListWorkspaces(ctx)
	if err != nil {
		return err
	}
	clean := path.Clean(strings.TrimSpace(folder))
	for _, other := range workspaces {
		if other.ID != workspace.ID && other.DeviceID == workspace.DeviceID && path.Clean(other.LocalPath) == clean {
			device := other.DeviceLabel
			if device == "" {
				device = "this device"
			}
			return errFolderTaken{name: other.Name, device: device}
		}
	}
	return nil
}

// writeRelinkError answers a failed locate with what the person
// can act on.
func writeRelinkError(w http.ResponseWriter, err error) {
	var refused errDeviceRefused
	var taken errFolderTaken
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusConflict, "The device is offline. Reconnect it, then try again.")
	case errors.As(err, &taken):
		writeError(w, http.StatusConflict, taken.Error())
	case errors.As(err, &refused):
		writeError(w, http.StatusUnprocessableEntity, refused.Error())
	case errors.Is(err, errWorkerCannotRelink):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, context.DeadlineExceeded):
		writeError(w, http.StatusGatewayTimeout, "The device did not answer within a minute. Check the Workspaces page in a moment before trying again.")
	default:
		writeResult(w, nil, err)
	}
}

func decodeFolder(w http.ResponseWriter, r *http.Request) (string, bool) {
	var input struct {
		Path string `json:"path"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return "", false
	}
	folder := strings.TrimSpace(input.Path)
	if folder == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return "", false
	}
	return folder, true
}

// handleRelinkWorkspace serves a workspace from the folder the person
// located on its device.
func (s *Server) handleRelinkWorkspace(w http.ResponseWriter, r *http.Request) {
	folder, ok := decodeFolder(w, r)
	if !ok {
		return
	}
	workspace, err := s.store.GetWorkspace(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	refs, err := s.store.WorkspaceNativeSessions(r.Context(), workspace.ID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	result, err := s.relinkFolder(ctx, workspace, folder, refs)
	if err != nil {
		writeRelinkError(w, err)
		return
	}
	writeResult(w, result, nil)
}

// handleWorkspaceRelinkSuggestions lists folders on the device that look
// like the workspace's, moved. An offline device suggests nothing.
func (s *Server) handleWorkspaceRelinkSuggestions(w http.ResponseWriter, r *http.Request) {
	workspace, err := s.store.GetWorkspace(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	suggestions := []store.WorkspaceRelinkSuggestion{}
	if connection := s.hub.connectionFor(workspace.DeviceID); workspace.DeviceID != "" && connection != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		found, err := connection.findMovedWorkspace(ctx, workspace.ID, workspace.LocalPath)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		suggestions = found
	}
	writeResult(w, map[string]any{"suggestions": suggestions}, nil)
}
