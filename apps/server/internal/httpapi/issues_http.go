package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/issues"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An Issue's routes: each decodes the request, asks the Issue service
// (internal/issues) and answers with what it did. Who may ask is the route's
// rule (routes.go).

// issueActor is the person a request acts for, on the web.
func issueActor(r *http.Request) issues.Actor {
	return issues.Actor{ActorRef: humanActor(r), UserID: actorFromContext(r.Context()).AccountID()}
}

func (s *Server) handleListIssues(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListIssues(r.Context(), r.URL.Query().Get("workspaceId"))
	writeResult(w, items, err)
}

func (s *Server) handleGetIssue(w http.ResponseWriter, r *http.Request) {
	item, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	writeResult(w, item, err)
}

func (s *Server) handleCreateIssue(w http.ResponseWriter, r *http.Request) {
	var request struct {
		store.CreateIssueInput
		// InitializeGit: the person confirmed setting up Git in a workspace
		// that has none, or no commits yet (issues.NeedsGit).
		InitializeGit bool `json:"initializeGit,omitempty"`
	}
	if !decodeEvidenceRequest(w, r, "", &request) {
		return
	}
	input := request.CreateIssueInput
	input.WorkspaceID = requestedWorkspace(actorFromContext(r.Context()), input.WorkspaceID)
	if !s.requireWorkspace(w, r, strings.TrimSpace(input.WorkspaceID), store.WorkspaceRoleMember) {
		return
	}
	// A first clarification that did not start leaves the Issue waiting for
	// the person's next message.
	created, err := s.issueService.Create(r.Context(), issueActor(r), input,
		issues.CreateOptions{RequestID: r.Header.Get("Idempotency-Key"), InitializeGit: request.InitializeGit})
	var needsGit *issues.NeedsGit
	if errors.As(err, &needsGit) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error(), "code": workspaceNeedsGitCode, "path": needsGit.Path})
		return
	}
	writeResultWithStatus(w, http.StatusCreated, created.Issue, err)
}

func (s *Server) handleRequestChanges(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Message       string `json:"message"`
		ExpectedRunID string `json:"expectedRunId"`
	}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, "Invalid feedback", http.StatusBadRequest)
			return
		}
	}
	issue, err := s.issueService.Continue(r.Context(), issueActor(r), r.PathValue("id"), input.Message, input.ExpectedRunID)
	writeResult(w, issue, err)
}

func (s *Server) handleAbandonIssue(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ExpectedRunID string `json:"expectedRunId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		http.Error(w, "Invalid abandonment request", http.StatusBadRequest)
		return
	}
	issue, err := s.issueService.Abandon(r.Context(), issueActor(r), r.PathValue("id"), input.ExpectedRunID)
	writeResult(w, issue, err)
}

// handleAnswerIssueQuestion answers the question the Issue's execution asked
// (ask_person); the Issue continues in its candidate.
func (s *Server) handleAnswerIssueQuestion(w http.ResponseWriter, r *http.Request) {
	var input struct {
		QuestionID string `json:"questionId"`
		Answer     string `json:"answer"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.QuestionID) == "" {
		writeError(w, http.StatusBadRequest, "questionId and answer are required")
		return
	}
	issue, err := s.issueService.Answer(r.Context(), issueActor(r), r.PathValue("id"), input.QuestionID, input.Answer)
	writeResult(w, issue, err)
}

// handleIssueMessage hands a person's message in the Issue's conversation
// to the Issue, wherever it is due (issues.Service.Message): its status, the
// answer to its question, its clarification or its next execution.
func (s *Server) handleIssueMessage(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Text string `json:"text"`
		// The draft the person saw, for a clarification, and why it may
		// change; the execution they saw, for feedback.
		ExpectedRevision      int    `json:"expectedRevision,omitempty"`
		ExpectedContentDigest string `json:"expectedContentDigest,omitempty"`
		ChangeReason          string `json:"changeReason,omitempty"`
		ExpectedRunID         string `json:"expectedRunId,omitempty"`
	}
	if !decodeEvidenceRequest(w, r, "", &input) {
		return
	}
	issue, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	scope, err := s.requestScope(r)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	by := issueActor(r)
	by.Role = scope.role(issue.WorkspaceID)
	route, issue, err := s.issueService.Message(r.Context(), by, issue.ID, issues.Message{
		Text: input.Text, Key: r.Header.Get("Idempotency-Key"),
		Revision: input.ExpectedRevision, ContentDigest: input.ExpectedContentDigest, ChangeReason: input.ChangeReason,
		ExpectedRunID: input.ExpectedRunID,
	})
	writeResult(w, map[string]any{"route": route, "issue": issue}, err)
}

// handleRetryClarification sends the person's latest message to the
// clarification session again after it failed to answer.
func (s *Server) handleRetryClarification(w http.ResponseWriter, r *http.Request) {
	issue, err := s.issueService.RetryClarification(r.Context(), issueActor(r), r.PathValue("id"), r.Header.Get("Idempotency-Key"))
	writeResult(w, issue, err)
}

func (s *Server) handleContracts(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		items, err := s.store.ListEvidenceRecords(r.Context(), r.PathValue("id"), "contract")
		writeEvidencePage(w, r, items, err)
		return
	}
	var input store.ContractDraftInput
	if !decodeEvidenceRequest(w, r, "ContractDraftInput", &input) {
		return
	}
	contract, err := s.issueService.SaveDraft(r.Context(), issueActor(r), r.PathValue("id"), input, r.Header.Get("Idempotency-Key"))
	writeResult(w, contract, err)
}

func (s *Server) handleContractAction(w http.ResponseWriter, r *http.Request) {
	revision, err := strconv.Atoi(r.PathValue("revision"))
	if err != nil || revision < 1 {
		writeError(w, http.StatusBadRequest, "invalid revision")
		return
	}
	var input struct {
		ExpectedContentDigest string `json:"expectedContentDigest"`
		Reason                string `json:"reason"`
	}
	if !decodeEvidenceRequest(w, r, "", &input) {
		return
	}
	var contract store.IssueContract
	switch r.PathValue("action") {
	case "confirm":
		contract, err = s.issueService.Confirm(r.Context(), issueActor(r), r.PathValue("id"), revision, input.ExpectedContentDigest, r.Header.Get("Idempotency-Key"))
	case "discard":
		contract, err = s.issueService.Discard(r.Context(), issueActor(r), r.PathValue("id"), revision, input.Reason, r.Header.Get("Idempotency-Key"))
	default:
		writeError(w, http.StatusNotFound, "unknown contract action")
		return
	}
	writeResult(w, contract, err)
}
