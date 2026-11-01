package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) authorizeArchive(ctx context.Context, actor Actor, input store.ArchiveChatsInput) ([]string, error) {
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return nil, err
	}
	if !scope.can(input.WorkspaceID, store.WorkspaceRoleMember) {
		return nil, &statusError{http.StatusNotFound, store.ErrNotFound}
	}
	ids, err := s.store.ArchiveChatIDs(ctx, input)
	if err != nil {
		return nil, err
	}
	if actor.Agent() {
		for _, id := range ids {
			if strings.HasPrefix(id, "native_") {
				if !s.canArchiveNativeChat(ctx, actor, input.WorkspaceID) {
					return nil, &statusError{http.StatusForbidden, errors.New("an agent may archive native chats only on a device its person paired, outside an Issue")}
				}
				continue
			}
			session, e := s.store.GetAgentSessionSummary(ctx, id)
			if e != nil || !s.canControlSession(ctx, actor, session) {
				return nil, &statusError{http.StatusForbidden, errors.New("an agent may archive only sessions it controls")}
			}
		}
	}
	return ids, nil
}
func (s *Server) archiveChats(ctx context.Context, actor Actor, input store.ArchiveChatsInput, restore bool) (store.ArchiveChatsResult, error) {
	empty := store.ArchiveChatsResult{}
	timing := archiveTiming{started: time.Now()}
	defer timing.log(input, restore)
	ids, err := s.authorizeArchive(ctx, actor, input)
	timing.mark(&timing.authorize)
	timing.chats = len(ids)
	if err != nil {
		return empty, err
	}
	// Import retained timer and native-work snapshots before preflight so work
	// that has not been opened in the work panel is included too. Restoring
	// checks no work, so it imports nothing.
	if !restore {
		for _, id := range ids {
			session, e := s.store.GetAgentSessionSummary(ctx, id)
			if e == nil {
				if e = s.importThreadWork(ctx, session); e != nil {
					return empty, e
				}
			}
		}
	}
	timing.mark(&timing.work)
	var hidden []store.ArchiveHiddenChat
	if input.DryRun && !restore {
		hidden, err = s.previewNativeArchives(ctx, actor, input.WorkspaceID, ids)
		if err != nil {
			return empty, err
		}
	}
	timing.mark(&timing.preview)
	// Serialize with scheduled dispatch so an already admitted timer cannot
	// create a new child after the archive transaction commits. A dry run
	// commits nothing and reads one snapshot, so it does not wait for dispatch.
	if !input.DryRun {
		s.workMu.Lock()
		defer s.workMu.Unlock()
	}
	timing.mark(&timing.lock)
	input.ArchivedByUser = actor.AccountID()
	if actor.Agent() {
		input.ArchivedBySession = actor.Identity.SessionID
	}
	result, err := s.store.ArchiveChats(ctx, input, restore)
	timing.mark(&timing.store)
	defer timing.mark(&timing.after)
	result.NativeAlsoHidden = hidden
	if err == nil && !input.DryRun {
		label := "Chat archived"
		if restore {
			label = "Chat unarchived"
		}
		actorLabel := actor.AccountID()
		if actor.Account != nil {
			actorLabel = actor.Account.DisplayName
			if actorLabel == "" {
				actorLabel = actor.Account.Username
			}
		}
		if actor.Agent() {
			actorLabel = actor.Identity.SessionID
			if source, e := s.store.GetAgentSessionSummary(ctx, actor.Identity.SessionID); e == nil && source.Title != "" {
				actorLabel = source.Title
			}
		}
		audit := struct {
			store.ArchiveChatsResult
			ActorLabel     string `json:"actorLabel"`
			ActorUserID    string `json:"actorUserId,omitempty"`
			ActorSessionID string `json:"actorSessionId,omitempty"`
		}{ArchiveChatsResult: result, ActorLabel: actorLabel, ActorUserID: input.ArchivedByUser, ActorSessionID: input.ArchivedBySession}
		for _, id := range result.Archived {
			if session, e := s.store.GetAgentSessionSummary(ctx, id); e == nil {
				s.workAudit(ctx, session, label, audit)
			}
		}
		if layout, e := s.store.GetChatLayout(ctx, input.WorkspaceID); e == nil {
			s.chats.layoutChanged(input.WorkspaceID, layout)
		}
		s.projectionsChanged(input.WorkspaceID, fieldChats, fieldAgentSessions)
		if devices, e := s.store.ListDevices(ctx); e == nil {
			for _, device := range devices {
				go s.hub.reconcileNativeArchives(device.ID)
			}
		}
	}
	return result, err
}

// archiveTiming attributes a slow archive request to its phases, so a
// regression shows whether the work import, the device preview, the work
// lock, the store transaction or the notifications after it took the time.
type archiveTiming struct {
	started, last                                time.Time
	chats                                        int
	authorize, work, preview, lock, store, after time.Duration
}

func (t *archiveTiming) mark(phase *time.Duration) {
	now := time.Now()
	if t.last.IsZero() {
		t.last = t.started
	}
	*phase, t.last = now.Sub(t.last), now
}

const slowArchiveThreshold = 300 * time.Millisecond

func (t *archiveTiming) log(input store.ArchiveChatsInput, restore bool) {
	if total := time.Since(t.started); total >= slowArchiveThreshold {
		log.Printf("slow archive: dryRun=%t restore=%t chats=%d total=%s authorize=%s work=%s preview=%s lock=%s store=%s after=%s",
			input.DryRun, restore, t.chats, total.Round(time.Millisecond), t.authorize.Round(time.Millisecond), t.work.Round(time.Millisecond),
			t.preview.Round(time.Millisecond), t.lock.Round(time.Millisecond), t.store.Round(time.Millisecond), t.after.Round(time.Millisecond))
	}
}

func (s *Server) handleArchiveChats(w http.ResponseWriter, r *http.Request) {
	s.handleArchiveChatsWith(w, r, false)
}
func (s *Server) handleUnarchiveChats(w http.ResponseWriter, r *http.Request) {
	s.handleArchiveChatsWith(w, r, true)
}
func (s *Server) handleArchiveChatsWith(w http.ResponseWriter, r *http.Request, restore bool) {
	var input store.ArchiveChatsInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	input.WorkspaceID = requestedWorkspace(actorFromContext(r.Context()), strings.TrimSpace(input.WorkspaceID))
	// Personal Agent cannot bypass the confirmation policy through REST.
	if _, err := s.paScope(r.Context(), actorFromContext(r.Context())); err == nil {
		writeForbidden(w, "use archive_session so the person's confirmation policy applies")
		return
	}
	result, err := s.archiveChats(r.Context(), actorFromContext(r.Context()), input, restore)
	if errors.Is(err, store.ErrArchiveBlocked) {
		writeJSON(w, http.StatusConflict, result)
		return
	}
	if errors.Is(err, store.ErrChatLayoutConflict) {
		writeError(w, http.StatusConflict, "Archive selection changed; refresh the confirmation")
		return
	}
	writeResult(w, result, err)
}
func (s *Server) handleRetryNativeArchive(w http.ResponseWriter, r *http.Request) {
	ws := requestedWorkspace(actorFromContext(r.Context()), r.URL.Query().Get("workspaceId"))
	if ws == "" {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
		}
		if !decodeJSONRequest(w, r, &body) {
			return
		}
		ws = body.WorkspaceID
	}
	input := store.ArchiveChatsInput{WorkspaceID: ws, ChatIDs: []string{r.PathValue("id")}}
	if _, err := s.authorizeArchive(r.Context(), actorFromContext(r.Context()), input); err != nil {
		writeResult(w, nil, err)
		return
	}
	err := s.store.RetryNativeArchive(r.Context(), ws, r.PathValue("id"))
	if err == nil {
		if workspace, e := s.store.GetWorkspace(r.Context(), ws); e == nil {
			go s.hub.reconcileNativeArchives(workspace.DeviceID)
		}
	}
	writeResult(w, map[string]bool{"ok": err == nil}, err)
}
