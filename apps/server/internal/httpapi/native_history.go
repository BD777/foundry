package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A native chat carries only its log's latest part (ChatThread.Transcript,
// from TranscriptBefore on); its device answers for the rest a page at a
// time (read_native_history). A native chat shows those pages as someone
// scrolls back (GET /api/chats/{id}/history); a session that continued one
// imports them into its own events (sessionEventWindow).

// daemonCapabilityNativeHistory: the worker answers read_native_history.
const daemonCapabilityNativeHistory = "native_history_v1"

// nativeHistoryPagesPerRead bounds the device pages one read imports while
// they hold nothing to show (a run of metadata or oversized lines).
const nativeHistoryPagesPerRead = 8

type wsReadNativeHistoryPayload struct {
	WorkspaceID     string `json:"workspaceId"`
	Provider        string `json:"provider"`
	NativeSessionID string `json:"nativeSessionId"`
	Before          int64  `json:"before"`
}

type wsNativeHistoryReadPayload struct {
	Transcript []store.TranscriptMessage `json:"transcript"`
	Before     int64                     `json:"before"`
	wsReplyError
}

// nativeHistoryPage is a page of a native chat's log and where it starts.
type nativeHistoryPage struct {
	Transcript []store.TranscriptMessage `json:"transcript"`
	Before     int64                     `json:"before"`
}

var errNativeHistoryUnsupported = &statusError{http.StatusServiceUnavailable,
	errors.New("the device's Foundry worker is too old to read earlier native history; update it")}

var errNativeHistoryOffline = &statusError{http.StatusServiceUnavailable,
	errors.New("earlier native history is on its device, which is not connected")}

// ReadNativeHistory asks the device for the page of a native chat's log
// that ends at byte before.
func (h *DaemonHub) ReadNativeHistory(ctx context.Context, deviceID, workspaceID, provider, nativeSessionID string, before int64) (nativeHistoryPage, error) {
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return nativeHistoryPage{}, errNativeHistoryOffline
	}
	if !connection.hasCapability(daemonCapabilityNativeHistory) {
		return nativeHistoryPage{}, errNativeHistoryUnsupported
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	value, err := callDevice[wsNativeHistoryReadPayload](ctx, connection, wsReadNativeHistoryType,
		wsReadNativeHistoryPayload{WorkspaceID: workspaceID, Provider: provider, NativeSessionID: nativeSessionID, Before: before})
	if err != nil {
		return nativeHistoryPage{}, err
	}
	if value.Before >= before {
		return nativeHistoryPage{}, errors.New("the device answered a page that does not move back")
	}
	return nativeHistoryPage{Transcript: value.Transcript, Before: max(value.Before, 0)}, nil
}

// handleGetChatHistory answers GET /api/chats/{id}/history?before=: the
// page of the native chat's log before that byte offset.
func (s *Server) handleGetChatHistory(w http.ResponseWriter, r *http.Request) {
	before, err := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	if err != nil || before <= 0 {
		writeError(w, http.StatusBadRequest, "before must be a positive byte offset")
		return
	}
	chat, err := s.store.GetChat(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if !s.canReadNativeChat(r.Context(), actorFromContext(r.Context()), chat.WorkspaceID, chat.ID) {
		writeForbidden(w, "session token cannot read this chat")
		return
	}
	if chat.NativeSessionID == "" || chat.Provider == "" {
		writeError(w, http.StatusNotFound, "not a native chat")
		return
	}
	workspace, err := s.store.GetWorkspace(r.Context(), chat.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	page, err := s.hub.ReadNativeHistory(r.Context(), workspace.DeviceID, chat.WorkspaceID, chat.Provider, chat.NativeSessionID, before)
	writeResult(w, page, err)
}

// nativeHistoryImports serializes imports per session, so two readers
// scrolling back at once ask the device once.
var nativeHistoryImports sync.Map

// sessionEventWindow is windowSessionEvents for a session that continued
// a native chat: once a reader holds its oldest stored event, the chat's
// earlier history is imported from the device a page at a time, so
// paging back reaches the chat's start as in any session.
func (s *Server) sessionEventWindow(ctx context.Context, session store.AgentSession, window eventWindow) (windowedAgentSession, error) {
	page, err := windowSessionEvents(ctx, s.store, session, window)
	if err != nil || page.EventsBefore != "" {
		return page, err
	}
	history, found, err := s.store.SessionNativeHistory(ctx, session.ID)
	if err != nil || !found {
		return page, err
	}
	if window.before == "" || len(page.Events) > 0 {
		// The oldest stored event is in this page: older ones are the
		// chat's, read on the next page.
		page.EventsBefore, err = s.store.AgentSessionOldestEventCursor(ctx, session.ID)
		return page, err
	}
	lock, _ := nativeHistoryImports.LoadOrStore(session.ID, &sync.Mutex{})
	lock.(*sync.Mutex).Lock()
	defer lock.(*sync.Mutex).Unlock()
	for range nativeHistoryPagesPerRead {
		history, found, err = s.store.SessionNativeHistory(ctx, session.ID)
		if err != nil || !found {
			break
		}
		older, err := s.hub.ReadNativeHistory(ctx, history.DeviceID, session.WorkspaceID, history.Provider, history.NativeSessionID, history.Before)
		if err != nil {
			return windowedAgentSession{}, err
		}
		if err := s.store.ImportNativeHistory(ctx, session.ID, history, older.Transcript, older.Before); err != nil {
			return windowedAgentSession{}, err
		}
		if len(older.Transcript) > 0 {
			break
		}
	}
	if err != nil {
		return windowedAgentSession{}, err
	}
	page, err = windowSessionEvents(ctx, s.store, session, window)
	if err != nil || page.EventsBefore != "" || len(page.Events) == 0 {
		return page, err
	}
	if _, found, err := s.store.SessionNativeHistory(ctx, session.ID); err != nil || !found {
		return page, err
	}
	page.EventsBefore, err = s.store.AgentSessionOldestEventCursor(ctx, session.ID)
	return page, err
}
