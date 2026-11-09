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
	writeResult(w, nil, err)
}
