package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) archiveStore() (store.ChatArchiveStore, error) {
	st, ok := s.store.(store.ChatArchiveStore)
	if !ok {
		return nil, errors.New("archive storage unavailable")
	}
	return st, nil
}
func (s *Server) authorizeArchive(ctx context.Context, actor Actor, input store.ArchiveChatsInput) ([]string, error) {
	st, err := s.archiveStore()
	if err != nil {
		return nil, err
	}
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return nil, err
	}
	if !scope.can(input.WorkspaceID, store.WorkspaceRoleMember) {
		return nil, &statusError{http.StatusNotFound, store.ErrNotFound}
	}
	ids, err := st.ArchiveChatIDs(ctx, input)
	if err != nil {
		return nil, err
	}
	if actor.Agent() {
		for _, id := range ids {
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
	ids, err := s.authorizeArchive(ctx, actor, input)
	if err != nil {
		return empty, err
	}
	// Import retained timer and native-work snapshots before preflight so work
	// that has not been opened in the work panel is included too.
	for _, id := range ids {
		session, e := s.store.GetAgentSessionSummary(ctx, id)
		if e == nil {
			if _, e = s.sessionWorkList(ctx, session); e != nil {
				return empty, e
			}
		}
	}
	var hidden []store.ArchiveHiddenChat
	if input.DryRun && !restore {
		hidden, err = s.previewNativeArchives(ctx, actor, input.WorkspaceID, ids)
		if err != nil {
			return empty, err
		}
	}
	// Serialize with scheduled dispatch so an already admitted timer cannot
	// create a new child after the archive transaction commits.
	s.workMu.Lock()
	defer s.workMu.Unlock()
	input.ArchivedByUser = actor.AccountID()
	if actor.Agent() {
		input.ArchivedBySession = actor.Identity.SessionID
	}
	st, _ := s.archiveStore()
	result, err := st.ArchiveChats(ctx, input, restore)
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
	st, err := s.archiveStore()
	if err == nil {
		err = st.RetryNativeArchive(r.Context(), ws, r.PathValue("id"))
	}
	if err == nil {
		if workspace, e := s.store.GetWorkspace(r.Context(), ws); e == nil {
			go s.hub.reconcileNativeArchives(workspace.DeviceID)
		}
	}
	writeResult(w, map[string]bool{"ok": err == nil}, err)
}
