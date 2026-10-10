package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// workspaceNeedsGitCode marks the 409 a client answers by asking the person
// to confirm setting up Git, then repeating the request with initializeGit.
const workspaceNeedsGitCode = "workspace_needs_git"

const workspaceNeedsGitMessage = "this workspace needs Git first; confirm to initialize"

// ensureIssueGit keeps a workspace's folder as it is until the person agrees
// to set up Git for its first Issue. A worker that sets Git up itself (an
// older one) or an offline device is not asked: the worker checks again when
// it prepares the Issue. It reports whether creating the Issue may go on.
func (s *Server) ensureIssueGit(w http.ResponseWriter, r *http.Request, workspaceID string, initialize bool) bool {
	workspace, err := s.store.GetWorkspace(r.Context(), workspaceID)
	if err != nil {
		return true
	}
	connection := s.hub.connectionFor(workspace.DeviceID)
	if connection == nil || !connection.hasCapability(store.DaemonCapabilityWorkspaceGitSetup) {
		return true
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	state, err := workspaceGitAction(ctx, connection, workspace.ID, "git_status")
	cancel()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "Could not check the workspace's Git repository: "+err.Error())
		return false
	}
	if state == "ready" {
		return true
	}
	if !initialize {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": workspaceNeedsGitMessage,
			"code":  workspaceNeedsGitCode,
			"path":  workspace.LocalPath,
		})
		return false
	}
	ctx, cancel = context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	state, err = workspaceGitAction(ctx, connection, workspace.ID, "initialize_git")
	if err == nil && state != "ready" {
		err = errors.New("the workspace still has no commits")
	}
	if err != nil {
		writeError(w, http.StatusConflict, "Setting up Git failed: "+err.Error())
		return false
	}
	return true
}

func workspaceGitAction(ctx context.Context, connection *daemonConnection, workspaceID, action string) (string, error) {
	payload, _ := json.Marshal(map[string]any{"action": action, "workspaceId": workspaceID, "issueId": "", "revision": 0})
	result, err := daemonRequest[wsIssueEnvironmentResult](ctx, connection, wsIssueEnvironmentType, payload)
	if err == nil && result.Error != "" {
		err = errors.New(result.Error)
	}
	return result.Status, err
}
