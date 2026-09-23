package httpapi

import (
	"context"
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Actor is the authenticated identity behind one API call.
type Actor struct {
	Kind     ActorKind
	Identity store.SessionTokenIdentity
	DeviceID string
	// Account is set when a logged-in Foundry account made the call
	// (ActorAccount).
	Account *store.User
}

type ActorKind string

const (
	ActorAccount ActorKind = "account" // logged-in Foundry account (cookie session)
	ActorDaemon  ActorKind = "daemon"  // worker device credential; acts with its owner account
	ActorAgent   ActorKind = "agent"   // session-scoped MCP/CLI token
)

type actorContextKey struct{}

func actorInContext(ctx context.Context, actor Actor) context.Context {
	return context.WithValue(ctx, actorContextKey{}, actor)
}

func actorFromContext(ctx context.Context) Actor {
	actor, _ := ctx.Value(actorContextKey{}).(Actor)
	return actor
}

// FullAccess actors retain the pre-CHAT-01 control-plane authority.
func (a Actor) FullAccess() bool {
	switch a.Kind {
	case ActorDaemon, ActorAccount:
		return true
	default:
		return false
	}
}

// ActsAsDevice reports whether a daemon call may speak for deviceID. A
// credential binds exactly one device; only package tests produce a daemon
// actor without one.
func (a Actor) ActsAsDevice(deviceID string) bool {
	return a.Kind == ActorDaemon && (a.DeviceID == "" || a.DeviceID == deviceID)
}

// AccountID is the account behind a human or device call; "" for agents.
func (a Actor) AccountID() string {
	if a.Account == nil {
		return ""
	}
	return a.Account.ID
}

// Agent reports whether this call comes from a session-scoped token.
func (a Actor) Agent() bool { return a.Kind == ActorAgent }

// WorkspaceScope returns the actor's workspace and true when the actor may
// only ever see that workspace.
func (a Actor) WorkspaceScope() (string, bool) {
	if a.Kind == ActorAgent {
		return a.Identity.WorkspaceID, true
	}
	return "", false
}

func writeForbidden(w http.ResponseWriter, message string) {
	writeError(w, http.StatusForbidden, message)
}

// activeOrBlocked reports the statuses on which steer/cancel are legal.
func activeOrBlocked(status string) bool {
	return status == "queued" || status == "running" || status == "blocked"
}
