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
	// Authorize as the session read does, before any reconciliation.
	anchor, err := s.sessionSummary(r, r.PathValue("id"))
	if err != nil {
		writeResult(w, anchor, err)
		return
	}
	if !s.canReadSession(r.Context(), actorFromContext(r.Context()), anchor) {
		writeForbidden(w, "session token cannot read this session")
		return
	}
	catchUp, ok := s.store.(store.SessionEventCatchUpStore)
	if !ok {
		writeError(w, http.StatusBadRequest, "this server cannot catch up a transcript: read the session without eventsAfter")
		return
	}
	item, err := store.AgentSessionRecord(r.Context(), s.store, anchor.ID)
	if err != nil {
		writeResult(w, item, err)
		return
	}
	item, _, err = s.reconcileAgentSession(r.Context(), item)
	if err != nil {
		writeResult(w, item, err)
		return
	}
	events, newest, more, err := catchUp.AgentSessionEventsAfter(r.Context(), item.ID, r.URL.Query().Get("eventsAfter"), window.limit)
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
	writeResult(w, caughtUpAgentSession{AgentSession: item, Events: events, EventsAfter: newest, EventsMore: more}, nil)
}
