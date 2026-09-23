package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) lockIssueMutation(id string) func() {
	value, _ := s.issueMutationLocks.LoadOrStore(id, &sync.Mutex{})
	mutex := value.(*sync.Mutex)
	mutex.Lock()
	return mutex.Unlock
}

func (s *Server) handleRecoverIssueClaim(w http.ResponseWriter, r *http.Request) {
	if !s.requireDeviceIssue(w, r, r.PathValue("id")) {
		return
	}
	issue, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, issue, err)
		return
	}
	if issue.Status != "in_progress" || (issue.Run != nil && issue.Run.Status == "running") {
		http.Error(w, "Only an unstarted claim can be recovered", http.StatusConflict)
		return
	}
	issue, err = s.store.UpdateIssueStatus(r.Context(), issue.ID, "pending")
	writeResult(w, issue, err)
}

type wsIssueEnvironmentResult struct {
	Environment json.RawMessage `json:"environment,omitempty"`
	Review      json.RawMessage `json:"review,omitempty"`
	Status      string          `json:"status"`
	Error       string          `json:"error,omitempty"`
	Revision    int             `json:"revision"`
}

func (s *Server) handleIssueEnvironment(w http.ResponseWriter, r *http.Request) {
	issue, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	action := "status"
	var input struct {
		Message       string `json:"message"`
		ExpectedRunID string `json:"expectedRunId"`
	}
	if r.Method == http.MethodPost {
		action = r.PathValue("action")
	}
	switch action {
	case "steer":
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil || strings.TrimSpace(input.Message) == "" || len(input.Message) > 32000 {
			http.Error(w, "Steer input must contain 1–32000 bytes", http.StatusBadRequest)
			return
		}
		if issue.Status != "in_progress" || issue.Runtime != "claude" || issue.Run == nil || issue.Run.Status != "running" || input.ExpectedRunID != issue.Run.ID {
			http.Error(w, "This execution is not accepting steer input; refresh the Issue", http.StatusConflict)
			return
		}
	case "status", "preview_stop":
	case "cancel":
		if issue.Status != "in_progress" {
			http.Error(w, "Issue is not running", http.StatusConflict)
			return
		}
	case "cleanup":
		if issue.Status != "accepted" {
			http.Error(w, "Accept the candidate before cleanup", http.StatusConflict)
			return
		}
	case "preview_start":
		if issue.Status != "verifying" {
			http.Error(w, "Preview requires a review candidate", http.StatusConflict)
			return
		}
	default:
		http.Error(w, "Unknown environment action", http.StatusBadRequest)
		return
	}
	workspace, err := s.store.GetWorkspace(r.Context(), issue.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	connection := s.hub.connectionFor(workspace.DeviceID)
	if connection == nil {
		http.Error(w, "Workspace device is offline", http.StatusServiceUnavailable)
		return
	}
	revision := 0
	if issue.Run != nil {
		revision = issue.Run.EnvironmentRevision
	}
	payload, _ := json.Marshal(map[string]any{"action": action, "workspaceId": workspace.ID, "issueId": issue.ID, "revision": revision, "message": input.Message, "expectedRunId": input.ExpectedRunID})
	result, err := daemonRequest[wsIssueEnvironmentResult](r.Context(), connection, wsIssueEnvironmentType, payload)
	if err == nil && result.Error != "" {
		err = errors.New(result.Error)
	}
	writeResult(w, result, err)
}

func (s *Server) handleCandidateReview(w http.ResponseWriter, r *http.Request) {
	issue, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	workspace, err := s.store.GetWorkspace(r.Context(), issue.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	connection := s.hub.connectionFor(workspace.DeviceID)
	if connection == nil {
		http.Error(w, "Workspace device is offline", http.StatusServiceUnavailable)
		return
	}
	payload, _ := json.Marshal(map[string]any{"action": "inspect", "workspaceId": workspace.ID, "issueId": issue.ID})
	result, err := daemonRequest[wsIssueEnvironmentResult](r.Context(), connection, wsIssueEnvironmentType, payload)
	if err == nil && result.Error != "" {
		err = errors.New(result.Error)
	}
	writeResult(w, result, err)
}

func (h *DaemonHub) checkIssueRetry(ctx context.Context, workspace store.WorkspaceProjection, issue store.Issue) error {
	connection := h.connectionFor(workspace.DeviceID)
	if connection == nil {
		return errors.New("Workspace device must be online to retry this candidate")
	}
	payload, _ := json.Marshal(map[string]any{"action": "check_retry", "workspaceId": workspace.ID, "issueId": issue.ID})
	result, err := daemonRequest[wsIssueEnvironmentResult](ctx, connection, wsIssueEnvironmentType, payload)
	if err != nil {
		return err
	}
	if result.Error != "" {
		return errors.New(result.Error)
	}
	return nil
}
