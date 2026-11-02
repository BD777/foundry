package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/issues"
)

// workspaceNeedsGitCode marks the 409 a client answers by asking the person
// to confirm setting up Git, then repeating the request with initializeGit.
const workspaceNeedsGitCode = "workspace_needs_git"

// ensureIssueGit keeps a workspace's folder as it is until the person agrees
// (initialize) to set up Git for its first Issue, and reports whether it set
// it up. An offline device is not asked: the worker checks again when it
// prepares the Issue. A refusal is an issues.NeedsGit or a statusError.
func (s *Server) ensureIssueGit(ctx context.Context, workspaceID string, initialize bool) (bool, error) {
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return false, nil
	}
	connection := s.hub.connectionFor(workspace.DeviceID)
	if connection == nil {
		return false, nil
	}
	checkCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	state, err := workspaceGitAction(checkCtx, connection, workspace.ID, "git_status")
	cancel()
	if err != nil {
		return false, &statusError{http.StatusServiceUnavailable, fmt.Errorf("Could not check the workspace's Git repository: %w", err)}
	}
	if state == "ready" {
		return false, nil
	}
	if !initialize {
		return false, &issues.NeedsGit{Path: workspace.LocalPath}
	}
	initCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	state, err = workspaceGitAction(initCtx, connection, workspace.ID, "initialize_git")
	if err == nil && state != "ready" {
		err = errors.New("the workspace still has no commits")
	}
	if err != nil {
		return false, &statusError{http.StatusConflict, fmt.Errorf("Setting up Git failed: %w", err)}
	}
	return true, nil
}

func workspaceGitAction(ctx context.Context, connection *daemonConnection, workspaceID, action string) (string, error) {
	payload, _ := json.Marshal(map[string]any{"action": action, "workspaceId": workspaceID, "issueId": "", "revision": 0})
	result, err := daemonRequest[wsIssueEnvironmentResult](ctx, connection, wsIssueEnvironmentType, payload)
	if err == nil && result.Error != "" {
		err = errors.New(result.Error)
	}
	return result.Status, err
}
