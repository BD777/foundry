package httpapi

import (
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Project upkeep (DEV-256) is the review of a workspace's instruction files
// and the file changes it suggests. It belongs to the project, so it is read
// and decided on the project's page, not in any assistant's settings or
// conversation. The assistant that last ran the review is only its executor.

func (s *Server) handleWorkspaceUpkeep(w http.ResponseWriter, r *http.Request) {
	userID := accountID(r)
	workspaceID := r.PathValue("id")
	jobs, err := s.store.ListWorkspaceMaintenance(r.Context(), userID, workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	patches, err := s.store.ListPersonalAgentContextPatchesForWorkspace(r.Context(), userID, workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeJSON(w, http.StatusOK, store.WorkspaceUpkeep{Jobs: jobs, Patches: patches})
}

func (s *Server) handleWorkspaceUpkeepAction(w http.ResponseWriter, r *http.Request) {
	job, ok := s.workspaceUpkeepJob(w, r)
	if !ok {
		return
	}
	var input struct {
		Action   string `json:"action"`
		Revision int64  `json:"revision"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	saved, err := s.assistant.MaintenanceAction(r.Context(), job, input.Action, input.Revision)
	writeResult(w, saved, err)
}

// handleWorkspaceUpkeepPatch previews or accepts one suggested file change.
// Applying stays on the project's device: the accepted operation is handed
// to it by the upkeep drain, which verifies the file's hash again.
func (s *Server) handleWorkspaceUpkeepPatch(w http.ResponseWriter, r *http.Request) {
	job, ok := s.workspaceUpkeepJob(w, r)
	if !ok {
		return
	}
	var input assistant.ContextPatchRequest
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	answer, accepted, err := s.assistant.ContextPatch(r.Context(), job, input)
	if accepted {
		writeResultWithStatus(w, http.StatusAccepted, answer, err)
		return
	}
	writeResult(w, answer, err)
}

// workspaceUpkeepJob resolves the review the route names inside the
// project's own upkeep. Another owner's review is not this person's to
// decide, so it reads as absent.
func (s *Server) workspaceUpkeepJob(w http.ResponseWriter, r *http.Request) (store.PersonalAgentMaintenance, bool) {
	job, err := s.store.GetWorkspaceMaintenance(r.Context(), accountID(r), r.PathValue("id"), r.PathValue("job"))
	if err != nil {
		writeResult(w, nil, err)
		return store.PersonalAgentMaintenance{}, false
	}
	return job, true
}
