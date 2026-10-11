package httpapi

import (
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// newBrowserStream is the stream the server tells browsers on GET
// /api/events. Each domain's notifier owns its messages: what they carry,
// whom they reach, how bursts of them coalesce, and what on the server
// reacts to them. The stream underneath only delivers.
func newBrowserStream() *eventstream.Hub {
	return eventstream.New(streamControl)
}

// The stream's own messages: where it resumes from, and that it missed
// events.
var (
	streamReady  = browserevent.Define[browserevent.StreamReadyPayload](browserevent.StreamReady, eventstream.Options{KeepsSnapshot: true})
	streamResync = browserevent.Define[browserevent.ResyncPayload](browserevent.Resync, eventstream.Options{KeepsSnapshot: true})
)

var streamControl = eventstream.Control{
	Ready: streamReady.Message(browserevent.StreamReadyPayload{}),
	Resync: func(gap eventstream.Gap) eventstream.Message {
		reason := browserevent.ResyncRestarted
		switch gap {
		case eventstream.GapOverflow:
			reason = browserevent.ResyncOverflow
		case eventstream.GapExpired:
			reason = browserevent.ResyncExpired
		case eventstream.GapReauthorized:
			reason = browserevent.ResyncReauthorized
		}
		return streamResync.Message(browserevent.ResyncPayload{Reason: reason})
	},
}

// streamReach is what one stream may receive. Session-scoped actors (CHAT-01
// tokens) follow one workspace, their own or another their scope reaches;
// people and devices receive the workspaces they can view; a stream without
// access receives nothing. An event of no workspace reaches only those who
// see every workspace. The reach is fixed when the stream opens, so a change
// of an account's access ends its streams (Reauthorize) and the browser
// reconnects with the new reach and is told to resync: the replay alone
// would not show what the new reach adds or takes away.
type streamReach struct {
	// workspace pins an agent's stream to one workspace.
	workspace string
	scope     *accessScope
}

func (r streamReach) Receives(workspaceID string) bool {
	if r.workspace != "" {
		return workspaceID == r.workspace
	}
	if r.scope == nil || r.scope.all {
		return r.scope != nil
	}
	return r.scope.can(workspaceID, store.WorkspaceRoleViewer)
}

func (r streamReach) Account() string {
	if r.scope == nil {
		return ""
	}
	return r.scope.userID
}

// handleEvents streams GET /api/events to the caller, within its reach.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	reach := streamReach{}
	if scope, ok := r.Context().Value(scopeContextKey{}).(accessScope); ok {
		reach.scope = &scope
	}
	if actor := actorFromContext(r.Context()); actor.Agent() {
		reach.workspace = requestedWorkspace(actor, r.URL.Query().Get("workspaceId"))
		if reach.workspace != actor.Identity.WorkspaceID &&
			(reach.scope == nil || !reach.scope.can(reach.workspace, store.WorkspaceRoleViewer)) {
			http.Error(w, "workspace is outside the token's scope", http.StatusForbidden)
			return
		}
	}
	s.stream.Serve(w, r, reach)
}
