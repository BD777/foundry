package httpapi

import (
	"errors"
	"log"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The HTTP side of moving a workspace to another device (DEV-146): start a
// move, read it, cancel it, and delete the old copy once it is complete.

func writeMigrationError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"code": code, "error": message})
}

// validMigrationTargetPath accepts an absolute folder, or one under the
// device user's home (~/…), as the worker resolves it.
func validMigrationTargetPath(folder string) bool {
	if folder == "" || len(folder) > 1024 || strings.ContainsRune(folder, 0) {
		return false
	}
	if strings.HasPrefix(folder, "~/") || path.IsAbs(folder) {
		return true
	}
	// A Windows drive path.
	return len(folder) > 2 && folder[1] == ':' && (folder[2] == '\\' || folder[2] == '/')
}

func (s *Server) handleCreateWorkspaceMigration(w http.ResponseWriter, r *http.Request) {
	var input struct {
		TargetDeviceID string `json:"targetDeviceId"`
		TargetPath     string `json:"targetPath"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	targetDevice, targetPath := strings.TrimSpace(input.TargetDeviceID), strings.TrimSpace(input.TargetPath)
	if targetDevice == "" || !validMigrationTargetPath(targetPath) {
		writeMigrationError(w, http.StatusBadRequest, "invalid_request", "targetDeviceId and an absolute targetPath are required")
		return
	}
	// The actor adds a workspace on the target device: they must own it.
	if !s.requireDeviceOwner(w, r, targetDevice) {
		return
	}
	ctx := r.Context()
	workspace, err := s.store.GetWorkspace(ctx, r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	switch {
	case workspace.DeviceID == "":
		writeMigrationError(w, http.StatusConflict, migrationReasonDeviceOffline, "The workspace has no device to move it from.")
		return
	case workspace.DeviceID == targetDevice:
		writeMigrationError(w, http.StatusBadRequest, "same_device", "The workspace is already on that device. To use another folder there, use Locate folder.")
		return
	case workspace.UnavailableOnDevice != nil:
		writeMigrationError(w, http.StatusConflict, "folder_missing", workspaceNotServedMessage(workspace))
		return
	}
	if workspace.Migration != nil && !store.WorkspaceMigrationEnded(workspace.Migration.State) {
		writeMigrationError(w, http.StatusConflict, "migration_active", "The workspace is already moving to "+cmpOr(workspace.Migration.TargetDeviceLabel, "another device")+".")
		return
	}
	for _, device := range []struct{ id, label string }{{workspace.DeviceID, workspace.DeviceLabel}, {targetDevice, ""}} {
		if s.hub.connectionFor(device.id) == nil {
			label := cmpOr(device.label, s.deviceLabel(ctx, device.id))
			writeMigrationError(w, http.StatusConflict, migrationReasonDeviceOffline, label+" is offline. Connect it, then move the workspace.")
			return
		}
	}
	record := store.WorkspaceMigrationRecord{
		WorkspaceMigration: store.WorkspaceMigration{
			ID: "wsmove_" + tunnelRandom()[:24], WorkspaceID: workspace.ID,
			SourceDeviceID: workspace.DeviceID, SourceDeviceLabel: cmpOr(workspace.DeviceLabel, workspace.DeviceID), SourcePath: workspace.LocalPath,
			TargetDeviceID: targetDevice, TargetDeviceLabel: s.deviceLabel(ctx, targetDevice), TargetPath: targetPath,
			Step: "queued",
		},
		ActorUserID: actorFromContext(ctx).AccountID(),
	}
	if err := s.targetFolderFree(ctx, record); err != nil {
		writeMigrationError(w, http.StatusConflict, migrationReasonPathTaken, err.Error())
		return
	}
	saved, err := s.store.CreateWorkspaceMigration(ctx, record)
	if errors.Is(err, store.ErrWorkspaceMigrationActive) {
		writeMigrationError(w, http.StatusConflict, "migration_active", err.Error())
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	log.Printf("workspace migration %s requested by %s: %s from %s to %s:%s", saved.ID, saved.ActorUserID, saved.WorkspaceID, saved.SourceDeviceID, saved.TargetDeviceID, saved.TargetPath)
	s.projectionsChanged("", fieldWorkspaces)
	s.hub.migrations.kick()
	writeJSON(w, http.StatusCreated, saved.WorkspaceMigration)
}

func (s *Server) handleCurrentWorkspaceMigration(w http.ResponseWriter, r *http.Request) {
	record, err := s.store.CurrentWorkspaceMigration(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeMigrationError(w, http.StatusNotFound, "no_migration", "The workspace was never moved.")
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeResult(w, record.WorkspaceMigration, nil)
}

func (s *Server) handleGetWorkspaceMigration(w http.ResponseWriter, r *http.Request) {
	record, err := s.store.GetWorkspaceMigration(r.Context(), r.PathValue("id"), r.PathValue("migrationId"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeResult(w, record.WorkspaceMigration, nil)
}

func (s *Server) handleCancelWorkspaceMigration(w http.ResponseWriter, r *http.Request) {
	record, err := s.store.RequestWorkspaceMigrationCancel(r.Context(), r.PathValue("id"), r.PathValue("migrationId"))
	if errors.Is(err, store.ErrWorkspaceMigrationNotCancelable) {
		writeMigrationError(w, http.StatusConflict, "not_cancelable", err.Error())
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	log.Printf("workspace migration %s: cancel requested by %s", record.ID, actorFromContext(r.Context()).AccountID())
	s.projectionsChanged("", fieldWorkspaces)
	s.hub.migrations.kick()
	writeResult(w, record.WorkspaceMigration, nil)
}

// handlePurgeWorkspaceMigrationSource deletes the old copy a complete move
// left on the source device: confirm false lists what it would remove.
func (s *Server) handlePurgeWorkspaceMigrationSource(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Confirm        bool `json:"confirm"`
		IncludeChanged bool `json:"includeChanged"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	ctx := r.Context()
	record, err := s.store.GetWorkspaceMigration(ctx, r.PathValue("id"), r.PathValue("migrationId"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if record.State != store.WorkspaceMigrationComplete {
		writeMigrationError(w, http.StatusConflict, "not_complete", "The old copy can be deleted once the move is complete.")
		return
	}
	if record.SourcePurge.State == "purged" {
		writeMigrationError(w, http.StatusConflict, "already_purged", "The old copy was already deleted.")
		return
	}
	// Deleting files on the source device is its owner's to do.
	if !s.requireDeviceOwner(w, r, record.SourceDeviceID) {
		return
	}
	workspace, err := s.store.GetWorkspace(ctx, record.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	// The workspace must be safe on the target first.
	if workspace.DeviceID != record.TargetDeviceID || workspace.UnavailableOnDevice != nil || s.hub.connectionFor(record.TargetDeviceID) == nil {
		writeMigrationError(w, http.StatusConflict, migrationReasonDeviceOffline,
			"Connect "+record.TargetDeviceLabel+" with the workspace served there before deleting the old copy.")
		return
	}
	source := s.hub.connectionFor(record.SourceDeviceID)
	if source == nil {
		writeMigrationError(w, http.StatusConflict, migrationReasonDeviceOffline, record.SourceDeviceLabel+" is offline. Connect it to delete the old copy.")
		return
	}
	timeout := time.Minute
	if input.Confirm {
		timeout = 10 * time.Minute
	}
	purged, err := askDevice[wsWorkspaceMigrationPurgedPayload](ctx, source, wsWorkspaceMigrationPurgeType, wsWorkspaceMigrationPurgePayload{
		MigrationID: record.ID, WorkspaceID: record.WorkspaceID, Confirm: input.Confirm, IncludeChanged: input.IncludeChanged,
	}, timeout)
	var refused errMigrationRefused
	switch {
	case errors.As(err, &refused):
		writeMigrationError(w, http.StatusUnprocessableEntity, migrationReasonRefused, refused.message)
		return
	case isDeviceTimeout(err):
		writeMigrationError(w, http.StatusGatewayTimeout, migrationReasonWorkerOutdated, record.SourceDeviceLabel+" did not answer. Update its worker, then try again.")
		return
	case err != nil:
		writeMigrationError(w, http.StatusConflict, migrationReasonDeviceOffline, err.Error())
		return
	}
	if input.Confirm {
		now := time.Now().UTC().Format(time.RFC3339Nano)
		if purged.Done {
			record.SourcePurge = store.WorkspaceMigrationSourcePurge{State: "purged", At: now, Bytes: purged.Bytes, Removed: len(purged.Removed)}
		} else {
			// Changed files were kept: the old copy is partly deleted.
			record.SourcePurge.LastAttemptAt, record.SourcePurge.KeptCount = now, len(purged.Changed)
			record.SourcePurge.Removed += len(purged.Removed)
			record.SourcePurge.Bytes += purged.Bytes
		}
		if record, err = s.store.SaveWorkspaceMigration(ctx, record); err != nil {
			writeResult(w, nil, err)
			return
		}
		log.Printf("workspace migration %s: old copy on %s deleted by %s (%d paths, %d bytes, %d changed kept)",
			record.ID, record.SourceDeviceID, actorFromContext(ctx).AccountID(), len(purged.Removed), purged.Bytes, len(purged.Changed))
		s.projectionsChanged("", fieldWorkspaces)
	}
	migration := record.WorkspaceMigration
	writeResult(w, store.WorkspaceMigrationPurgePreview{
		Removed: purged.Removed, Changed: purged.Changed, Bytes: purged.Bytes, Done: purged.Done, Migration: &migration,
	}, nil)
}
