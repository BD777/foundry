package httpapi

import (
	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An Issue's messages.
var (
	issueCreatedEvent            = browserevent.Define[store.Issue](browserevent.IssueCreated, eventstream.Options{})
	issueUpdatedEvent            = browserevent.Define[store.Issue](browserevent.IssueUpdated, eventstream.Options{})
	issueRunEvent                = browserevent.Define[store.RunEvent](browserevent.IssueRunEvent, eventstream.Options{})
	evidenceUpdatedEvent         = browserevent.Define[browserevent.EvidenceUpdatedPayload](browserevent.EvidenceUpdated, eventstream.Options{})
	issueEnvironmentChangedEvent = browserevent.Define[browserevent.IssueEnvironmentChangedPayload](browserevent.IssueEnvironmentChanged, eventstream.Options{KeepsSnapshot: true})
)

// issueEvents tells an Issue's viewers (those who may view its workspace)
// what happened to it: the Issue as it is now, its run's events, its
// evidence records, and that its environment reads differently.
type issueEvents struct {
	stream eventstream.Publisher
	// observers react, in the order they were added, to every update; they
	// are added before anything is published.
	observers []issueObserver
}

// issueObserver reacts on the server to what happens to Issues.
type issueObserver interface {
	// issueUpdated follows a change of the Issue, after its viewers were told.
	issueUpdated(issue store.Issue)
}

// observe adds observers, which react after those added before.
func (e *issueEvents) observe(observers ...issueObserver) {
	e.observers = append(e.observers, observers...)
}

// created tells the workspace's viewers about a new Issue.
func (e *issueEvents) created(issue store.Issue) {
	issueCreatedEvent.Publish(e.stream, eventstream.Route{Workspace: issue.WorkspaceID}, issue)
}

// updated tells the Issue's viewers what it is now, then its observers.
func (e *issueEvents) updated(issue store.Issue) {
	issueUpdatedEvent.Publish(e.stream, eventstream.Route{Workspace: issue.WorkspaceID}, issue)
	for _, observer := range e.observers {
		observer.issueUpdated(issue)
	}
}

// runEventRecorded streams an event its run recorded.
func (e *issueEvents) runEventRecorded(workspaceID string, event store.RunEvent) {
	issueRunEvent.Publish(e.stream, eventstream.Route{Workspace: workspaceID}, event)
}

// evidenceChanged tells the Issue's viewers that one of its evidence
// records changed: entityID at version now has status.
func (e *issueEvents) evidenceChanged(issue store.Issue, entityID string, version int, status string) {
	evidenceUpdatedEvent.Publish(e.stream, eventstream.Route{Workspace: issue.WorkspaceID}, browserevent.EvidenceUpdatedPayload{
		IssueID: issue.ID, WorkspaceID: issue.WorkspaceID,
		EntityID: entityID, Version: version, Status: status,
	})
}

// environmentChanged tells an Issue's viewers that its environment status
// reads differently on the device; without issueID, every Issue of the
// workspace may (its repositories changed).
func (e *issueEvents) environmentChanged(workspaceID, issueID string) {
	issueEnvironmentChangedEvent.Publish(e.stream, eventstream.Route{Workspace: workspaceID}, browserevent.IssueEnvironmentChangedPayload{WorkspaceID: workspaceID, IssueID: issueID})
}
