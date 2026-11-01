package httpapi

import (
	"context"
	"errors"
	"net/http"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// File access is reauthorized on every use, including delayed initialization.
// A cached index or a reference never makes a formerly private workspace safe.
func (s *Server) knowledgeWorkspace(ctx context.Context, user string, v store.KnowledgeVault) (store.WorkspaceProjection, error) {
	account, err := s.store.GetUser(ctx, user)
	if err != nil || !account.Active() {
		return store.WorkspaceProjection{}, store.ErrNotFound
	}
	workspace, err := s.store.GetWorkspace(ctx, v.WorkspaceID)
	if err != nil {
		return workspace, err
	}
	roles, err := s.store.WorkspaceRolesForUser(ctx, user)
	if err != nil {
		return workspace, err
	}
	if roles[workspace.ID] != store.WorkspaceRoleOwner {
		return workspace, &statusError{http.StatusForbidden, errors.New("knowledge_owner_required")}
	}
	if err := store.RequireDeviceAvailable(ctx, s.store, workspace.DeviceID); err != nil {
		return workspace, err
	}
	if workspace.DeviceID != v.DeviceID || workspace.ArchivedAt != "" || workspace.UnavailableOnDevice != nil {
		return workspace, invalid("knowledge_location_unavailable")
	}
	if v.Kind == "memory" {
		devices, err := s.store.DevicesOwnedBy(ctx, user)
		if err != nil {
			return workspace, err
		}
		if !slices.Contains(devices, workspace.DeviceID) {
			return workspace, invalid("memory_device_must_be_owned")
		}
		members, err := s.store.ListWorkspaceMembers(ctx, workspace.ID)
		if err != nil {
			return workspace, err
		}
		if len(members) != 1 {
			return workspace, invalid("memory_workspace_must_be_private")
		}
	}
	return workspace, nil
}
func (s *Server) handleKnowledgeVaults(w http.ResponseWriter, r *http.Request) {
	vaults, err := s.store.ListKnowledgeVaults(r.Context(), s.personFrom(r).ID)
	writeResult(w, vaults, err)
}
func (s *Server) handleCreateKnowledgeVault(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Kind        string `json:"kind"`
		WorkspaceID string `json:"workspaceId"`
		DeviceID    string `json:"deviceId"`
		RootPath    string `json:"rootPath"`
		CreateNew   bool   `json:"createNew"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	ctx := r.Context()
	user := s.personFrom(r).ID
	if input.Kind == "" {
		input.Kind = "memory"
	}
	if input.RootPath == "" {
		input.RootPath = "knowledge"
	}
	if input.Kind != "memory" && input.Kind != "domain" {
		writeError(w, http.StatusBadRequest, "choose memory or domain knowledge")
		return
	}
	if path.IsAbs(input.RootPath) || strings.Contains(input.RootPath, "\\") || strings.Contains(input.RootPath, "\x00") || len(input.RootPath) > 500 {
		writeError(w, http.StatusBadRequest, "choose a relative folder inside the workspace")
		return
	}
	for _, part := range strings.Split(input.RootPath, "/") {
		if part == ".." || part == ".git" {
			writeError(w, http.StatusBadRequest, "knowledge path may not escape the workspace")
			return
		}
	}
	input.RootPath = path.Clean(input.RootPath)
	idParts := []string{user, input.Kind}
	if input.Kind == "domain" {
		idParts = append(idParts, input.WorkspaceID)
	}
	if input.CreateNew {
		if input.Kind != "memory" || input.WorkspaceID != "" {
			writeResult(w, nil, invalid("new memory location may not also select an existing workspace"))
			return
		}
		if old, err := s.store.GetKnowledgeVault(ctx, user, flow.Key("vault", idParts...)); err == nil {
			writeResult(w, old, nil)
			return
		} else if !errors.Is(err, store.ErrNotFound) {
			writeResult(w, nil, err)
			return
		}
		owned, err := s.store.DevicesOwnedBy(ctx, user)
		if err != nil || !slices.Contains(owned, input.DeviceID) {
			writeResult(w, nil, invalid("choose one of your own devices"))
			return
		}
		folder := flow.Key("personal-memory", user)
		connection := s.hub.connectionFor(input.DeviceID)
		if connection == nil {
			writeResult(w, nil, invalid("memory_device_offline: connect the device to create its private workspace"))
			return
		}
		_, registration := connection.registrationSnapshot()
		destination, err := managedWorkspacePath(registration.Device.ManagedRoots, "", folder)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		// Reuse a registered result if the prior creation response was lost.
		workspaces, err := s.store.ListWorkspaces(ctx)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		for _, workspace := range workspaces {
			if workspace.DeviceID == input.DeviceID && workspace.LocalPath == destination {
				input.WorkspaceID = workspace.ID
				break
			}
		}
		if input.WorkspaceID == "" {
			workspace, err := s.CreateWorkspace(ctx, WorkspaceActor{UserID: user}, WorkspaceCreateRequest{DeviceID: input.DeviceID, Name: "Personal Memory", FolderName: folder, Purpose: "Private, user-controlled knowledge sources and cross-workspace references", Create: &WorkspaceCreateSource{Kind: WorkspaceCreateEmpty, Files: []WorkspaceFile{{Path: "AGENTS.md", Content: "# Personal Memory\n\nThis workspace owns only the knowledge explicitly placed here. Domain documents and task execution state remain in their original workspaces and Foundry records. Use the controlled knowledge interface for revisions, forgetting and migration; do not silently overwrite source files or publish private text.\n"}}}})
			if err != nil {
				writeResult(w, nil, err)
				return
			}
			input.WorkspaceID = workspace.ID
		}
	}
	v := store.KnowledgeVault{ID: flow.Key("vault", idParts...), UserID: user, Kind: input.Kind, WorkspaceID: input.WorkspaceID, DeviceID: input.DeviceID, RootPath: input.RootPath}
	if _, err := s.knowledgeWorkspace(ctx, user, v); err != nil {
		writeResult(w, nil, err)
		return
	}
	v, err := s.store.CreateKnowledgeVault(ctx, v)
	if errors.Is(err, store.ErrIdempotencyConflict) {
		err = &statusError{http.StatusConflict, errors.New("memory already has a location; use explicit migration to change it")}
	}
	writeResultWithStatus(w, http.StatusAccepted, v, err)
}
func (s *Server) drainKnowledgeVaults(ctx context.Context) {
	vaults, err := s.store.PendingKnowledgeVaults(ctx)
	if err != nil {
		return
	}
	for _, v := range vaults {
		if ctx.Err() != nil {
			return
		}
		if v.State == "waiting" {
			if updated, err := time.Parse(time.RFC3339Nano, v.UpdatedAt); err == nil && time.Since(updated) < 10*time.Second {
				continue
			}
		}
		v.State, v.Reason = "waiting", "knowledge_location_unavailable"
		workspace, err := s.knowledgeWorkspace(ctx, v.UserID, v)
		if err == nil {
			runCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			result, callErr := s.hub.knowledgeCommand(runCtx, workspace, store.KnowledgeCommand{WorkspaceID: v.WorkspaceID, RootPath: v.RootPath, VaultID: v.ID, Epoch: v.Epoch, Action: "initialize", OperationID: flow.Key("kinit", v.ID)})
			cancel()
			err = callErr
			if err == nil && result.VaultID == v.ID && result.Epoch == v.Epoch && result.State == "active" {
				v.State, v.Reason = "active", ""
			} else if err != nil {
				v.Reason = knowledgeWaitingReason(err)
			}
		} else {
			v.Reason = knowledgeWaitingReason(err)
		}
		_, _ = s.store.SaveKnowledgeVault(ctx, v)
	}
}
func knowledgeWaitingReason(err error) string {
	for _, code := range []string{"memory_device_offline", "memory_worker_update_required", "knowledge_owner_required", "memory_workspace_must_be_private", "memory_device_must_be_owned", "not_empty", "fenced", "unsafe_path", "locked", "revision_conflict", "external_edit", "forgotten", "idempotency_conflict"} {
		if strings.Contains(err.Error(), code) {
			return code
		}
	}
	return "knowledge_location_unavailable"
}

// drainKnowledgeOperations moves every knowledge queue on by one pass.
func (s *Server) drainKnowledgeOperations(ctx context.Context) {
	s.drainKnowledgeVaults(ctx)
	s.drainKnowledgeMutations(ctx)
	s.drainKnowledgeMigrations(ctx)
	s.drainKnowledgeReplicaForgets(ctx)
}

func (s *Server) handleLegacyKnowledgeTransfer(w http.ResponseWriter, r *http.Request) {
	user := s.personFrom(r).ID
	v, err := s.primaryKnowledgeVault(r.Context(), user)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if _, err = s.knowledgeWorkspace(r.Context(), user, v); err != nil {
		writeResult(w, nil, err)
		return
	}
	var input struct {
		UpdatedAt string `json:"updatedAt"`
		BodyHash  string `json:"bodyHash"`
		Confirmed bool   `json:"confirmed"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !input.Confirmed || !maintenanceHash(input.BodyHash) {
		writeResult(w, nil, invalid("review and explicitly confirm the legacy fact before transferring its authority"))
		return
	}
	job, err := s.store.TransferPersonalAgentMemory(r.Context(), user, r.PathValue("id"), v.ID, input.UpdatedAt, input.BodyHash)
	writeResultWithStatus(w, http.StatusAccepted, job, err)
}

func (s *Server) handleResetPendingKnowledgeLocation(w http.ResponseWriter, r *http.Request) {
	v, err := s.knowledgeVaultForRequest(r)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	var input struct {
		Revision    int64  `json:"revision"`
		DeviceID    string `json:"deviceId"`
		WorkspaceID string `json:"workspaceId"`
		RootPath    string `json:"rootPath"`
		Confirmed   bool   `json:"confirmed"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !input.Confirmed || input.RootPath == "" || path.IsAbs(input.RootPath) || strings.ContainsAny(input.RootPath, "\\\x00") || len(input.RootPath) > 500 {
		writeResult(w, nil, invalid("confirm a relative empty source folder"))
		return
	}
	for _, part := range strings.Split(input.RootPath, "/") {
		if part == ".." || part == ".git" {
			writeResult(w, nil, invalid("source path cannot escape its workspace"))
			return
		}
	}
	v.Revision = input.Revision
	v.DeviceID = input.DeviceID
	v.WorkspaceID = input.WorkspaceID
	v.RootPath = path.Clean(input.RootPath)
	if _, err = s.knowledgeWorkspace(r.Context(), v.UserID, v); err != nil {
		writeResult(w, nil, err)
		return
	}
	saved, err := s.store.ResetPendingKnowledgeVault(r.Context(), v)
	writeResultWithStatus(w, http.StatusAccepted, saved, err)
}
