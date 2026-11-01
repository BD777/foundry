package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) handleListIssues(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListIssues(r.Context(), r.URL.Query().Get("workspaceId"))
	writeResult(w, items, err)
}

func (s *Server) handleGetIssue(w http.ResponseWriter, r *http.Request) {
	item, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	writeResult(w, item, err)
}

func (s *Server) handleCreateIssue(w http.ResponseWriter, r *http.Request) {
	var request struct {
		store.CreateIssueInput
		// InitializeGit: the person confirmed setting up Git in a workspace
		// that has none, or no commits yet (see ensureIssueGit).
		InitializeGit bool `json:"initializeGit,omitempty"`
	}
	if !decodeEvidenceRequest(w, r, "", &request) {
		return
	}
	input := request.CreateIssueInput
	if err := input.ValidateRuntimeOptions(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	actor := actorFromContext(r.Context())
	input.WorkspaceID = requestedWorkspace(actor, input.WorkspaceID)
	if !s.requireWorkspace(w, r, strings.TrimSpace(input.WorkspaceID), store.WorkspaceRoleMember) {
		return
	}
	if !s.ensureIssueGit(w, r, input.WorkspaceID, request.InitializeGit) {
		return
	}
	input.CreatedByUserID = actor.AccountID()
	item, err := s.store.CreateIssueIdempotent(r.Context(), input, r.Header.Get("Idempotency-Key"))
	if err != nil {
		writeEvidenceMutation(w, nil, err)
		return
	}
	s.projectionsChanged(item.WorkspaceID, fieldIssues)
	writeResultWithStatus(w, http.StatusCreated, item, err)
}

func (s *Server) handleRequestChanges(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Message       string `json:"message"`
		ExpectedRunID string `json:"expectedRunId"`
	}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, "Invalid feedback", http.StatusBadRequest)
			return
		}
	}
	issue, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, issue, err)
		return
	}
	unlock := s.lockIssueMutation(issue.ID)
	defer unlock()
	issue, err = s.store.GetIssue(r.Context(), issue.ID)
	if err != nil {
		writeResult(w, issue, err)
		return
	}
	if issue.Status == "in_progress" || issue.Status == "accepted" || issue.Status == "abandoned" {
		http.Error(w, "Issue cannot be retried in its current state", http.StatusConflict)
		return
	}
	if issue.Run != nil && issue.Run.EnvironmentID != "" {
		workspace, lookupErr := s.store.GetWorkspace(r.Context(), issue.WorkspaceID)
		if lookupErr == nil {
			lookupErr = s.hub.checkIssueRetry(r.Context(), workspace, issue)
		}
		if lookupErr != nil {
			http.Error(w, lookupErr.Error(), http.StatusConflict)
			return
		}
	}
	item, err := s.store.RequestIssueChanges(r.Context(), r.PathValue("id"), input.Message, input.ExpectedRunID, "")
	if err == nil {
		s.projectionsChanged(item.WorkspaceID, fieldIssues)
		go s.hub.DispatchReady()
	}
	writeResult(w, item, err)
}
