package sessions

import (
	"context"
	"strings"
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

// Change is what happened to a session as a whole. Viewers get the
// session without its transcript, which travels one event at a time
// (agent_session_event).
type Change int

const (
	// Created: a new session waits for its device.
	Created Change = iota
	// Queued: a session waits for its device again: it took its
	// next input, or it still waits to be started. On the wire it is a
	// creation (agent_session_created) that viewers tell apart by status.
	Queued
	Started
	Blocked
	Resumed
	// NativeSessionID: its device named the native session it runs.
	NativeSessionID
	// Completed: it ended, however (completed, failed or canceled).
	Completed
)

// Event is the message viewers are told the change with.
func (c Change) Event() eventstream.Kind[store.AgentSession] {
	switch c {
	case Started:
		return sessionStartedEvent
	case Blocked:
		return sessionBlockedEvent
	case Resumed:
		return sessionResumedEvent
	case NativeSessionID:
		return sessionNativeSessionIDEvent
	case Completed:
		return sessionCompletedEvent
	default:
		return sessionCreatedEvent
	}
}

// Slim is a session as streams and write replies carry it:
// status, input, ids, activity and answer, without the transcript. A long
// chat's events run to megabytes; clients read them one at a time from
// agent_session_event, or from the session and thread read endpoints.
// The input's imported context (the turns a native session missed) can be
// as long; only the session read endpoint returns it.
func Slim(session store.AgentSession) store.AgentSession {
	session.Events = nil
	session.Input.ImportedContext = ""
	return session
}

// ChangeNotifier tells a session's viewers, and what observes sessions,
// that it changed (Events).
type ChangeNotifier interface {
	Changed(ctx context.Context, change Change, session store.AgentSession)
}

// Notifier also tells them that its transcript grew.
type Notifier interface {
	ChangeNotifier
	Recorded(ctx context.Context, workspaceID string, event store.AgentSessionEvent)
}

// Events tells a session's viewers (those who may view its
// workspace) what happens to it: its state, its transcript as it grows, its
// subagents, and that a followed log of one of its background tasks grew.
// What reacts to it on the server observes it here, after the viewers were
// told: whatever changed a session tells it once, through Changed or
// Recorded, and every reaction follows. A device's report that a session
// ended is told once more after the device was answered (EndReported), for
// what need not hold the device up.
type Events struct {
	stream eventstream.Publisher
	// observers react on the publisher's goroutine; they are set before
	// anything is published (httpapi's server.go).
	observers Observers
	// subagentEnds gathers the ends of a session's subagents, by session,
	// with the session's workspace (see SubagentChanged).
	subagentEnds *eventstream.Throttle[string, string]
	// Presented, when set, is a session as viewers read it (the role the
	// server computes); observers get the session as stored.
	Presented func(ctx context.Context, session store.AgentSession) store.AgentSession
}

// NewEvents tells sessions' viewers on stream.
func NewEvents(stream eventstream.Publisher) *Events {
	events := &Events{stream: stream}
	events.subagentEnds = eventstream.NewThrottle(eventstream.ThrottleOptions[string, string]{
		Window: func() time.Duration { return SubagentEndCoalesce },
		Merge:  func(workspaceID, _ string) string { return workspaceID },
		Emit:   func(sessionID, workspaceID string) { events.subagentUpdated(workspaceID, sessionID, nil) },
	})
	return events
}

// What reacts on the server to what happens to sessions observes one or
// more of these.
type (
	// ChangeObserver follows a change of a session's state; the
	// session is as stored, without its transcript.
	ChangeObserver interface {
		SessionChanged(ctx context.Context, change Change, session store.AgentSession)
	}
	// EventObserver follows an event added to a session's transcript.
	EventObserver interface {
		SessionEventRecorded(ctx context.Context, event store.AgentSessionEvent)
	}
	// EndObserver follows a device's report that a session ended,
	// once the device was answered.
	EndObserver interface {
		SessionEndReported(ctx context.Context, session store.AgentSession)
	}
)

// Observers is what reacts on the server to sessions, by what it
// follows; each list reacts in its order, one after another. An observer
// that follows several kinds is named in each list.
type Observers struct {
	Changes []ChangeObserver
	Events  []EventObserver
	Ends    []EndObserver
}

// Observe adds observers after those added before, kind by kind.
func (e *Events) Observe(observers Observers) {
	e.observers.Changes = append(e.observers.Changes, observers.Changes...)
	e.observers.Events = append(e.observers.Events, observers.Events...)
	e.observers.Ends = append(e.observers.Ends, observers.Ends...)
}

// Observing is what observes sessions, in the order it reacts.
func (e *Events) Observing() Observers {
	return Observers{
		Changes: append([]ChangeObserver(nil), e.observers.Changes...),
		Events:  append([]EventObserver(nil), e.observers.Events...),
		Ends:    append([]EndObserver(nil), e.observers.Ends...),
	}
}

// Changed tells the session's viewers about a change of its state, then
// its observers.
func (e *Events) Changed(ctx context.Context, change Change, session store.AgentSession) {
	session = Slim(session)
	viewed := session
	if e.Presented != nil {
		viewed = e.Presented(ctx, session)
	}
	change.Event().Publish(e.stream, eventstream.Route{Workspace: session.WorkspaceID}, viewed)
	for _, observer := range e.observers.Changes {
		observer.SessionChanged(ctx, change, session)
	}
}

// Recorded streams an event added to a session's transcript to the
// viewers of workspaceID, the session's, then tells its observers.
func (e *Events) Recorded(ctx context.Context, workspaceID string, event store.AgentSessionEvent) {
	sessionTranscriptEvent.Publish(e.stream, eventstream.Route{Workspace: workspaceID}, event)
	for _, observer := range e.observers.Events {
		observer.SessionEventRecorded(ctx, event)
	}
}

// EndReported tells observers that a device reported the session ended,
// as it now is, once the device was answered: its viewers were told
// (Changed) when it was recorded, unless it had ended before.
func (e *Events) EndReported(ctx context.Context, session store.AgentSession) {
	for _, observer := range e.observers.Ends {
		observer.SessionEndReported(ctx, session)
	}
}

// SubagentChange is what a session event changed in the session's
// subagent list.
type SubagentChange int

const (
	SubagentUnchanged SubagentChange = iota
	// SubagentStarted: a subagent started; its event names it in full.
	SubagentStarted
	// SubagentEnded: a subagent finished or failed.
	SubagentEnded
	// SubagentTaskEnded: a task the server did not see start ended; it is a
	// subagent only if its device lists it.
	SubagentTaskEnded
	// SubagentUntypedStart: a task started without its type (workers before
	// they sent it); it may be a subagent.
	SubagentUntypedStart
)

// SubagentEndCoalesce is how long the ends of a session's subagents gather
// before its viewers are told to read the list again: subagents launched
// together end together, and one read covers them.
var SubagentEndCoalesce = 2 * time.Second

// SubagentChanged tells the workspace's viewers what a session event
// changed in its subagent list. Progress sends nothing: viewers show it from
// the event itself.
func (e *Events) SubagentChanged(workspaceID string, event store.AgentSessionEvent, change SubagentChange) {
	if workspaceID == "" || change == SubagentUnchanged {
		return
	}
	switch change {
	case SubagentStarted:
		if subagent, ok := startedSubagent(event); ok {
			e.subagentUpdated(workspaceID, event.SessionID, &subagent)
		}
	case SubagentUntypedStart:
		e.subagentUpdated(workspaceID, event.SessionID, nil)
	case SubagentEnded, SubagentTaskEnded:
		// What it answered is on the device only, in the list. It is read by
		// whoever views the session (they read the list again), not on every
		// end: on a slow uplink each read costs, and nobody may be looking.
		e.subagentEnds.Add(event.SessionID, workspaceID)
	}
}

// subagentUpdated tells the session's viewers about one of its subagents as
// the list shows it when it starts or, without one, that the list may have
// changed: viewers holding it read it again.
func (e *Events) subagentUpdated(workspaceID, sessionID string, subagent *store.AgentSubagentDigest) {
	subagentUpdatedEvent.Publish(e.stream, eventstream.Route{Workspace: workspaceID}, browserevent.AgentSubagentUpdatedPayload{WorkspaceID: workspaceID, SessionID: sessionID, Subagent: subagent})
}

// BackgroundTaskOutputChanged tells the session's viewers that a followed
// log of one of its background tasks grew: readers read what was added.
func (e *Events) BackgroundTaskOutputChanged(session store.AgentSession, taskID string) {
	backgroundTaskOutputEvent.Publish(e.stream, eventstream.Route{Workspace: session.WorkspaceID}, browserevent.BackgroundTaskOutputChangedPayload{WorkspaceID: session.WorkspaceID, SessionID: session.ID, TaskID: taskID})
}

// startedSubagent is the list's entry for the subagent a start event names;
// false for one its device does not list (no tool call).
func startedSubagent(event store.AgentSessionEvent) (store.AgentSubagentDigest, bool) {
	metadata := event.Metadata
	if metadata.ToolUseID == "" {
		return store.AgentSubagentDigest{}, false
	}
	// The device's title: the task's description, which workers write as
	// the detail ("Subtask started." when it has none).
	title := strings.TrimSpace(event.Detail)
	if title == "" || title == "Subtask started." {
		title = "Subagent"
	}
	return store.AgentSubagentDigest{
		ResponseFingerprints: []string{},
		SessionID:            event.SessionID,
		Status:               "running",
		SubagentType:         metadata.SubagentType,
		TaskID:               metadata.TaskID,
		Title:                title,
		ToolUseID:            metadata.ToolUseID,
	}, true
}
