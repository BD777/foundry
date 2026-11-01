package httpapi

import (
	"errors"
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// handleDaemonSessionToken mints a token for a session its own device runs.
// Claude fires a timer itself while its process lives, with no dispatch to
// mint one; the device asks for a fresh token as the timer's turn starts, so
// a timer firing long after the session last used its tools still reaches
// them (a token idles out a day after its last use, session_tokens.go).
func (s *Server) handleDaemonSessionToken(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	session, err := s.store.GetAgentSessionSummary(ctx, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) || (err == nil && !actorFromContext(ctx).ActsAsDevice(session.DeviceID)) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	token, err := s.store.MintAgentSessionToken(ctx, session.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"sessionToken": token})
}
