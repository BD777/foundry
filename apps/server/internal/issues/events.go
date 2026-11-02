package issues

import (
	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An Issue's messages.
var (
	issueCreatedEvent            = browserevent.Define[store.Issue](browserevent.IssueCreated, eventstream.Options{})
	issueUpdatedEvent            = browserevent.Define[store.Issue](browserevent.IssueUpdated, eventstream.Options{})
	evidenceUpdatedEvent         = browserevent.Define[browserevent.EvidenceUpdatedPayload](browserevent.EvidenceUpdated, eventstream.Options{})
	issueEnvironmentChangedEvent = browserevent.Define[browserevent.IssueEnvironmentChangedPayload](browserevent.IssueEnvironmentChanged, eventstream.Options{KeepsSnapshot: true})
)

// Notifier tells who follows Issues what happened to one; Events is the
// server's.
type Notifier interface {
	// Created: a new Issue.
	Created(issue store.Issue)
	// Updated: the Issue as it is now.
	Updated(issue store.Issue)
	// EvidenceChanged: one of the Issue's evidence records, entityID at
	// version, now has status.
	EvidenceChanged(issue store.Issue, entityID string, version int, status string)
}

// Observer reacts on the server to what happens to Issues.
type Observer interface {
	// IssueUpdated follows a new or changed Issue, after its viewers were
	// told.
	IssueUpdated(issue store.Issue)
}

// Events tells an Issue's viewers (those who may view its workspace) what
// happened to it: the Issue as it is now, its evidence records, and that its
// environment reads differently; then, in their order, its observers.
type Events struct {
	stream eventstream.Publisher
	// observers are added before anything is published.
	observers []Observer
}

// NewEvents tells viewers on stream.
func NewEvents(stream eventstream.Publisher) *Events {
	return &Events{stream: stream}
}

// Observe adds observers, which react after those added before.
func (e *Events) Observe(observers ...Observer) {
	e.observers = append(e.observers, observers...)
}

// Observing is the observers, in their order.
func (e *Events) Observing() []Observer { return e.observers }

// Created tells the workspace's viewers about a new Issue, then its
// observers.
func (e *Events) Created(issue store.Issue) {
	issueCreatedEvent.Publish(e.stream, eventstream.Route{Workspace: issue.WorkspaceID}, issue)
	e.observed(issue)
}

// Updated tells the Issue's viewers what it is now, then its observers.
func (e *Events) Updated(issue store.Issue) {
	issueUpdatedEvent.Publish(e.stream, eventstream.Route{Workspace: issue.WorkspaceID}, issue)
	e.observed(issue)
}

func (e *Events) observed(issue store.Issue) {
	for _, observer := range e.observers {
		observer.IssueUpdated(issue)
	}
}

// EvidenceChanged tells the Issue's viewers that one of its evidence
// records changed: entityID at version now has status.
func (e *Events) EvidenceChanged(issue store.Issue, entityID string, version int, status string) {
	evidenceUpdatedEvent.Publish(e.stream, eventstream.Route{Workspace: issue.WorkspaceID}, browserevent.EvidenceUpdatedPayload{
		IssueID: issue.ID, WorkspaceID: issue.WorkspaceID,
		EntityID: entityID, Version: version, Status: status,
	})
}

// EnvironmentChanged tells an Issue's viewers that its environment status
// reads differently on the device; without issueID, every Issue of the
// workspace may (its repositories changed).
func (e *Events) EnvironmentChanged(workspaceID, issueID string) {
	issueEnvironmentChangedEvent.Publish(e.stream, eventstream.Route{Workspace: workspaceID}, browserevent.IssueEnvironmentChangedPayload{WorkspaceID: workspaceID, IssueID: issueID})
}
