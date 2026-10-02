package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An Issue's execution asks the person through the ask_person Foundry tool;
// the person answers on the Issue (POST /api/issues/{id}/answer), which
// resumes the Issue in its candidate.

func (s *Server) askPersonForMCP(r *http.Request, actor Actor, args map[string]json.RawMessage) (string, error) {
	executions, ok := s.store.(store.IssueExecutionStore)
	if !actor.Agent() || !ok {
		return "", &mcpToolError{http.StatusForbidden, "only an Issue's execution can ask the person"}
	}
	question := store.IssueQuestion{Text: mcpArgString(args, "question"), Kind: mcpArgString(args, "kind")}
	if question.Kind == "" {
		question.Kind = "input"
	}
	if raw, found := args["options"]; found {
		if err := json.Unmarshal(raw, &question.Options); err != nil {
			return "", &mcpToolError{http.StatusBadRequest, "options must be a list of strings"}
		}
	}
	issue, err := executions.AskIssueQuestion(r.Context(), actor.Identity.SessionID, question)
	if err != nil {
		return "", &mcpToolError{http.StatusConflict, err.Error()}
	}
	s.events.Publish("issue_updated", issue)
	return "Asked. End this turn now with a short summary of where you are; the Issue waits for the person, and Foundry resumes you in this candidate with their answer.", nil
}

func (s *Server) handleAnswerIssueQuestion(w http.ResponseWriter, r *http.Request) {
	var input struct {
		QuestionID string `json:"questionId"`
		Answer     string `json:"answer"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	executions, ok := s.store.(store.IssueExecutionStore)
	if !ok || strings.TrimSpace(input.QuestionID) == "" {
		writeError(w, http.StatusBadRequest, "questionId and answer are required")
		return
	}
	unlock := s.lockIssueMutation(r.PathValue("id"))
	defer unlock()
	issue, err := executions.AnswerIssueQuestion(r.Context(), r.PathValue("id"), input.QuestionID, input.Answer, "")
	if err != nil {
		writeEvidenceMutation(w, nil, err)
		return
	}
	s.events.Publish("issue_updated", issue)
	go s.hub.DispatchReady()
	writeJSON(w, http.StatusOK, issue)
}
