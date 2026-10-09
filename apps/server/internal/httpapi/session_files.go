package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// handleReadSessionFile reads a file the session's own tools wrote or its
// answer named. The device checks the path against the session's file
// ledger and answers with the entry's origin; roles stay on the server:
// every Viewer of the workspace may read what the tools wrote and anything
// inside the workspace, while a file outside the workspace that the answer
// only names needs Member, as browsing the device's folders would.
func (s *Server) handleReadSessionFile(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	sessionID := strings.TrimSpace(r.PathValue("id"))
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if sessionID == "" || path == "" {
		writeError(w, http.StatusBadRequest, "session id and path are required")
		return
	}
	session, err := s.store.GetAgentSessionSummary(r.Context(), sessionID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if !s.canReadSession(r.Context(), actorFromContext(r.Context()), session) {
		writeForbidden(w, "session token cannot read this session's files")
		return
	}
	workspace, err := s.store.GetWorkspace(r.Context(), session.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), deviceFileRequestTimeout)
	defer cancel()
	file, err := s.hub.ReadSessionFile(ctx, session, path)
	if writeDeviceRequestError(w, workspace, err) {
		return
	}
	var refusal sessionFileRefusal
	if errors.As(err, &refusal) {
		writeError(w, http.StatusNotFound, refusal.reason)
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if !sessionFileReadableByViewer(file) &&
		!s.requireWorkspace(w, r, session.WorkspaceID, store.WorkspaceRoleMember) {
		return
	}
	writeResult(w, file, nil)
}

// sessionFileReadableByViewer: a write tool's file, or one inside the
// workspace. Anything else is a path the answer named on the device.
func sessionFileReadableByViewer(file store.SessionFileRead) bool {
	return file.Origin == "tool" || file.InsideWorkspace
}

// handleReadSessionFileDiff reads what the session's own writes changed in
// one of its files: one turn's with `inputId`, otherwise the whole
// session's. The same roles as reading the file apply.
func (s *Server) handleReadSessionFileDiff(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	sessionID := strings.TrimSpace(r.PathValue("id"))
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	inputID := strings.TrimSpace(r.URL.Query().Get("inputId"))
	if sessionID == "" || path == "" {
		writeError(w, http.StatusBadRequest, "session id and path are required")
		return
	}
	session, err := s.store.GetAgentSessionSummary(r.Context(), sessionID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if !s.canReadSession(r.Context(), actorFromContext(r.Context()), session) {
		writeForbidden(w, "session token cannot read this session's files")
		return
	}
	workspace, err := s.store.GetWorkspace(r.Context(), session.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), deviceFileRequestTimeout)
	defer cancel()
	diff, err := s.hub.ReadSessionFileDiff(ctx, session, path, inputID)
	if writeDeviceRequestError(w, workspace, err) {
		return
	}
	var refusal sessionFileRefusal
	if errors.As(err, &refusal) {
		writeError(w, http.StatusNotFound, refusal.reason)
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if !sessionFileReadableByViewer(store.SessionFileRead{Origin: diff.Origin, InsideWorkspace: diff.InsideWorkspace}) &&
		!s.requireWorkspace(w, r, session.WorkspaceID, store.WorkspaceRoleMember) {
		return
	}
	writeResult(w, diff, nil)
}
