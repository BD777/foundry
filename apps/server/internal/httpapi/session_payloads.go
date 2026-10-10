package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// slimAgentSession is a session as streams and write replies carry it:
// status, input, ids, activity and answer, without the transcript. A long
// chat's events run to megabytes; clients read them one at a time from
// agent_session_event, or from the session and thread read endpoints.
// The input's imported context (the turns a native session missed) can be
// as long; only the session read endpoint returns it.
func slimAgentSession(session store.AgentSession) store.AgentSession {
	session.Events = nil
	session.Input.ImportedContext = ""
	return session
}

// sessionEventsRequested reads ?events=: "none" asks a session read for the
// session without its transcript (what `foundry session wait` polls).
func sessionEventsRequested(r *http.Request) bool {
	return r.URL.Query().Get("events") != "none"
}

// maxEventsWindow caps ?eventsLimit=: a reader pages back for more.
const maxEventsWindow = 1000

// eventWindow is a windowed transcript read: at most limit events, the
// newest, or those before the cursor a previous read returned.
type eventWindow struct {
	limit  int
	before string
}

// requestedEventWindow reads ?eventsLimit= and ?eventsBefore=. Without
// either a read returns every event, as it always has. A limit above
// maxEventsWindow is capped; a cursor without a limit reads that many.
func requestedEventWindow(r *http.Request) (eventWindow, bool, error) {
	query := r.URL.Query()
	rawLimit, before := query.Get("eventsLimit"), query.Get("eventsBefore")
	if rawLimit == "" && before == "" {
		return eventWindow{}, false, nil
	}
	window := eventWindow{limit: maxEventsWindow, before: before}
	if rawLimit != "" {
		limit, err := strconv.Atoi(rawLimit)
		if err != nil || limit <= 0 {
			return eventWindow{}, false, fmt.Errorf("eventsLimit must be a positive integer")
		}
		window.limit = min(limit, maxEventsWindow)
	}
	return window, true, nil
}

// windowedAgentSession is a session with one window of its events.
// EventsBefore is the cursor of the events older than those, absent when
// the session's history is complete.
type windowedAgentSession struct {
	store.AgentSession
	// Events is always present: [] is an empty window, not an unread one.
	Events       []store.AgentSessionEvent `json:"events"`
	EventsBefore string                    `json:"eventsBefore,omitempty"`
	// StateEvents come with the newest window when older events exist:
	// those of the older events the side panel reads (see
	// panelStateEvents), so it shows the session's state whatever is
	// loaded. A page of older events carries none; its reader holds them.
	StateEvents []store.AgentSessionEvent `json:"stateEvents,omitempty"`
}

func windowSessionEvents(ctx context.Context, windows store.SessionEventWindowStore, session store.AgentSession, window eventWindow) (windowedAgentSession, error) {
	events, before, err := windows.AgentSessionEventWindow(ctx, session.ID, window.before, window.limit)
	if err != nil {
		return windowedAgentSession{}, err
	}
	session.Events = nil
	page := windowedAgentSession{AgentSession: session, Events: events, EventsBefore: before}
	if states, ok := windows.(store.SessionStateStore); ok && window.before == "" && before != "" {
		older, err := states.AgentSessionStateEvents(ctx, session.ID, before)
		if err != nil {
			return windowedAgentSession{}, err
		}
		page.StateEvents = panelStateEvents(older, events)
	}
	return page, nil
}

// writeEventWindowError answers a failed windowed read; a cursor no read
// returned is the caller's mistake.
func writeEventWindowError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrInvalidEventsCursor) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeResult(w, nil, err)
}
