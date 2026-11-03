package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

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
	if r.Method == http.MethodPost {
		action = r.PathValue("action")
	}
	// An execution is a session: it is steered and stopped as one
	// (POST /api/agent-sessions/{id}/messages and /cancel).
	switch action {
	case "status", "preview_stop":
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
	// A status read also asks the device to tell this server when it changes.
	payload, _ := json.Marshal(map[string]any{"action": action, "workspaceId": workspace.ID, "issueId": issue.ID, "revision": revision})
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

type wsIssueEnvironmentChangedPayload struct {
	WorkspaceID string `json:"workspaceId,omitempty"`
	IssueID     string `json:"issueId,omitempty"`
}

// issueEnvironmentChanged is a device telling that an Issue's environment
// (or, without an Issue, every environment of a workspace) changed. Only a
// workspace the device serves is told.
func (c *daemonConnection) issueEnvironmentChanged(ctx context.Context, envelope wsEnvelope) error {
	var payload wsIssueEnvironmentChangedPayload
	if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
		return err
	}
	workspaceID := payload.WorkspaceID
	if payload.IssueID != "" {
		issue, err := c.hub.store.GetIssue(ctx, payload.IssueID)
		if err != nil || (workspaceID != "" && workspaceID != issue.WorkspaceID) {
			return nil
		}
		workspaceID = issue.WorkspaceID
	}
	if workspaceID == "" {
		return nil
	}
	workspace, err := c.hub.store.GetWorkspace(ctx, workspaceID)
	deviceID, _ := c.registrationSnapshot()
	if err != nil || deviceID == "" || workspace.DeviceID != deviceID {
		return nil
	}
	c.hub.issues.EnvironmentChanged(workspaceID, payload.IssueID)
	return nil
}
