package knowledge

import (
	"context"
	"errors"
	"net/http"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Workspace is the vault's workspace, if its person may use it now. File
// access is reauthorized on every use, including delayed initialization.
// A cached index or a reference never makes a formerly private workspace safe.
func (s *Service) Workspace(ctx context.Context, user string, v store.KnowledgeVault) (store.WorkspaceProjection, error) {
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
		return workspace, &personalagent.Refusal{Status: http.StatusForbidden, Err: errors.New("knowledge_owner_required")}
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

// VaultRequest chooses where a vault's sources live: Kind memory (the
// person's layer, one per person; an assistant's layer is made by
// EnsureMemoryLayer) or domain (a project's); CreateNew makes the
// person's private Personal Memory workspace on DeviceID for it.
type VaultRequest struct {
	Kind        string `json:"kind"`
	WorkspaceID string `json:"workspaceId"`
	DeviceID    string `json:"deviceId"`
	RootPath    string `json:"rootPath"`
	CreateNew   bool   `json:"createNew"`
}

// CreateVault records a vault for user's sources, to be initialized on its
// device (drainVaults). existing: CreateNew found the person's memory vault
// already there, which is answered as it is.
func (s *Service) CreateVault(ctx context.Context, user string, input VaultRequest) (vault store.KnowledgeVault, existing bool, err error) {
	if input.Kind == "" {
		input.Kind = "memory"
	}
	if input.RootPath == "" {
		input.RootPath = "knowledge"
	}
	if input.Kind != "memory" && input.Kind != "domain" {
		return vault, false, &personalagent.Refusal{Status: http.StatusBadRequest, Err: errors.New("choose memory or domain knowledge")}
	}
	if path.IsAbs(input.RootPath) || strings.Contains(input.RootPath, "\\") || strings.Contains(input.RootPath, "\x00") || len(input.RootPath) > 500 {
		return vault, false, &personalagent.Refusal{Status: http.StatusBadRequest, Err: errors.New("choose a relative folder inside the workspace")}
	}
	for _, part := range strings.Split(input.RootPath, "/") {
		if part == ".." || part == ".git" {
			return vault, false, &personalagent.Refusal{Status: http.StatusBadRequest, Err: errors.New("knowledge path may not escape the workspace")}
		}
	}
	input.RootPath = path.Clean(input.RootPath)
	idParts := []string{user, input.Kind}
	if input.Kind == "domain" {
		idParts = append(idParts, input.WorkspaceID)
	}
	if input.CreateNew {
		if input.Kind != "memory" || input.WorkspaceID != "" {
			return vault, false, invalid("new memory location may not also select an existing workspace")
		}
		if old, err := s.store.GetKnowledgeVault(ctx, user, flow.Key("vault", idParts...)); err == nil {
			return old, true, nil
		} else if !errors.Is(err, store.ErrNotFound) {
			return vault, false, err
		}
		owned, err := s.store.DevicesOwnedBy(ctx, user)
		if err != nil || !slices.Contains(owned, input.DeviceID) {
			return vault, false, invalid("choose one of your own devices")
		}
		folder := flow.Key("personal-memory", user)
		destination, connected, err := s.workspaces.NewFolderPath(input.DeviceID, folder)
		if !connected {
			return vault, false, invalid("memory_device_offline: connect the device to create its private workspace")
		}
		if err != nil {
			return vault, false, err
		}
		// Reuse a registered result if the prior creation response was lost.
		workspaces, err := s.store.ListWorkspaces(ctx)
		if err != nil {
			return vault, false, err
		}
		for _, workspace := range workspaces {
			if workspace.DeviceID == input.DeviceID && workspace.LocalPath == destination {
				input.WorkspaceID = workspace.ID
				break
			}
		}
		if input.WorkspaceID == "" {
			workspace, err := s.workspaces.CreateWorkspace(ctx, personalagent.WorkspaceActor{UserID: user}, personalagent.NewWorkspace{DeviceID: input.DeviceID, Name: "Personal Memory", FolderName: folder, Purpose: "Private, user-controlled knowledge sources and cross-workspace references", Create: &personalagent.WorkspaceSource{Kind: personalagent.WorkspaceCreateEmpty, Files: []personalagent.WorkspaceFile{{Path: "AGENTS.md", Content: "# Personal Memory\n\nThis workspace owns only the knowledge explicitly placed here. Domain documents and task execution state remain in their original workspaces and Foundry records. Use the controlled knowledge interface for revisions, forgetting and migration; do not silently overwrite source files or publish private text.\n"}}}})
			if err != nil {
				return vault, false, err
			}
			input.WorkspaceID = workspace.ID
		}
	}
	v := store.KnowledgeVault{ID: flow.Key("vault", idParts...), UserID: user, Kind: input.Kind, WorkspaceID: input.WorkspaceID, DeviceID: input.DeviceID, RootPath: input.RootPath}
	if _, err := s.Workspace(ctx, user, v); err != nil {
		return vault, false, err
	}
	v, err = s.store.CreateKnowledgeVault(ctx, v)
	if errors.Is(err, store.ErrIdempotencyConflict) {
		err = &personalagent.Refusal{Status: http.StatusConflict, Err: errors.New("memory already has a location; use explicit migration to change it")}
	}
	return v, false, err
}

func (s *Service) drainVaults(ctx context.Context) {
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
		workspace, err := s.Workspace(ctx, v.UserID, v)
		if err == nil {
			runCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			result, callErr := s.devices.KnowledgeCommand(runCtx, workspace, store.KnowledgeCommand{WorkspaceID: v.WorkspaceID, RootPath: v.RootPath, VaultID: v.ID, Epoch: v.Epoch, Action: "initialize", OperationID: flow.Key("kinit", v.ID)})
			cancel()
			err = callErr
			if err == nil && result.VaultID == v.ID && result.Epoch == v.Epoch && result.State == "active" {
				v.State, v.Reason = "active", ""
			} else if err != nil {
				v.Reason = waitingReason(err)
			}
		} else {
			v.Reason = waitingReason(err)
		}
		_, _ = s.store.SaveKnowledgeVault(ctx, v)
	}
}

func waitingReason(err error) string {
	for _, code := range []string{"memory_device_offline", "memory_worker_update_required", "knowledge_owner_required", "memory_workspace_must_be_private", "memory_device_must_be_owned", "not_empty", "fenced", "unsafe_path", "locked", "revision_conflict", "external_edit", "forgotten", "idempotency_conflict"} {
		if strings.Contains(err.Error(), code) {
			return code
		}
	}
	return "knowledge_location_unavailable"
}

// Drain moves every knowledge queue on by one pass.
func (s *Service) Drain(ctx context.Context) {
	s.drainVaults(ctx)
	s.drainMutations(ctx)
	s.drainMigrations(ctx)
	s.drainReplicaForgets(ctx)
	s.drainLegacyMemory(ctx)
	s.drainMemorySorts(ctx)
}

// LegacyTransfer is the person's confirmation of a legacy fact
// (pa_memory) they reviewed, to move into their memory vault.
type LegacyTransfer struct {
	UpdatedAt string `json:"updatedAt"`
	BodyHash  string `json:"bodyHash"`
	Confirmed bool   `json:"confirmed"`
}

// TransferLegacy moves the confirmed legacy fact memoryID into v, the
// person's memory vault (MemoryVault), as a durable write.
func (s *Service) TransferLegacy(ctx context.Context, user string, v store.KnowledgeVault, memoryID string, input LegacyTransfer) (store.KnowledgeMutation, error) {
	if !input.Confirmed || !personalagent.IsSHA256Hex(input.BodyHash) {
		return store.KnowledgeMutation{}, invalid("review and explicitly confirm the legacy fact before transferring its authority")
	}
	return s.store.TransferPersonalAgentMemory(ctx, user, memoryID, v.ID, input.UpdatedAt, input.BodyHash)
}

// MemoryVault is the person's memory layer, authorized for use now.
func (s *Service) MemoryVault(ctx context.Context, user string) (store.KnowledgeVault, error) {
	return s.AuthorizedVault(ctx, user, MemoryLayerID(user, ""))
}

// LocationReset moves a vault that never became active to another folder.
type LocationReset struct {
	Revision    int64  `json:"revision"`
	DeviceID    string `json:"deviceId"`
	WorkspaceID string `json:"workspaceId"`
	RootPath    string `json:"rootPath"`
	Confirmed   bool   `json:"confirmed"`
}

// ResetPendingLocation points the pending vault v at another empty folder.
func (s *Service) ResetPendingLocation(ctx context.Context, v store.KnowledgeVault, input LocationReset) (store.KnowledgeVault, error) {
	if !input.Confirmed || input.RootPath == "" || path.IsAbs(input.RootPath) || strings.ContainsAny(input.RootPath, "\\\x00") || len(input.RootPath) > 500 {
		return store.KnowledgeVault{}, invalid("confirm a relative empty source folder")
	}
	for _, part := range strings.Split(input.RootPath, "/") {
		if part == ".." || part == ".git" {
			return store.KnowledgeVault{}, invalid("source path cannot escape its workspace")
		}
	}
	v.Revision = input.Revision
	v.DeviceID = input.DeviceID
	v.WorkspaceID = input.WorkspaceID
	v.RootPath = path.Clean(input.RootPath)
	if _, err := s.Workspace(ctx, v.UserID, v); err != nil {
		return store.KnowledgeVault{}, err
	}
	return s.store.ResetPendingKnowledgeVault(ctx, v)
}

// AuthorizedVault is user's vault vaultID, authorized for use now
// (Workspace).
func (s *Service) AuthorizedVault(ctx context.Context, user, vaultID string) (store.KnowledgeVault, error) {
	v, err := s.store.GetKnowledgeVault(ctx, user, vaultID)
	if err != nil {
		return v, err
	}
	_, err = s.Workspace(ctx, v.UserID, v)
	return v, err
}

// PrimaryVault is the person's memory layer, as recorded.
func (s *Service) PrimaryVault(ctx context.Context, user string) (store.KnowledgeVault, error) {
	return s.store.GetKnowledgeVault(ctx, user, MemoryLayerID(user, ""))
}
