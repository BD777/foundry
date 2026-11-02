package httpapi

import (
	"context"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/issues"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The Issue service's port (issues.Devices) over the server's device hub.

// newIssueService is the server's Issue lifecycle, telling events.
func newIssueService(s *Server, events issues.Notifier) *issues.Service {
	return issues.New(s.store, events, issueDevices{s})
}

// issueRetryCheckTimeout bounds the device's retry check, which an Issue's
// lock is held over.
const issueRetryCheckTimeout = 30 * time.Second

type issueDevices struct{ s *Server }

func (d issueDevices) Connected(deviceID string) bool { return d.s.hub.HasConnection(deviceID) }

func (d issueDevices) Git(ctx context.Context, workspaceID string, initialize bool) (bool, error) {
	return d.s.ensureIssueGit(ctx, workspaceID, initialize)
}

func (d issueDevices) CheckRetry(ctx context.Context, issue store.Issue) error {
	workspace, err := d.s.store.GetWorkspace(ctx, issue.WorkspaceID)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, issueRetryCheckTimeout)
	defer cancel()
	return d.s.hub.checkIssueRetry(ctx, workspace, issue)
}

func (d issueDevices) Dispatch(session store.AgentSession) error {
	return d.s.hub.DispatchAgentSession(session)
}

func (d issueDevices) ClaimReady() { d.s.hub.DispatchReady() }
