package httpapi

import (
	"errors"
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// caughtUpAgentSession is a session with the events stored after a
// reader's cursor: what a reader that missed stream events lacks.
type caughtUpAgentSession struct {
	store.AgentSession
	// Events is always present, oldest first: [] says nothing was missed.
	Events []store.AgentSessionEvent `json:"events"`
	// EventsAfter is the cursor to catch up from next time.
	EventsAfter string `json:"eventsAfter"`
	// EventsMore says more than eventsLimit events followed the cursor:
	// none were returned, and the reader reads the newest window instead.
	EventsMore bool `json:"eventsMore,omitempty"`
}

// handleGetAgentSessionEventsAfter answers GET /api/agent-sessions/{id}
// ?eventsAfter=<cursor>: a reader that missed stream events (a reconnect,
// a resync) reads only those, rather than reload its window. The cursor
// is a window's eventsAfter or a previous catch-up's; ?eventsLimit= bounds
// how far behind the reader may be.
func (s *Server) handleGetAgentSessionEventsAfter(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Has("eventsBefore") {
		writeError(w, http.StatusBadRequest, "eventsAfter catches up and eventsBefore pages back: name one")
		return
	}
	window, windowed, err := requestedEventWindow(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !windowed {
		window.limit = maxEventsWindow
	}
	item, err := store.AgentSessionRecord(r.Context(), s.store, guardedSession(r).ID)
	if err != nil {
		writeResult(w, item, err)
		return
	}
	item, _, err = s.reconcileAgentSession(r.Context(), item)
	if err != nil {
		writeResult(w, item, err)
		return
	}
	events, newest, more, err := s.store.AgentSessionEventsAfter(r.Context(), item.ID, r.URL.Query().Get("eventsAfter"), window.limit)
	if errors.Is(err, store.ErrEventsCursorGone) {
		writeError(w, http.StatusGone, err.Error()+": read the newest window")
		return
	}
	if err != nil {
		writeEventWindowError(w, err)
		return
	}
	if events == nil {
		events = []store.AgentSessionEvent{}
	}
	item.Events = nil
	item = s.presentSession(r.Context(), item)
	writeResult(w, caughtUpAgentSession{AgentSession: item, Events: events, EventsAfter: newest, EventsMore: more}, nil)
}
