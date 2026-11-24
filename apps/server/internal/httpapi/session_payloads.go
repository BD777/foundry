package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// sessionEventsRequested reads ?events=: "none" asks a session read for the
// session without its transcript (what `foundry session wait` polls).
func sessionEventsRequested(r *http.Request) bool {
	return r.URL.Query().Get("events") != "none"
}

// maxEventsWindow caps ?eventsLimit=: a reader pages back for more.
const maxEventsWindow = 1000

// eventWindow is a windowed transcript read: at most limit events, the
// newest, or those before the cursor a previous read returned. With through
// it reaches back to that message (seekEventWindow).
type eventWindow struct {
	limit   int
	before  string
	through string
}

// requestedEventWindow reads ?eventsLimit=, ?eventsBefore= and
// ?eventsThrough=. Without any a read returns every event, as it always
// has. A limit above maxEventsWindow is capped; a cursor without a limit
// reads that many.
func requestedEventWindow(r *http.Request) (eventWindow, bool, error) {
	query := r.URL.Query()
	rawLimit, before, through := query.Get("eventsLimit"), query.Get("eventsBefore"), query.Get("eventsThrough")
	if rawLimit == "" && before == "" && through == "" {
		return eventWindow{}, false, nil
	}
	window := eventWindow{limit: maxEventsWindow, before: before, through: through}
	if rawLimit != "" {
		limit, err := strconv.Atoi(rawLimit)
		if err != nil || limit <= 0 {
			return eventWindow{}, false, fmt.Errorf("eventsLimit must be a positive integer")
		}
		window.limit = min(limit, maxEventsWindow)
	}
	return window, true, nil
}

// errMessageNotInTranscript answers ?eventsThrough= naming a message no
// event before the cursor holds: deleted, or never this session's.
var errMessageNotInTranscript = errors.New("no event of the session before the cursor holds that message")

// seekEventWindow is the window ?eventsThrough= asks for: a reader opened
// at a message it has not loaded (a link to it) reads back to it at once,
// rather than a page at a time through thousands of events. The window
// holds every event from the cursor back to the message's, and limit more
// before it for the message's context; it stays one contiguous page, so
// paging back continues from its eventsBefore as from any other.
func seekEventWindow(ctx context.Context, db Backend, sessionID string, window eventWindow) (eventWindow, error) {
	if window.through == "" {
		return window, nil
	}
	count, found, err := db.AgentSessionEventsThrough(ctx, sessionID, window.before, window.through)
	if err != nil {
		return window, err
	}
	if !found {
		return window, errMessageNotInTranscript
	}
	window.limit += count
	return window, nil
}

// windowedAgentSession is a session with one window of its events.
// EventsBefore is the cursor of the events older than those, absent when
// the session's history is complete.
type windowedAgentSession struct {
	store.AgentSession
	// Events is always present: [] is an empty window, not an unread one.
	Events       []store.AgentSessionEvent `json:"events"`
	EventsBefore string                    `json:"eventsBefore,omitempty"`
	// EventsAfter comes with the newest window: the cursor of its newest
	// event, from which a reader holding it catches up on what it missed
	// (?eventsAfter=). A page of older events carries none.
	EventsAfter string `json:"eventsAfter,omitempty"`
	// Panel comes with the newest window: what the session's side panel
	// shows (sessionPanel), whichever of its events a reader holds. A page
	// of older events carries none.
	Panel *store.AgentSessionPanel `json:"panel,omitempty"`
}

func windowSessionEvents(ctx context.Context, db Backend, session store.AgentSession, window eventWindow) (windowedAgentSession, error) {
	events, before, newest, err := db.AgentSessionEventWindowSpan(ctx, session.ID, window.before, window.limit)
	if err != nil {
		return windowedAgentSession{}, err
	}
	session.Events = nil
	page := windowedAgentSession{AgentSession: session, Events: events, EventsBefore: before}
	if window.before == "" {
		page.EventsAfter = newest
		panel, err := sessionPanel(ctx, db, session)
		if err != nil {
			return windowedAgentSession{}, err
		}
		page.Panel = &panel
	}
	return page, nil
}

// sessionPanel is the session's side panel, derived from its state events
// (store.DeriveSessionPanel) and the timers its agent still holds now.
func sessionPanel(ctx context.Context, db store.SessionStateStore, session store.AgentSession) (store.AgentSessionPanel, error) {
	events, err := db.AgentSessionStateEvents(ctx, session.ID, "")
	if err != nil {
		return store.AgentSessionPanel{}, err
	}
	session.Scheduled = session.Scheduled.Live(time.Now())
	return store.DeriveSessionPanel(session, events), nil
}

// sessionPanelOf is the side panel of the session as it is now.
func (s *Server) sessionPanelOf(ctx context.Context, sessionID string) (store.AgentSessionPanel, error) {
	session, err := s.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil {
		return store.AgentSessionPanel{}, err
	}
	return sessionPanel(ctx, s.store, session)
}

// writeEventWindowError answers a failed windowed read; a cursor no read
// returned is the caller's mistake.
func writeEventWindowError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrInvalidEventsCursor) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if errors.Is(err, errMessageNotInTranscript) {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeResult(w, nil, err)
}
