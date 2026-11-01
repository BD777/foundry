package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path"
	"reflect"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) handleKnowledgeMigrations(w http.ResponseWriter, r *http.Request) {
	moves, err := s.store.ListKnowledgeMigrations(r.Context(), s.personFrom(r).ID)
	writeResult(w, moves, err)
}
func (s *Server) handleBeginKnowledgeMigration(w http.ResponseWriter, r *http.Request) {
	var input struct {
		RequestID   string `json:"requestId"`
		Revision    int64  `json:"revision"`
		DeviceID    string `json:"deviceId"`
		WorkspaceID string `json:"workspaceId"`
		RootPath    string `json:"rootPath"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	ctx := r.Context()
	v, err := s.knowledgeVaultForRequest(r)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if input.RequestID == "" || len(input.RequestID) > 200 || input.RootPath == "" || len(input.RootPath) > 500 || path.IsAbs(input.RootPath) || strings.ContainsAny(input.RootPath, "\\\x00") {
		writeResult(w, nil, invalid("choose an empty relative destination folder"))
		return
	}
	for _, part := range strings.Split(input.RootPath, "/") {
		if part == ".." || part == ".git" {
			writeResult(w, nil, invalid("destination must stay inside its workspace"))
			return
		}
	}
	target := store.KnowledgeVault{UserID: v.UserID, ID: v.ID, Kind: v.Kind, WorkspaceID: input.WorkspaceID, DeviceID: input.DeviceID, RootPath: path.Clean(input.RootPath)}
	if _, err = s.knowledgeWorkspace(ctx, v.UserID, v); err != nil {
		writeResult(w, nil, err)
		return
	}
	if _, err = s.knowledgeWorkspace(ctx, v.UserID, target); err != nil {
		writeResult(w, nil, err)
		return
	}
	move, err := s.store.BeginKnowledgeMigration(ctx, store.KnowledgeMigration{ID: flow.Key("kmove", v.UserID, input.RequestID), UserID: v.UserID, VaultID: v.ID, Target: target}, input.Revision)
	writeResultWithStatus(w, http.StatusAccepted, move, err)
}
func (s *Server) handleCancelKnowledgeMigration(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Revision int64 `json:"revision"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	move, err := s.store.RequestKnowledgeMigrationCancel(r.Context(), s.personFrom(r).ID, r.PathValue("migration"), input.Revision)
	writeResult(w, move, err)
}
func (s *Server) drainKnowledgeMigrations(ctx context.Context) {
	moves, err := s.store.DueKnowledgeMigrations(ctx, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return
	}
	for _, move := range moves {
		if ctx.Err() != nil {
			return
		}
		runCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		s.advanceKnowledgeMigration(runCtx, move)
		cancel()
	}
}
func (s *Server) migrationCommand(ctx context.Context, location store.KnowledgeVault, command store.KnowledgeCommand) (store.KnowledgeReply, error) {
	workspace, err := s.knowledgeWorkspace(ctx, location.UserID, location)
	if err != nil {
		return store.KnowledgeReply{}, err
	}
	command.WorkspaceID, command.RootPath, command.VaultID, command.Epoch = location.WorkspaceID, location.RootPath, location.ID, location.Epoch
	return s.hub.knowledgeCommand(ctx, workspace, command)
}
func migrationMetadata(doc store.KnowledgeDocument) store.KnowledgeDocument {
	doc.Body = ""
	doc.OperationID = ""
	doc.UpdatedAt = ""
	return doc
}
func (s *Server) validateMigrationManifest(ctx context.Context, move store.KnowledgeMigration, docs []store.KnowledgeDocument) error {
	all, err := s.store.ListKnowledgeEntries(ctx, move.UserID, move.VaultID)
	if err != nil {
		return err
	}
	byID := map[string]store.KnowledgeEntry{}
	for _, entry := range all {
		byID[entry.ID] = entry
	}
	for _, doc := range docs {
		entry, ok := byID[doc.ID]
		if !ok {
			return fmt.Errorf("unindexed_source: review source files before migration")
		}
		if (entry.State == "forgetting" || entry.State == "forgotten") && doc.Deleted {
			delete(byID, doc.ID)
			continue
		}
		if entry.Revision != doc.Revision || entry.Hash != doc.Hash || entry.SourceRef != doc.SourceRef || entry.SourceVersion != doc.SourceVersion || entry.ExpiresAt != doc.ExpiresAt || entry.State == "forgotten" {
			return fmt.Errorf("source_index_conflict: a source revision changed")
		}
		delete(byID, doc.ID)
	}
	for _, entry := range byID {
		if entry.State != "forgetting" && entry.State != "forgotten" {
			return fmt.Errorf("source_missing: indexed source is missing")
		}
	}
	return nil
}
func (s *Server) advanceKnowledgeMigration(ctx context.Context, move store.KnowledgeMigration) {
	move.LeaseUntil = time.Now().Add(2 * time.Minute).UTC().Format(time.RFC3339Nano)
	var err error
	move, err = s.store.SaveKnowledgeMigration(ctx, move)
	if err != nil {
		return
	}
	save := func() { move.Reason = ""; move.LeaseUntil = ""; _, _ = s.store.SaveKnowledgeMigration(ctx, move) }
	wait := func(err error) {
		move.Reason = migrationReason(err)
		move.LeaseUntil = time.Now().Add(15 * time.Second).UTC().Format(time.RFC3339Nano)
		_, _ = s.store.SaveKnowledgeMigration(ctx, move)
	}
	key := func(step string) string { return flow.Key("kmoveop", move.ID, step) }
	if move.CancelRequested {
		if move.State == "pending" {
			_, _ = s.store.AbortKnowledgeMigration(ctx, move)
			return
		}
		// Fence the staging root before restoring the old authority. A delayed
		// import cannot write to the retired destination after cancellation.
		target, err := s.migrationCommand(ctx, move.Target, store.KnowledgeCommand{Action: "initialize", Staged: true, OperationID: key("initialize")})
		if err != nil {
			wait(err)
			return
		}
		if target.State != "retired" {
			if target.State != "staged" {
				wait(fmt.Errorf("cancel_target_not_staged"))
				return
			}
			target, err = s.migrationCommand(ctx, move.Target, store.KnowledgeCommand{Action: "retire", OperationID: key("abort-target"), ExpectedControlRevision: &target.ControlRevision})
			if err != nil {
				wait(err)
				return
			}
		}
		source, err := s.migrationCommand(ctx, move.Source, store.KnowledgeCommand{Action: "status", OperationID: key("source-status")})
		if err != nil {
			wait(err)
			return
		}
		if source.State != "active" && source.State != "frozen" {
			wait(fmt.Errorf("cancel_source_not_recoverable"))
			return
		}
		// Even an active source advances its control revision, fencing a late freeze.
		source, err = s.migrationCommand(ctx, move.Source, store.KnowledgeCommand{Action: "activate", OperationID: key("abort-source"), ExpectedControlRevision: &source.ControlRevision})
		if err != nil {
			wait(err)
			return
		}
		if source.State != "active" {
			wait(fmt.Errorf("cancel_source_receipt_missing"))
			return
		}
		_, err = s.store.AbortKnowledgeMigration(ctx, move)
		if err != nil {
			wait(err)
		}
		return
	}
	switch move.State {
	case "pending":
		source, err := s.migrationCommand(ctx, move.Source, store.KnowledgeCommand{Action: "status", OperationID: key("source-status")})
		if err != nil {
			wait(err)
			return
		}
		if source.State != "active" {
			wait(fmt.Errorf("source_not_active"))
			return
		}
		move.SourceControlRevision = source.ControlRevision
		move.State = "freezing"
		save()
	case "freezing":
		source, err := s.migrationCommand(ctx, move.Source, store.KnowledgeCommand{Action: "freeze", OperationID: key("freeze"), ExpectedControlRevision: &move.SourceControlRevision})
		if err != nil {
			wait(err)
			return
		}
		if source.State != "frozen" || source.ControlOperationID != key("freeze") {
			wait(fmt.Errorf("freeze_receipt_mismatch"))
			return
		}
		target, err := s.migrationCommand(ctx, move.Target, store.KnowledgeCommand{Action: "initialize", Staged: true, OperationID: key("initialize")})
		if err != nil {
			wait(err)
			return
		}
		if target.State != "staged" || target.ControlOperationID != key("initialize") {
			wait(fmt.Errorf("target_not_empty_or_owned"))
			return
		}
		source, err = s.migrationCommand(ctx, move.Source, store.KnowledgeCommand{Action: "list", OperationID: key("manifest")})
		if err != nil {
			wait(err)
			return
		}
		if err = s.validateMigrationManifest(ctx, move, source.Documents); err != nil {
			wait(err)
			return
		}
		move.Manifest = source.Documents
		for i := range move.Manifest {
			move.Manifest[i].Body = ""
		}
		move.Cursor = 0
		move.SourceControlRevision = source.ControlRevision
		move.TargetControlRevision = target.ControlRevision
		move.State = "copying"
		save()
	case "copying":
		end := min(move.Cursor+3, len(move.Manifest))
		for move.Cursor < end {
			meta := move.Manifest[move.Cursor]
			source, err := s.migrationCommand(ctx, move.Source, store.KnowledgeCommand{Action: "read", DocumentID: meta.ID, OperationID: key("read-" + meta.ID)})
			if err != nil {
				wait(err)
				return
			}
			if source.Document == nil {
				wait(fmt.Errorf("source_missing"))
				return
			}
			doc := *source.Document
			if !reflect.DeepEqual(migrationMetadata(doc), migrationMetadata(meta)) && !doc.Deleted {
				wait(fmt.Errorf("source_changed_after_freeze"))
				return
			}
			target, err := s.migrationCommand(ctx, move.Target, store.KnowledgeCommand{Action: "import", DocumentID: doc.ID, OperationID: key("copy-" + doc.ID), ImportDocument: &doc})
			if err != nil {
				wait(err)
				return
			}
			if target.Document == nil || !reflect.DeepEqual(migrationMetadata(doc), migrationMetadata(*target.Document)) {
				wait(fmt.Errorf("copy_verification_failed"))
				return
			}
			doc.Body = ""
			move.Manifest[move.Cursor] = doc
			move.Cursor++
		}
		if move.Cursor == len(move.Manifest) {
			move.State = "verifying"
		}
		save()
	case "verifying":
		source, err := s.migrationCommand(ctx, move.Source, store.KnowledgeCommand{Action: "list", OperationID: key("source-verify")})
		if err != nil {
			wait(err)
			return
		}
		target, err := s.migrationCommand(ctx, move.Target, store.KnowledgeCommand{Action: "list", OperationID: key("target-verify")})
		if err != nil {
			wait(err)
			return
		}
		if err = s.validateMigrationManifest(ctx, move, source.Documents); err != nil {
			wait(err)
			return
		}
		same := len(source.Documents) == len(target.Documents) && len(move.Manifest) == len(source.Documents)
		if same {
			for i, doc := range source.Documents {
				if !reflect.DeepEqual(migrationMetadata(doc), migrationMetadata(target.Documents[i])) || !reflect.DeepEqual(migrationMetadata(doc), migrationMetadata(move.Manifest[i])) {
					same = false
					break
				}
			}
		}
		if !same {
			move.Manifest = source.Documents
			for i := range move.Manifest {
				move.Manifest[i].Body = ""
			}
			move.Cursor = 0
			move.State = "copying"
			save()
			return
		}
		_, err = s.store.SwitchKnowledgeAuthority(ctx, move)
		if err != nil {
			wait(err)
		}
	case "activating":
		target, err := s.migrationCommand(ctx, move.Target, store.KnowledgeCommand{Action: "activate", OperationID: key("activate"), ExpectedControlRevision: &move.TargetControlRevision})
		if err != nil {
			wait(err)
			return
		}
		if target.State != "active" || target.ControlOperationID != key("activate") {
			wait(fmt.Errorf("activation_receipt_mismatch"))
			return
		}
		_, err = s.store.ActivateKnowledgeAuthority(ctx, move)
		if err != nil {
			wait(err)
		}
	case "retiring":
		source, err := s.migrationCommand(ctx, move.Source, store.KnowledgeCommand{Action: "retire", OperationID: key("retire"), ExpectedControlRevision: &move.SourceControlRevision})
		if err != nil {
			wait(err)
			return
		}
		if source.State != "retired" {
			wait(fmt.Errorf("retirement_receipt_missing"))
			return
		}
		move.State = "complete"
		save()
	}
}
func migrationReason(err error) string {
	for _, code := range []string{"memory_device_offline", "memory_worker_update_required", "memory_workspace_must_be_private", "knowledge_owner_required", "not_empty", "fenced", "control_revision_conflict", "target_not_empty_or_owned", "source_index_conflict", "unindexed_source", "source_missing", "source_changed_after_freeze", "copy_verification_failed"} {
		if strings.Contains(err.Error(), code) {
			return code
		}
	}
	if errors.Is(err, store.ErrPersonalAgentRevision) {
		return "migration_changed"
	}
	return "migration_waiting_for_recovery"
}
