package httpapi

import (
	"context"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// daemonNotifiers is what the device hub tells browsers of what devices
// report, by domain: each is the part of the domain's notifier
// (events_*.go, data_changes.go) the hub uses.
type daemonNotifiers struct {
	sessions    deviceSessionNotifier
	issues      deviceIssueNotifier
	devices     deviceReportNotifier
	chats       chatSyncNotifier
	dataChanges dataChangeNotifier
}

type (
	deviceSessionNotifier interface {
		sessionNotifier
		subagentChanged(workspaceID string, event store.AgentSessionEvent, change subagentChange)
		backgroundTaskOutputChanged(session store.AgentSession, taskID string)
		endReported(ctx context.Context, session store.AgentSession)
	}
	deviceIssueNotifier interface {
		updated(issue store.Issue)
		runEventRecorded(workspaceID string, event store.RunEvent)
		environmentChanged(workspaceID, issueID string)
	}
	deviceReportNotifier interface {
		registrationChanged(registration store.DaemonRegistration)
		reported(ctx context.Context, deviceID string, changes store.DaemonChanges)
	}
	chatSyncNotifier interface {
		chatsSynced(ctx context.Context, input store.SyncChatsInput, changes store.DaemonChanges)
	}
)
