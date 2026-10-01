package httpapi

import (
	"log"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) handleIssueStatusQuestion(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Message string `json:"message"`
	}
	if !decodeEvidenceRequest(w, r, "", &input) {
		return
	}
	st, ok := s.evidenceStore(w)
	if !ok {
		return
	}
	unlock := s.lockIssueMutation(r.PathValue("id"))
	defer unlock()
	issue, err := st.RecordIssueStatusQuestion(r.Context(), r.PathValue("id"), input.Message, r.Header.Get("Idempotency-Key"))
	if err == nil {
		s.events.Publish("issue_updated", issue)
	}
	writeEvidenceMutation(w, issue, err)
}

// handleEvidenceClarification sends the person's message about a draft to the
// Issue's clarification session. It answers once the message is recorded and
// queued; the Agent's reply arrives with issue_updated.
func (s *Server) handleEvidenceClarification(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ExpectedRevision      int    `json:"expectedRevision"`
		ExpectedContentDigest string `json:"expectedContentDigest"`
		Message               string `json:"message"`
		ChangeReason          string `json:"changeReason"`
	}
	if !decodeEvidenceRequest(w, r, "", &input) {
		return
	}
	if strings.TrimSpace(input.Message) == "" || len(input.Message) > 16000 || strings.TrimSpace(input.ChangeReason) == "" {
		writeError(w, 400, "clarification message and revision reason required")
		return
	}
	s.clarify(w, r, func(st store.EvidenceStore) (store.Issue, store.AgentSession, error) {
		return st.AskClarification(r.Context(), store.AskClarificationInput{
			IssueID: r.PathValue("id"), Revision: input.ExpectedRevision, ContentDigest: input.ExpectedContentDigest,
			Message: input.Message, ChangeReason: input.ChangeReason,
		}, humanActor(r), r.Header.Get("Idempotency-Key"))
	})
}

// handleRetryClarification sends the person's latest message to the
// clarification session again after it failed to answer.
func (s *Server) handleRetryClarification(w http.ResponseWriter, r *http.Request) {
	s.clarify(w, r, func(st store.EvidenceStore) (store.Issue, store.AgentSession, error) {
		return st.RetryClarification(r.Context(), r.PathValue("id"), humanActor(r), r.Header.Get("Idempotency-Key"))
	})
}

func (s *Server) clarify(w http.ResponseWriter, r *http.Request, queue func(store.EvidenceStore) (store.Issue, store.AgentSession, error)) {
	st, ok := s.evidenceStore(w)
	if !ok {
		return
	}
	issue, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	// The workspace's device answers; an older worker would run the session
	// as an ordinary chat with write access, so it is refused here.
	workspace, err := s.store.GetWorkspace(r.Context(), issue.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	connection := s.hub.connectionFor(workspace.DeviceID)
	if connection == nil {
		writeError(w, http.StatusConflict, "worker_offline: the workspace's device is not connected")
		return
	}
	if !connection.hasCapability(store.DaemonCapabilityIssueClarification) {
		writeError(w, http.StatusConflict, errIssueClarificationUnsupported.Error())
		return
	}
	unlock := s.lockIssueMutation(issue.ID)
	defer unlock()
	updated, session, err := queue(st)
	if err != nil {
		writeEvidenceMutation(w, nil, err)
		return
	}
	s.events.Publish("issue_updated", updated)
	// A replayed request may find its input already sent or answered.
	current, err := s.store.GetAgentSessionSummary(r.Context(), session.ID)
	if err == nil && current.Status == "queued" && current.Input.ID == session.Input.ID {
		if err := s.hub.DispatchAgentSession(current); err != nil {
			log.Printf("dispatch clarification session %s: %v", session.ID, err)
		}
	}
	writeJSON(w, http.StatusOK, updated)
}
