package httpapi

import (
	"net/http"
	"path/filepath"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// keptSessionFrames reads the session's frames within the limits.
func (s *Server) keptSessionFrames(r *http.Request, sessionID string) (kept, dropped []store.SessionToolFrame, err error) {
	frames, err := s.store.AgentSessionFrames(r.Context(), sessionID)
	if err != nil {
		return nil, nil, err
	}
	kept, dropped = store.RetainSessionFrames(frames, store.SessionToolFrameLimitCount, store.SessionToolFrameLimitBytes)
	return kept, dropped, nil
}

// handleListSessionFrames lists a session's tool frames (DEV-075). Like
// the session itself, only its viewers read them; a session token never
// does (agent routes in routeTable).
func (s *Server) handleListSessionFrames(w http.ResponseWriter, r *http.Request) {
	session := guardedSession(r)
	kept, dropped, err := s.keptSessionFrames(r, session.ID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, store.SessionToolFrameList{
		Frames:  kept,
		Dropped: len(dropped),
		Limits:  store.SessionToolFrameListLimit{Count: store.SessionToolFrameLimitCount, Bytes: store.SessionToolFrameLimitBytes},
	})
}

// handleSessionFrameImage serves one frame's image through its session:
// the frame must be one the session recorded, still within the limits, and
// its file must lie in the session's frames directory of its workspace.
// ?variant= and ?refresh= are those of the attachment image route.
func (s *Server) handleSessionFrameImage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Vary", "Cookie, Authorization")
	w.Header().Set("Cache-Control", "no-store")
	session := guardedSession(r)
	frameID := r.PathValue("frameId")
	kept, dropped, err := s.keptSessionFrames(r, session.ID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	for _, frame := range dropped {
		if frame.ID == frameID {
			writeError(w, http.StatusGone, "this frame was removed: a session keeps its newest frames only")
			return
		}
	}
	var path string
	for _, frame := range kept {
		if frame.ID == frameID {
			path = frame.Path
		}
	}
	workspace, err := s.store.GetWorkspace(r.Context(), session.WorkspaceID)
	if path == "" || err != nil || !sessionFramePath(workspace, session.ID, path) {
		writeError(w, http.StatusNotFound, "frame not found")
		return
	}
	s.serveAttachmentImage(w, r, workspace, path)
}

// sessionFramePath reports whether a frame's file is where the session's
// frames are kept: <workspace>/.foundry/attachments/frames/<session>/.
func sessionFramePath(workspace store.WorkspaceProjection, sessionID, path string) bool {
	if workspace.LocalPath == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsRune(sessionID, filepath.Separator) {
		return false
	}
	root := filepath.Join(workspace.LocalPath, ".foundry", "attachments", "frames", sessionID)
	return filepath.Dir(path) == root
}
