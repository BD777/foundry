package httpapi

import (
	"encoding/json"
	"net/http"
)

func (s *Server) handleAbandonIssue(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ExpectedRunID string `json:"expectedRunId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		http.Error(w, "Invalid abandonment request", http.StatusBadRequest)
		return
	}
	unlock := s.lockIssueMutation(r.PathValue("id"))
	defer unlock()
	issue, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, issue, err)
		return
	}
	if issue.Status == "in_progress" || issue.Status == "accepted" {
		http.Error(w, "Stop execution before abandoning an unfinished Issue", http.StatusConflict)
		return
	}
	if issue.Status != "abandoned" && issue.Run != nil && issue.Run.EnvironmentID != "" {
		workspace, lookupErr := s.store.GetWorkspace(r.Context(), issue.WorkspaceID)
		if lookupErr == nil {
			lookupErr = s.hub.checkIssueRetry(r.Context(), workspace, issue)
		}
		// Stops previews and prevents abandonment of a partially applied integration.
		if lookupErr != nil {
			http.Error(w, lookupErr.Error(), http.StatusConflict)
			return
		}
	}
	issue, err = s.store.AbandonIssue(r.Context(), issue.ID, input.ExpectedRunID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	s.events.Publish("issue_updated", issue)
	writeResult(w, issue, nil)
}
