package httpapi

import (
	"context"
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
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path == "" {
		writeError(w, http.StatusBadRequest, "session id and path are required")
		return
	}
	session := guardedSession(r)
	workspace, err := s.store.GetWorkspace(r.Context(), session.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), deviceFileRequestTimeout)
	defer cancel()
	file, err := s.hub.ReadSessionFile(ctx, session, path)
	if err != nil {
		writeResult(w, nil, deviceRequestError(workspace, err))
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
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	inputID := strings.TrimSpace(r.URL.Query().Get("inputId"))
	if path == "" {
		writeError(w, http.StatusBadRequest, "session id and path are required")
		return
	}
	session := guardedSession(r)
	workspace, err := s.store.GetWorkspace(r.Context(), session.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), deviceFileRequestTimeout)
	defer cancel()
	diff, err := s.hub.ReadSessionFileDiff(ctx, session, path, inputID)
	if err != nil {
		writeResult(w, nil, deviceRequestError(workspace, err))
		return
	}
	if !sessionFileReadableByViewer(store.SessionFileRead{Origin: diff.Origin, InsideWorkspace: diff.InsideWorkspace}) &&
		!s.requireWorkspace(w, r, session.WorkspaceID, store.WorkspaceRoleMember) {
		return
	}
	writeResult(w, diff, nil)
}
