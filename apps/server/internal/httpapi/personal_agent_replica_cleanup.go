package httpapi

import (
	"context"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
	"strings"
	"time"
)

// Erasure needs source ownership, even if the old workspace is now shared or
// archived. It does not disclose that source to any model or grant new reads.
func (s *Server) knowledgeEraseWorkspace(ctx context.Context, user string, location store.KnowledgeVault) (store.WorkspaceProjection, error) {
	workspace, err := s.store.GetWorkspace(ctx, location.WorkspaceID)
	if err != nil {
		return workspace, err
	}
	roles, err := s.store.WorkspaceRolesForUser(ctx, user)
	if err != nil {
		return workspace, err
	}
	if roles[workspace.ID] != store.WorkspaceRoleOwner || workspace.DeviceID != location.DeviceID {
		return workspace, fmt.Errorf("knowledge_owner_required")
	}
	return workspace, nil
}
func (s *Server) drainKnowledgeReplicaForgets(ctx context.Context) {
	if err := s.store.EnsureKnowledgeReplicaForgets(ctx); err != nil {
		return
	}
	jobs, err := s.store.DueKnowledgeReplicaForgets(ctx, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return
	}
	for _, job := range jobs {
		if ctx.Err() != nil {
			return
		}
		job.State, job.LeaseUntil = "writing", time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
		job, err = s.store.SaveKnowledgeReplicaForget(ctx, job)
		if err != nil {
			continue
		}
		runCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		err = s.eraseKnowledgeReplica(runCtx, job)
		cancel()
		job.State, job.Reason, job.LeaseUntil = "complete", "", ""
		if err != nil {
			job.State, job.Reason, job.LeaseUntil = "waiting", migrationReason(err), time.Now().Add(30*time.Second).UTC().Format(time.RFC3339Nano)
		}
		_, _ = s.store.SaveKnowledgeReplicaForget(ctx, job)
	}
}
func (s *Server) eraseKnowledgeReplica(ctx context.Context, job store.KnowledgeReplicaForget) error {
	copies, err := s.store.ListKnowledgeReplicas(ctx, job.UserID, job.VaultID)
	if err != nil {
		return err
	}
	var copy *store.KnowledgeReplica
	for _, v := range copies {
		if v.ID == job.ReplicaID {
			copy = &v
			break
		}
	}
	if copy == nil {
		return store.ErrNotFound
	}
	workspace, err := s.knowledgeEraseWorkspace(ctx, job.UserID, copy.Location)
	if err != nil {
		return err
	}
	command := store.KnowledgeCommand{WorkspaceID: workspace.ID, RootPath: copy.Location.RootPath, VaultID: copy.VaultID, Epoch: copy.Location.Epoch, Action: "read", DocumentID: job.EntryID, OperationID: flow.Key("krepforget", job.ID)}
	before, err := s.hub.knowledgeCommand(ctx, workspace, command)
	if err != nil && !strings.Contains(err.Error(), "not_found:") {
		return err
	}
	revision, hash := int64(0), ""
	if before.Document != nil {
		revision, hash = before.Document.Revision, before.Document.Hash
	}
	command.Action, command.ExpectedRevision, command.ExpectedHash = "forget", &revision, hash
	after, err := s.hub.knowledgeCommand(ctx, workspace, command)
	if err != nil {
		return err
	}
	if after.Document == nil || !after.Document.Deleted || after.Document.Body != "" {
		return fmt.Errorf("forget_receipt_mismatch")
	}
	return nil
}
func (s *Server) handleKnowledgeReplicaCleanup(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListKnowledgeReplicaForgets(r.Context(), s.personFrom(r).ID)
	writeResult(w, items, err)
}
