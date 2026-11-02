package issues

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Route is where a person's message went.
type Route string

const (
	// RouteStatus: a question about where the Issue stands, answered.
	RouteStatus Route = "status"
	// RouteAnswer: the answer to the question the Issue waits on.
	RouteAnswer Route = "answer"
	// RouteClarify: a message to its clarification, about its draft.
	RouteClarify Route = "clarify"
	// RouteContinue: feedback; it continues in its candidate.
	RouteContinue Route = "continue"
)

var (
	// ErrClosed: an accepted or abandoned Issue takes no more messages.
	ErrClosed = errors.New("issue_closed: the Issue is closed and takes no more messages")
	// ErrExecuting: the Agent is executing; the person replies once its turn ends.
	ErrExecuting = errors.New("issue_executing: the Agent is executing; reply once this turn ends")
	// ErrMayNotDecide: only the Issue's creator or a workspace maintainer answers its questions.
	ErrMayNotDecide = errors.New("may_not_decide: only the Issue's creator or a workspace maintainer may answer its questions")
)

// Message is a person's message in an Issue's conversation.
type Message struct {
	Text string
	// Key keys a message sent again: it is recorded once.
	Key string
	// Revision and ContentDigest name the draft the person saw; without
	// them, the Issue's current draft.
	Revision      int
	ContentDigest string
	// ChangeReason says why a clarification may revise the draft.
	ChangeReason string
	// ExpectedRunID is the execution the person saw.
	ExpectedRunID string
}

// statusQuestion recognizes a person asking where the Issue stands, in
// either language.
var statusQuestion = regexp.MustCompile(`(?i)^(这里|现在|当前|这个任务|任务)?(是)?什么状态[？?。!！\s]*$|^(现在|目前)?(进度如何|到哪了|在做什么|为什么没开始)[？?。!！\s]*$|^(what(?:'s| is) (?:the |current )?status|status|any update)[?.!\s]*$`)

// Message routes a person's message where it is due: a question about
// where the Issue stands is answered; otherwise it answers the question the
// Issue waits on, clarifies a draft that waits, or continues the Issue in
// its candidate. A closed Issue takes none, an executing one none of these.
// by.Role is the person's role in the Issue's workspace, which answering a
// question needs (MayDecide).
func (s *Service) Message(ctx context.Context, by Actor, issueID string, message Message) (Route, store.Issue, error) {
	if statusQuestion.MatchString(strings.TrimSpace(message.Text)) {
		issue, err := s.AskStatus(ctx, issueID, message.Text, message.Key)
		return RouteStatus, issue, err
	}
	issue, err := s.store.GetIssue(ctx, issueID)
	if err != nil {
		return "", store.Issue{}, err
	}
	switch {
	case issue.Status == "accepted" || issue.Status == "abandoned":
		return "", store.Issue{}, conflict(ErrClosed)
	case issue.Question != nil && issue.Status == "blocked":
		if !MayDecide(issue, by.UserID, by.Role) {
			return "", store.Issue{}, &sessions.Refusal{Status: http.StatusForbidden, Err: ErrMayNotDecide}
		}
		issue, err = s.Answer(ctx, by, issue.ID, issue.Question.ID, message.Text)
		return RouteAnswer, issue, err
	case issue.Status == "in_progress":
		return "", store.Issue{}, conflict(ErrExecuting)
	case issue.ContractState != "confirmed" || issue.DraftContractRevision != nil:
		input := store.AskClarificationInput{IssueID: issue.ID, Revision: message.Revision, ContentDigest: message.ContentDigest, Message: message.Text, ChangeReason: message.ChangeReason}
		if input.ChangeReason == "" {
			// A message that names no reason is recorded as the clarification it adds.
			text := []rune(strings.TrimSpace(message.Text))
			input.ChangeReason = "Clarification: " + string(text[:min(len(text), 1000)])
		}
		if input.Revision == 0 {
			if issue.DraftContractRevision == nil {
				return "", store.Issue{}, conflict(errors.New("the Issue has no draft criteria to clarify"))
			}
			draft, err := s.store.ContractByRevision(ctx, issue.ID, *issue.DraftContractRevision)
			if err != nil {
				return "", store.Issue{}, err
			}
			input.Revision, input.ContentDigest = draft.Revision, draft.ContentDigest
		}
		issue, err = s.Clarify(ctx, by, input, message.Key)
		return RouteClarify, issue, err
	default:
		issue, err = s.Continue(ctx, by, issue.ID, message.Text, message.ExpectedRunID)
		return RouteContinue, issue, err
	}
}
