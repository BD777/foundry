package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
	"time"
)

type wsContextPatchReply struct{ store.ContextPatchReply }

func (p wsContextPatchReply) refusal() error {
	if p.Error != "" {
		return fmt.Errorf("%s: %s", p.Code, p.Error)
	}
	return nil
}
func (h *DaemonHub) contextPatch(ctx context.Context, w store.WorkspaceProjection, cmd store.ContextPatchCommand) (store.ContextPatchReply, error) {
	c := h.connectionFor(w.DeviceID)
	if c == nil {
		return store.ContextPatchReply{}, fmt.Errorf("device_offline")
	}
	if !c.hasCapability("context_patch_v1") {
		return store.ContextPatchReply{}, fmt.Errorf("worker_update_required")
	}
	reply, err := callDevice[wsContextPatchReply](ctx, c, wsContextPatchType, cmd)
	return reply.ContextPatchReply, err
}
func (s *Server) handleContextPatches(w http.ResponseWriter, r *http.Request) {
	b, ok := s.store.(store.PersonalAgentContextPatchStore)
	if !ok {
		writeResult(w, nil, invalid("context patches unavailable"))
		return
	}
	v, err := b.ListPersonalAgentContextPatches(r.Context(), s.personFrom(r).ID)
	writeResult(w, v, err)
}
func (s *Server) handleContextPatch(w http.ResponseWriter, r *http.Request) {
	b, ok := s.store.(store.PersonalAgentContextPatchStore)
	if !ok {
		writeResult(w, nil, invalid("context patches unavailable"))
		return
	}
	jobs, err := s.maintenanceStore()
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	job, err := jobs.GetPersonalAgentMaintenance(r.Context(), s.personFrom(r).ID, r.PathValue("job"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	var input struct {
		Index        int    `json:"index"`
		Revision     int64  `json:"revision"`
		Action       string `json:"action"`
		ReviewedHash string `json:"reviewedHash"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if job.Revision != input.Revision || job.Status != "review" || job.Result == nil || job.Role != "governance" || input.Index < 0 || input.Index >= len(job.Result.Patches) {
		writeResult(w, nil, store.ErrPersonalAgentRevision)
		return
	}
	workspace, err := s.store.GetWorkspace(r.Context(), job.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	roles, err := s.store.WorkspaceRolesForUser(r.Context(), job.UserID)
	if err != nil || roles[workspace.ID] != store.WorkspaceRoleOwner {
		writeResult(w, nil, store.ErrNotFound)
		return
	}
	if workspace.ArchivedAt != "" || workspace.UnavailableOnDevice != nil {
		writeResult(w, nil, invalid("workspace_unavailable"))
		return
	}
	patch := job.Result.Patches[input.Index]
	digest := sha256.Sum256([]byte(patch.Content))
	id := flow.Key("pactx", job.ID, patch.Path, patch.BaseHash, hex.EncodeToString(digest[:]))
	if input.Action == "preview" {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		reply, err := s.hub.contextPatch(ctx, workspace, store.ContextPatchCommand{WorkspaceID: workspace.ID, OperationID: id, Action: "read", Path: patch.Path})
		writeResult(w, reply, err)
		return
	}
	if input.Action != "apply" || input.ReviewedHash != patch.BaseHash {
		writeResult(w, nil, invalid("review the current source before applying the patch"))
		return
	}
	// Reject before acquiring the durable fence if this worker cannot acknowledge
	// the operation at all. An offline disconnect after acceptance keeps the fence.
	c := s.hub.connectionFor(workspace.DeviceID)
	if c == nil || !c.hasCapability("context_patch_v1") {
		writeResult(w, nil, invalid("device_offline_or_worker_update_required"))
		return
	}
	value, err := b.BeginPersonalAgentContextPatch(r.Context(), store.PersonalAgentContextPatch{ID: id, UserID: job.UserID, JobID: job.ID, WorkspaceID: workspace.ID, DeviceID: workspace.DeviceID, Index: input.Index, Path: patch.Path, BaseHash: patch.BaseHash, Hash: hex.EncodeToString(digest[:])}, job.Revision)
	writeResultWithStatus(w, http.StatusAccepted, value, err)
}
func (s *Server) drainContextPatches(ctx context.Context) {
	b, ok := s.store.(store.PersonalAgentContextPatchStore)
	if !ok {
		return
	}
	jobs, err := s.maintenanceStore()
	if err != nil {
		return
	}
	ops, err := b.PendingPersonalAgentContextPatches(ctx)
	if err != nil {
		return
	}
	for _, op := range ops {
		if user, e := s.store.GetUser(ctx, op.UserID); e != nil || !user.Active() {
			op.Reason = "permission_changed"
			_, _ = b.SavePersonalAgentContextPatch(ctx, op)
			continue
		}
		job, err := jobs.GetPersonalAgentMaintenance(ctx, op.UserID, op.JobID)
		if err != nil || job.Result == nil || op.Index >= len(job.Result.Patches) {
			continue
		}
		workspace, err := s.store.GetWorkspace(ctx, op.WorkspaceID)
		if err != nil || workspace.DeviceID != op.DeviceID {
			op.Reason = "source_location_changed"
			_, _ = b.SavePersonalAgentContextPatch(ctx, op)
			continue
		}
		roles, err := s.store.WorkspaceRolesForUser(ctx, op.UserID)
		if err != nil || roles[workspace.ID] != store.WorkspaceRoleOwner {
			op.Reason = "permission_changed"
			_, _ = b.SavePersonalAgentContextPatch(ctx, op)
			continue
		}
		patch := job.Result.Patches[op.Index]
		run, cancel := context.WithTimeout(ctx, 10*time.Second)
		reply, err := s.hub.contextPatch(run, workspace, store.ContextPatchCommand{WorkspaceID: workspace.ID, OperationID: op.ID, Action: "apply", Path: op.Path, BaseHash: op.BaseHash, Content: patch.Content})
		cancel()
		if err != nil {
			op.Reason = "waiting_for_device_receipt"
		} else if reply.OperationID != op.ID || reply.Path != op.Path {
			op.Reason = "receipt_mismatch"
		} else if reply.State == "applied" && reply.Hash == op.Hash {
			op.Status = "applied"
			op.Reason = ""
		} else if reply.State == "conflict" {
			op.Status = "conflict"
			op.Reason = "source_changed_review_again"
		} else {
			op.Reason = "receipt_mismatch"
		}
		if _, e := b.SavePersonalAgentContextPatch(ctx, op); e == nil && op.Status == "applied" {
			s.refreshWorkspaceDigests(ctx, workspace.ID)
		}
	}
}
