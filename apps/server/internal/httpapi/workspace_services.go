package httpapi

import (
	"errors"
	"net/http"
	"slices"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) handleWorkspaceServices(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListWorkspaceServices(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	items = slices.DeleteFunc(items, func(item store.SessionWork) bool { return item.DesiredState == "removed" })
	for i := range items {
		items[i].SharedSessionCount = len(items[i].RelatedSessionIDs)
	}
	writeJSON(w, http.StatusOK, items)
}
func (s *Server) handleWorkspaceServiceControl(w http.ResponseWriter, r *http.Request) {
	var input store.WorkControlInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.IdempotencyKey == "" || len(input.IdempotencyKey) > 160 {
		writeError(w, http.StatusBadRequest, "idempotencyKey required")
		return
	}
	if !slices.Contains([]string{"pause", "resume", "stop", "remove", "link", "unlink"}, input.Action) {
		writeError(w, http.StatusBadRequest, "unsupported service action")
		return
	}
	items, err := s.store.ListWorkspaceServices(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	index := slices.IndexFunc(items, func(item store.SessionWork) bool { return item.ID == r.PathValue("workId") })
	if index < 0 {
		writeError(w, http.StatusNotFound, "service not found")
		return
	}
	service := items[index]
	input.ID = service.ID
	if input.Action == "link" || input.Action == "unlink" {
		related, err := s.store.GetAgentSessionSummary(r.Context(), input.RelatedSessionID)
		if err != nil || related.WorkspaceID != service.WorkspaceID || !s.canReadSession(r.Context(), actorFromContext(r.Context()), related) {
			writeError(w, http.StatusForbidden, "service associations must stay in this workspace")
			return
		}
	}
	s.workMu.Lock()
	defer s.workMu.Unlock()
	op, err := s.store.ControlSessionWork(r.Context(), service.ThreadID, service.SessionID, input)
	if err != nil {
		writeResult(w, nil, &statusError{http.StatusConflict, errors.New(err.Error())})
		return
	}
	s.workAudit(r.Context(), store.AgentSession{ID: service.SessionID, WorkspaceID: service.WorkspaceID}, "Workspace service control requested", op)
	writeJSON(w, http.StatusOK, op)
}
