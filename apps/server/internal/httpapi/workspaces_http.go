package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// noWorkspaceSelected asks a data read for no workspace: the person removed
// the one they were in and has not switched to another yet.
const noWorkspaceSelected = "none"

func selectWorkspace(ctx context.Context, st store.Store, workspaces []store.WorkspaceProjection, workspaceID string) (store.WorkspaceProjection, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID != "" && workspaceID != noWorkspaceSelected {
		return st.GetWorkspace(ctx, workspaceID)
	}
	if len(workspaces) > 0 && workspaceID != noWorkspaceSelected {
		return workspaces[0], nil
	}
	return store.WorkspaceProjection{
		ID:             "",
		Name:           "No workspace",
		LocalPath:      "Run local daemon setup",
		Baseline:       "main",
		ContextSummary: "No local daemon has registered a workspace yet.",
		AcceptedCount:  0,
		ResolvedCount:  0,
	}, nil
}

func (s *Server) handleListWorkspaces(w http.ResponseWriter, r *http.Request) {
	view, err := s.visibilityFor(r.Context(), actorFromContext(r.Context()))
	writeResult(w, view.workspaces, err)
}

func (s *Server) handleGetWorkspace(w http.ResponseWriter, r *http.Request) {
	item, err := s.store.GetWorkspace(r.Context(), r.PathValue("id"))
	if err == nil {
		scope, scopeErr := s.requestScope(r)
		if scopeErr != nil {
			writeResult(w, nil, scopeErr)
			return
		}
		item.AccessRole = scope.role(item.ID)
	}
	writeResult(w, item, err)
}

func (s *Server) handleCreateWorkspace(w http.ResponseWriter, r *http.Request) {
	var input store.CreateWorkspaceInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceOwner(w, r, strings.TrimSpace(input.DeviceID)) {
		return
	}
	path := strings.TrimSpace(input.Path)
	if path == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	item, err := s.hub.SetupWorkspace(ctx, strings.TrimSpace(input.DeviceID), path)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "local daemon is not connected")
		return
	}
	if errors.Is(err, store.ErrWorkspaceOwnedByAnotherDevice) {
		writeError(w, http.StatusConflict, "This folder is already a workspace of another device. Open it there, or remove it from that device first.")
		return
	}
	// The device keeps working after the wait ends, and a late answer still
	// registers the folder.
	if errors.Is(err, context.DeadlineExceeded) {
		writeError(w, http.StatusGatewayTimeout, "The device did not finish setting up this folder within 60 seconds. It may still be working on it (a large folder takes longer the first time): check the device's Workspaces in a minute before trying again.")
		return
	}
	writeResultWithStatus(w, http.StatusCreated, item, err)
}

func (s *Server) handleRenameWorkspace(w http.ResponseWriter, r *http.Request) {
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
	item, err := s.store.RenameWorkspace(r.Context(), r.PathValue("id"), name)
	if err == nil {
		// The workspace list every view shows changed, and the catalog's
		// list of the workspaces using each skill.
		s.projectionsChanged("", fieldWorkspaces, fieldPromotedSkills)
	}
	writeResult(w, item, err)
}

func (s *Server) handleDeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "workspace id is required")
		return
	}
	workspace, err := s.store.DeleteWorkspace(r.Context(), id)
	if errors.Is(err, store.ErrWorkspaceBusy) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	// Other workspaces' views read what changed for them; the workspace's
	// own viewers have nothing left to read.
	s.projectionsChanged("", workspaceRemovalFields...)
	s.feishuBotsChanged(r.Context())
	if workspace.DeviceID != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := s.hub.ForgetWorkspace(ctx, workspace); err != nil && !errors.Is(err, store.ErrNotFound) {
			log.Printf("daemon forget workspace failed id=%s path=%s: %v", workspace.ID, workspace.LocalPath, err)
		}
	}
	writeResult(w, workspace, nil)
}

func (s *Server) handleListWorkspaceSubdirectories(w http.ResponseWriter, r *http.Request) {
	var input store.CreateWorkspaceInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceOwner(w, r, strings.TrimSpace(input.DeviceID)) {
		return
	}
	path := strings.TrimSpace(input.Path)
	if path == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	items, err := s.hub.ListSubdirectories(ctx, strings.TrimSpace(input.DeviceID), path)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "local daemon is not connected")
		return
	}
	writeResult(w, items, err)
}

func (s *Server) handleListWorkspaceFiles(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListWorkspaceFiles(r.Context(), r.URL.Query().Get("workspaceId"))
	writeResult(w, items, err)
}

func (s *Server) handleReadWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimSpace(r.URL.Query().Get("workspaceId"))
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if workspaceID == "" || path == "" {
		writeError(w, http.StatusBadRequest, "workspaceId and path are required")
		return
	}
	workspace, err := s.store.GetWorkspace(r.Context(), workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), deviceFileRequestTimeout)
	defer cancel()
	result, err := s.hub.ReadWorkspaceFile(ctx, workspace, path)
	writeResult(w, result, deviceRequestError(workspace, err))
}

// handleListWorkspaceTree lists one folder of the workspace for the file
// browser; the device refuses paths outside the workspace.
func (s *Server) handleListWorkspaceTree(w http.ResponseWriter, r *http.Request) {
	workspace, err := s.store.GetWorkspace(r.Context(), strings.TrimSpace(r.URL.Query().Get("workspaceId")))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), deviceFileRequestTimeout)
	defer cancel()
	entries, err := s.hub.ListWorkspaceTree(ctx, workspace, strings.TrimSpace(r.URL.Query().Get("path")))
	writeResult(w, entries, deviceRequestError(workspace, err))
}

func (s *Server) handleListAssets(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListAssets(r.Context(), r.URL.Query().Get("workspaceId"))
	writeResult(w, items, err)
}

func (s *Server) handleListSkills(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListSkills(r.Context(), r.URL.Query().Get("workspaceId"))
	writeResult(w, items, err)
}
