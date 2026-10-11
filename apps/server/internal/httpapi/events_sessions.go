package httpapi

import (
	"context"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A session's messages. Its transcript events and subagent updates change
// nothing the foundry-data snapshot serves beyond activity times its short
// TTL covers: streaming answers would otherwise defeat the snapshot cache
// many times a second.
var (
	sessionCreatedEvent         = browserevent.Define[store.AgentSession](browserevent.AgentSessionCreated, eventstream.Options{})
	sessionStartedEvent         = browserevent.Define[store.AgentSession](browserevent.AgentSessionStarted, eventstream.Options{})
	sessionBlockedEvent         = browserevent.Define[store.AgentSession](browserevent.AgentSessionBlocked, eventstream.Options{})
	sessionResumedEvent         = browserevent.Define[store.AgentSession](browserevent.AgentSessionResumed, eventstream.Options{})
	sessionNativeSessionIDEvent = browserevent.Define[store.AgentSession](browserevent.AgentSessionNativeSessionID, eventstream.Options{})
	sessionCompletedEvent       = browserevent.Define[store.AgentSession](browserevent.AgentSessionCompleted, eventstream.Options{})
	sessionTranscriptEvent      = browserevent.Define[store.AgentSessionEvent](browserevent.AgentSessionEvent, eventstream.Options{KeepsSnapshot: true})
	subagentUpdatedEvent        = browserevent.Define[browserevent.AgentSubagentUpdatedPayload](browserevent.AgentSubagentUpdated, eventstream.Options{KeepsSnapshot: true})
	backgroundTaskOutputEvent   = browserevent.Define[browserevent.BackgroundTaskOutputChangedPayload](browserevent.BackgroundTaskOutputChanged, eventstream.Options{KeepsSnapshot: true})
)

// sessionChange is what happened to a session as a whole. Viewers get the
// session without its transcript, which travels one event at a time
// (agent_session_event).
type sessionChange int

const (
	// sessionCreated: a new session waits for its device.
	sessionCreated sessionChange = iota
	// sessionQueued: a session waits for its device again: it took its
	// next input, or it still waits to be started. On the wire it is a
	// creation (agent_session_created) that viewers tell apart by status.
	sessionQueued
	sessionStarted
	sessionBlocked
	sessionResumed
	// sessionNativeSessionID: its device named the native session it runs.
	sessionNativeSessionID
	// sessionCompleted: it ended, however (completed, failed or canceled).
	sessionCompleted
)

// event is the message viewers are told the change with.
func (c sessionChange) event() eventstream.Kind[store.AgentSession] {
	switch c {
	case sessionStarted:
		return sessionStartedEvent
	case sessionBlocked:
		return sessionBlockedEvent
	case sessionResumed:
		return sessionResumedEvent
	case sessionNativeSessionID:
		return sessionNativeSessionIDEvent
	case sessionCompleted:
		return sessionCompletedEvent
	default:
		return sessionCreatedEvent
	}
}

// sessionEvents tells a session's viewers (those who may view its
// workspace) what happens to it: its state, its transcript as it grows, its
// subagents, and that a followed log of one of its background tasks grew.
// What reacts to it on the server observes it here, after the viewers were
// told: whatever changed a session tells it once, through changed or
// recorded, and every reaction follows. A device's report that a session
// ended is told once more after the device was answered (endReported), for
// what need not hold the device up.
type sessionEvents struct {
	stream eventstream.Publisher
	// The observers of each kind react in the order they were added, on the
	// publisher's goroutine; they are added before anything is published.
	changeObservers []sessionChangeObserver
	eventObservers  []sessionEventObserver
	endObservers    []sessionEndObserver
	// subagentEnds gathers the ends of a session's subagents, by session,
	// with the session's workspace (see subagentChanged).
	subagentEnds *eventstream.Throttle[string, string]
}

func newSessionEvents(stream eventstream.Publisher) *sessionEvents {
	events := &sessionEvents{stream: stream}
	events.subagentEnds = eventstream.NewThrottle(eventstream.ThrottleOptions[string, string]{
		Window: func() time.Duration { return subagentEndCoalesce },
		Merge:  func(workspaceID, _ string) string { return workspaceID },
		Emit:   func(sessionID, workspaceID string) { events.subagentUpdated(workspaceID, sessionID, nil) },
	})
	return events
}

// What reacts on the server to what happens to sessions observes one or
// more of these.
type (
	// sessionChangeObserver follows a change of a session's state; the
	// session is as its viewers got it, without its transcript.
	sessionChangeObserver interface {
		sessionChanged(ctx context.Context, change sessionChange, session store.AgentSession)
	}
	// sessionEventObserver follows an event added to a session's transcript.
	sessionEventObserver interface {
		sessionEventRecorded(ctx context.Context, event store.AgentSessionEvent)
	}
	// sessionEndObserver follows a device's report that a session ended,
	// once the device was answered.
	sessionEndObserver interface {
		sessionEndReported(ctx context.Context, session store.AgentSession)
	}
)

// observe adds observers, each to what it observes; they react after
// those added before.
func (e *sessionEvents) observe(observers ...any) {
	for _, observer := range observers {
		observes := false
		if changes, ok := observer.(sessionChangeObserver); ok {
			e.changeObservers = append(e.changeObservers, changes)
			observes = true
		}
		if events, ok := observer.(sessionEventObserver); ok {
			e.eventObservers = append(e.eventObservers, events)
			observes = true
		}
		if ends, ok := observer.(sessionEndObserver); ok {
			e.endObservers = append(e.endObservers, ends)
			observes = true
		}
		if !observes {
			panic(fmt.Sprintf("%T observes nothing of sessions", observer))
		}
	}
}

// changed tells the session's viewers about a change of its state, then
// its observers.
func (e *sessionEvents) changed(ctx context.Context, change sessionChange, session store.AgentSession) {
	session = slimAgentSession(session)
	change.event().Publish(e.stream, eventstream.Route{Workspace: session.WorkspaceID}, session)
	for _, observer := range e.changeObservers {
		observer.sessionChanged(ctx, change, session)
	}
}

// recorded streams an event added to a session's transcript to the
// viewers of workspaceID, the session's, then tells its observers.
func (e *sessionEvents) recorded(ctx context.Context, workspaceID string, event store.AgentSessionEvent) {
	sessionTranscriptEvent.Publish(e.stream, eventstream.Route{Workspace: workspaceID}, event)
	for _, observer := range e.eventObservers {
		observer.sessionEventRecorded(ctx, event)
	}
}

// endReported tells observers that a device reported the session ended,
// as it now is, once the device was answered: its viewers were told
// (changed) when it was recorded, unless it had ended before.
func (e *sessionEvents) endReported(ctx context.Context, session store.AgentSession) {
	for _, observer := range e.endObservers {
		observer.sessionEndReported(ctx, session)
	}
}

// subagentEndCoalesce is how long the ends of a session's subagents gather
// before its viewers are told to read the list again: subagents launched
// together end together, and one read covers them.
var subagentEndCoalesce = 2 * time.Second

// subagentChanged tells the workspace's viewers what a session event
// changed in its subagent list. Progress sends nothing: viewers show it from
// the event itself.
func (e *sessionEvents) subagentChanged(workspaceID string, event store.AgentSessionEvent, change subagentChange) {
	if workspaceID == "" || change == subagentUnchanged {
		return
	}
	switch change {
	case subagentStarted:
		if subagent, ok := startedSubagent(event); ok {
			e.subagentUpdated(workspaceID, event.SessionID, &subagent)
		}
	case subagentUntypedStart:
		e.subagentUpdated(workspaceID, event.SessionID, nil)
	case subagentEnded, subagentTaskEnded:
		// What it answered is on the device only, in the list. It is read by
		// whoever views the session (they read the list again), not on every
		// end: on a slow uplink each read costs, and nobody may be looking.
		e.subagentEnds.Add(event.SessionID, workspaceID)
	}
}

// subagentUpdated tells the session's viewers about one of its subagents as
// the list shows it when it starts or, without one, that the list may have
// changed: viewers holding it read it again.
func (e *sessionEvents) subagentUpdated(workspaceID, sessionID string, subagent *store.AgentSubagentDigest) {
	subagentUpdatedEvent.Publish(e.stream, eventstream.Route{Workspace: workspaceID}, browserevent.AgentSubagentUpdatedPayload{WorkspaceID: workspaceID, SessionID: sessionID, Subagent: subagent})
}

// backgroundTaskOutputChanged tells the session's viewers that a followed
// log of one of its background tasks grew: readers read what was added.
func (e *sessionEvents) backgroundTaskOutputChanged(session store.AgentSession, taskID string) {
	backgroundTaskOutputEvent.Publish(e.stream, eventstream.Route{Workspace: session.WorkspaceID}, browserevent.BackgroundTaskOutputChangedPayload{WorkspaceID: session.WorkspaceID, SessionID: session.ID, TaskID: taskID})
}
