package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/issues"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// Issues as the Foundry tools read them: where an Issue stands, the contract
// it works to, the question it waits on, how its criteria verified and its
// latest run, in the workspaces the caller reaches. A session working in an
// Issue sees only that Issue. Nothing here changes an Issue; the person
// drives it in Foundry.

const (
	issueGoalLimit      = 2000
	issueStatementLimit = 400
	issueRequestLimit   = 600
)

// mcpIssueItem is one Issue in a list: what tells Issues apart and how far
// each has come. get_issue reads the rest.
type mcpIssueItem struct {
	ID       string `json:"id"`
	ShortID  string `json:"shortId"`
	Title    string `json:"title"`
	Status   string `json:"status"`
	Contract string `json:"contract,omitempty"`
	Run      string `json:"run,omitempty"`
	Question string `json:"question,omitempty"`
	Verified string `json:"verified,omitempty"`
	Updated  string `json:"updated,omitempty"`
}

func (s *Server) listIssuesForMCP(ctx context.Context, actor Actor, workspace string, statuses []string) (string, error) {
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return "", err
	}
	issues, err := s.store.ListIssues(ctx, workspace)
	if err != nil {
		return "", err
	}
	items := []mcpIssueItem{}
	for _, issue := range issues {
		if scope.issueID != "" && issue.ID != scope.issueID {
			continue
		}
		if len(statuses) > 0 && !slices.Contains(statuses, issue.Status) {
			continue
		}
		item := mcpIssueItem{
			ID: issue.ID, ShortID: issue.ShortID, Title: issue.Title, Status: issue.Status,
			Contract: contractLabel(issue), Verified: verifiedLabel(issue.VerificationSummary), Updated: issue.UpdatedLabel,
		}
		if issue.Run != nil {
			item.Run = issue.Run.Status
		}
		if issue.Question != nil {
			item.Question = issue.Question.Kind
		}
		items = append(items, item)
	}
	return "{\n  \"issues\": " + encodeLines(items) + "\n}", nil
}

// contractLabel is the contract's state with the revision it names: the
// confirmed one, and a newer draft waiting for confirmation.
func contractLabel(issue store.Issue) string {
	label := issue.ContractState
	if issue.CurrentContractRevision != nil {
		label += fmt.Sprintf(" r%d", *issue.CurrentContractRevision)
	}
	if draft := issue.DraftContractRevision; draft != nil && (issue.CurrentContractRevision == nil || *draft != *issue.CurrentContractRevision) {
		label += fmt.Sprintf(" (draft r%d)", *draft)
	}
	return label
}

func verifiedLabel(summary *store.VerificationSummary) string {
	if summary == nil || summary.RequiredTotal == 0 {
		return ""
	}
	label := fmt.Sprintf("%d/%d passed", summary.Passed, summary.RequiredTotal)
	for _, count := range []struct {
		n    int
		name string
	}{{summary.Failed, "failed"}, {summary.Inconclusive, "inconclusive"}, {summary.Pending, "pending"}, {summary.Stale, "stale"}} {
		if count.n > 0 {
			label += fmt.Sprintf(", %d %s", count.n, count.name)
		}
	}
	return label
}

// mcpIssueView is one Issue as an agent reads it.
type mcpIssueView struct {
	ID            string                    `json:"id"`
	ShortID       string                    `json:"shortId"`
	Title         string                    `json:"title"`
	Status        string                    `json:"status"`
	Blocked       *store.IssueBlockedReason `json:"blocked,omitempty"`
	WorkspaceID   string                    `json:"workspaceId"`
	Priority      string                    `json:"priority,omitempty"`
	Request       string                    `json:"request"`
	ContractState string                    `json:"contractState"`
	Contract      *mcpIssueContract         `json:"contract,omitempty"`
	// DraftRevision is a newer draft of the contract waiting for the
	// person to confirm it.
	DraftRevision *int                   `json:"draftRevision,omitempty"`
	Question      *store.IssueQuestion   `json:"question,omitempty"`
	Clarification *mcpIssueClarification `json:"clarification,omitempty"`
	Verification  *mcpIssueVerification  `json:"verification,omitempty"`
	Run           *mcpIssueRun           `json:"run,omitempty"`
	Updated       string                 `json:"updated,omitempty"`
}

type mcpIssueContract struct {
	Revision    int                 `json:"revision"`
	Status      string              `json:"status"`
	Goal        string              `json:"goal"`
	InScope     []string            `json:"inScope,omitempty"`
	OutOfScope  []string            `json:"outOfScope,omitempty"`
	Constraints []string            `json:"constraints,omitempty"`
	Criteria    []mcpIssueCriterion `json:"criteria"`
}

type mcpIssueCriterion struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Statement string `json:"statement"`
	Required  bool   `json:"required"`
	// Mode is how it verifies: by a program or by an independent agent.
	Mode string `json:"mode"`
	// Verdict is its latest verification's, on this revision; Verifying
	// when one runs.
	Verdict string `json:"verdict,omitempty"`
	Summary string `json:"summary,omitempty"`
}

type mcpIssueClarification struct {
	SessionID string `json:"sessionId"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
}

type mcpIssueVerification struct {
	*store.VerificationSummary
	// ReviewEligible: the latest review allows the person to accept.
	ReviewEligible *bool    `json:"reviewEligible,omitempty"`
	Blockers       []string `json:"blockers,omitempty"`
}

type mcpIssueRun struct {
	// SessionID is the execution session, which read_context reads.
	SessionID   string `json:"sessionId"`
	Status      string `json:"status"`
	Error       string `json:"error,omitempty"`
	StartedAt   string `json:"startedAt,omitempty"`
	CompletedAt string `json:"completedAt,omitempty"`
}

func issueNotFound(id string) error {
	return &statusError{http.StatusNotFound, errors.New("no Issue " + id + " that you can read (list_issues lists them)")}
}

// readableIssue is the Issue the caller names, by id or short id. One it
// cannot read answers like a missing one.
func (s *Server) readableIssue(ctx context.Context, actor Actor, raw string) (store.Issue, error) {
	id := strings.TrimSpace(raw)
	if id == "" {
		return store.Issue{}, &statusError{http.StatusBadRequest, errors.New("issueId is required: an Issue id (iss_…) or short id")}
	}
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return store.Issue{}, err
	}
	issue, err := s.store.GetIssue(ctx, id)
	if errors.Is(err, store.ErrNotFound) ||
		(err == nil && (!scope.can(issue.WorkspaceID, store.WorkspaceRoleViewer) || (scope.issueID != "" && issue.ID != scope.issueID))) {
		return store.Issue{}, issueNotFound(id)
	}
	return issue, err
}

func (s *Server) issueForMCP(ctx context.Context, actor Actor, raw string) (string, error) {
	issue, err := s.readableIssue(ctx, actor, raw)
	if err != nil {
		return "", err
	}
	view := mcpIssueView{
		ID: issue.ID, ShortID: issue.ShortID, Title: issue.Title, Status: issue.Status, Blocked: issue.BlockedReason,
		WorkspaceID: issue.WorkspaceID, Priority: issue.Priority, Request: textcut.Excerpt(issue.SourceInput, issueRequestLimit),
		ContractState: issue.ContractState, Question: issue.Question, Updated: issue.UpdatedLabel,
	}
	if issue.Clarification != nil {
		view.Clarification = &mcpIssueClarification{issue.Clarification.SessionID, issue.Clarification.Status, issue.Clarification.Error}
	}
	if run := issue.Run; run != nil {
		view.Run = &mcpIssueRun{SessionID: run.ID, Status: run.Status, Error: run.Error, StartedAt: run.StartedAt, CompletedAt: run.CompletedAt}
	}
	summary, err := s.issueService.Summary(ctx, issue)
	if err != nil {
		return "", err
	}
	view.Contract = issueContractView(summary)
	view.Verification = issueVerificationView(issue, summary.Review)
	if draft := issue.DraftContractRevision; draft != nil && (view.Contract == nil || *draft != view.Contract.Revision) {
		view.DraftRevision = draft
	}
	encoded, err := json.MarshalIndent(view, "", "  ")
	return string(encoded), err
}

// issueContractView is the contract the Issue works to, with each
// criterion's latest verification on its revision.
func issueContractView(summary issues.Summary) *mcpIssueContract {
	contract := summary.Contract
	if contract == nil {
		return nil
	}
	view := &mcpIssueContract{
		Revision: contract.Revision, Status: contract.Status, Goal: textcut.Excerpt(contract.Goal.Text, issueGoalLimit),
		InScope: contract.InScope, OutOfScope: contract.OutOfScope, Constraints: contract.Constraints,
		Criteria: []mcpIssueCriterion{},
	}
	for _, criterion := range contract.Criteria {
		item := mcpIssueCriterion{
			ID: criterion.ID, Title: criterion.Title, Statement: textcut.Excerpt(criterion.Statement, issueStatementLimit),
			Required: criterion.Required, Mode: criterion.EvaluationMode,
		}
		if verification, ok := summary.Verdicts[criterion.ID]; ok {
			item.Verdict = verification.Status
			if verification.Result != nil {
				item.Verdict = verification.Result.Verdict
				item.Summary = textcut.Excerpt(verification.Result.Summary, issueStatementLimit)
			} else if verification.Error != nil {
				item.Summary = textcut.Excerpt(verification.Error.Message, issueStatementLimit)
			}
		}
		view.Criteria = append(view.Criteria, item)
	}
	return view
}

// issueVerificationView is the Issue's verification counts with what its
// latest review says about accepting it (review, when it reads).
func issueVerificationView(issue store.Issue, review *store.ReviewSnapshot) *mcpIssueVerification {
	if issue.VerificationSummary == nil && issue.CurrentReviewSnapshotID == nil {
		return nil
	}
	view := &mcpIssueVerification{VerificationSummary: issue.VerificationSummary}
	if review == nil {
		return view
	}
	view.ReviewEligible = &review.Eligible
	for _, blocker := range review.BlockingReasons {
		view.Blockers = append(view.Blockers, oneLine(blocker.Message, issueStatementLimit))
	}
	return view
}

// askPersonForMCP records the question an Issue's execution asks the person
// (ask_person); the person answers on the Issue (POST
// /api/issues/{id}/answer), which resumes it in its candidate.
func (s *Server) askPersonForMCP(r *http.Request, actor Actor, args map[string]json.RawMessage) (string, error) {
	if !actor.Agent() {
		return "", &statusError{http.StatusForbidden, errors.New("only an Issue's execution can ask the person")}
	}
	question := store.IssueQuestion{Text: mcpArgString(args, "question"), Kind: mcpArgString(args, "kind")}
	if question.Kind == "" {
		question.Kind = "input"
	}
	if raw, found := args["options"]; found {
		if err := json.Unmarshal(raw, &question.Options); err != nil {
			return "", &statusError{http.StatusBadRequest, errors.New("options must be a list of strings")}
		}
	}
	if _, err := s.issueService.Ask(r.Context(), actor.Identity.SessionID, question); err != nil {
		return "", err
	}
	return "Asked. The Issue waits for the person's answer, which resumes this execution in the same candidate once this turn has ended.", nil
}
