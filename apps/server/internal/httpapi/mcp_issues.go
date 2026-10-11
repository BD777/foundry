package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
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
	return &mcpToolError{http.StatusNotFound, "no Issue " + id + " that you can read (list_issues lists them)"}
}

// readableIssue is the Issue the caller names, by id or short id. One it
// cannot read answers like a missing one.
func (s *Server) readableIssue(ctx context.Context, actor Actor, raw string) (store.Issue, error) {
	id := strings.TrimSpace(raw)
	if id == "" {
		return store.Issue{}, &mcpToolError{http.StatusBadRequest, "issueId is required: an Issue id (iss_…) or short id"}
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
		WorkspaceID: issue.WorkspaceID, Priority: issue.Priority, Request: excerpt(issue.SourceInput, issueRequestLimit),
		ContractState: issue.ContractState, Question: issue.Question, Updated: issue.UpdatedLabel,
	}
	if issue.Clarification != nil {
		view.Clarification = &mcpIssueClarification{issue.Clarification.SessionID, issue.Clarification.Status, issue.Clarification.Error}
	}
	if run := issue.Run; run != nil {
		view.Run = &mcpIssueRun{SessionID: run.ID, Status: run.Status, Error: run.Error, StartedAt: run.StartedAt, CompletedAt: run.CompletedAt}
	}
	if evidence, ok := s.store.(store.EvidenceStore); ok {
		if view.Contract, err = issueContractView(ctx, evidence, issue); err != nil {
			return "", err
		}
		view.Verification = issueVerificationView(ctx, evidence, issue)
	}
	if draft := issue.DraftContractRevision; draft != nil && (view.Contract == nil || *draft != view.Contract.Revision) {
		view.DraftRevision = draft
	}
	encoded, err := json.MarshalIndent(view, "", "  ")
	return string(encoded), err
}

// issueContractView is the confirmed contract, or the draft while none is
// confirmed, with each criterion's latest verification on that revision.
func issueContractView(ctx context.Context, evidence store.EvidenceStore, issue store.Issue) (*mcpIssueContract, error) {
	revision := issue.CurrentContractRevision
	if revision == nil {
		revision = issue.DraftContractRevision
	}
	if revision == nil {
		return nil, nil
	}
	contracts, err := evidenceRecords[store.IssueContract](ctx, evidence, issue.ID, "contract")
	if err != nil {
		return nil, err
	}
	var contract *store.IssueContract
	for index := range contracts {
		if contracts[index].Revision == *revision {
			contract = &contracts[index]
		}
	}
	if contract == nil {
		return nil, nil
	}
	verifications, err := evidenceRecords[store.Verification](ctx, evidence, issue.ID, "verification")
	if err != nil {
		return nil, err
	}
	latest := map[string]store.Verification{}
	for _, verification := range verifications {
		if verification.ContractRevision != contract.Revision {
			continue
		}
		if known, ok := latest[verification.CriterionID]; !ok || verification.Sequence > known.Sequence {
			latest[verification.CriterionID] = verification
		}
	}
	view := &mcpIssueContract{
		Revision: contract.Revision, Status: contract.Status, Goal: excerpt(contract.Goal.Text, issueGoalLimit),
		InScope: contract.InScope, OutOfScope: contract.OutOfScope, Constraints: contract.Constraints,
		Criteria: []mcpIssueCriterion{},
	}
	for _, criterion := range contract.Criteria {
		item := mcpIssueCriterion{
			ID: criterion.ID, Title: criterion.Title, Statement: excerpt(criterion.Statement, issueStatementLimit),
			Required: criterion.Required, Mode: criterion.EvaluationMode,
		}
		if verification, ok := latest[criterion.ID]; ok {
			item.Verdict = verification.Status
			if verification.Result != nil {
				item.Verdict = verification.Result.Verdict
				item.Summary = excerpt(verification.Result.Summary, issueStatementLimit)
			} else if verification.Error != nil {
				item.Summary = excerpt(verification.Error.Message, issueStatementLimit)
			}
		}
		view.Criteria = append(view.Criteria, item)
	}
	return view, nil
}

// issueVerificationView is the Issue's verification counts with what its
// latest review says about accepting it. A review that cannot be read
// leaves the counts.
func issueVerificationView(ctx context.Context, evidence store.EvidenceStore, issue store.Issue) *mcpIssueVerification {
	if issue.VerificationSummary == nil && issue.CurrentReviewSnapshotID == nil {
		return nil
	}
	view := &mcpIssueVerification{VerificationSummary: issue.VerificationSummary}
	if issue.CurrentReviewSnapshotID == nil {
		return view
	}
	raw, err := evidence.GetEvidenceRecord(ctx, issue.ID, "review", *issue.CurrentReviewSnapshotID)
	var review store.ReviewSnapshot
	if err != nil || json.Unmarshal(raw, &review) != nil {
		return view
	}
	view.ReviewEligible = &review.Eligible
	for _, blocker := range review.BlockingReasons {
		view.Blockers = append(view.Blockers, oneLine(blocker.Message, issueStatementLimit))
	}
	return view
}

func evidenceRecords[T any](ctx context.Context, evidence store.EvidenceStore, issueID, kind string) ([]T, error) {
	raws, err := evidence.ListEvidenceRecords(ctx, issueID, kind)
	if err != nil {
		return nil, err
	}
	records := make([]T, 0, len(raws))
	for _, raw := range raws {
		var record T
		if json.Unmarshal(raw, &record) == nil {
			records = append(records, record)
		}
	}
	return records, nil
}
