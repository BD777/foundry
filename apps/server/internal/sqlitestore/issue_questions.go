package sqlitestore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An Issue's execution may need a decision or a permission only the person
// can give. It asks (AskIssueQuestion), ends its turn, and the Issue blocks
// on the question; the person's answer resumes the same candidate.

var (
	errQuestionNotFromExecution = errors.New("only the Issue's running execution can ask the person; tell the session that started you what you need")
	errQuestionAlreadyAsked     = errors.New("a question is already waiting for the person; end this turn and wait for the answer")
	errQuestionGone             = errors.New("question_not_open: this question is no longer waiting for an answer")
)

func (s *Store) AskIssueQuestion(ctx context.Context, sessionID string, question store.IssueQuestion) (store.Issue, error) {
	var result store.Issue
	question.Text = strings.TrimSpace(question.Text)
	if question.Text == "" || len(question.Text) > 4000 || len(question.Options) > 6 {
		return result, fmt.Errorf("a question needs text of at most 4000 bytes and at most 6 options")
	}
	if question.Kind != "input" && question.Kind != "permission" {
		return result, fmt.Errorf("question kind must be input or permission")
	}
	err := s.withTx(ctx, func(tx *Store) error {
		session, err := tx.GetAgentSessionSummary(ctx, sessionID)
		if err != nil {
			return err
		}
		if session.Role != store.AgentSessionRoleIssueExecution || session.Status != "running" {
			return errQuestionNotFromExecution
		}
		issue, err := tx.GetIssue(ctx, session.IssueID)
		if err != nil {
			return err
		}
		if issue.Run == nil || issue.Run.ID != session.ID || issue.Status != "in_progress" {
			return errQuestionNotFromExecution
		}
		if issue.Question != nil && issue.Question.RunID == session.ID {
			if issue.Question.Text == question.Text {
				result = issue
				return nil
			}
			return errQuestionAlreadyAsked
		}
		now := time.Now().UTC()
		question.ID = evidenceID("question")
		question.RunID, question.AskedAt = session.ID, now.Format(time.RFC3339)
		issue.Question = &question
		issue.Messages = append(issue.Messages, store.IssueConversationMessage{ID: question.ID, Role: "assistant", Text: question.Text, RunID: session.ID, CreatedAt: question.AskedAt})
		if err := tx.saveIssue(ctx, issue, time.Time{}, now); err != nil {
			return err
		}
		result = issue
		return nil
	})
	return result, err
}

func (s *Store) AnswerIssueQuestion(ctx context.Context, issueID string, questionID string, answer string, via string) (store.Issue, error) {
	var result store.Issue
	answer = strings.TrimSpace(answer)
	if answer == "" || len(answer) > 32000 {
		return result, fmt.Errorf("an answer needs text of at most 32000 bytes")
	}
	err := s.withTx(ctx, func(tx *Store) error {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return err
		}
		if issue.Question == nil || issue.Question.ID != questionID {
			// A resent answer finds its question already answered.
			for _, message := range issue.Messages {
				if message.ID == questionID+"_answer" {
					result = issue
					return nil
				}
			}
			return errQuestionGone
		}
		if issue.Status != "blocked" {
			return fmt.Errorf("question_not_ready: the execution is still finishing its turn")
		}
		if err := tx.assertWorkspaceDeviceNotRemoved(ctx, issue.WorkspaceID); err != nil {
			return err
		}
		issue.Question = nil
		issue.Messages = append(issue.Messages, store.IssueConversationMessage{ID: questionID + "_answer", Role: "user", Text: answer, CreatedAt: time.Now().UTC().Format(time.RFC3339), Via: via})
		result, err = tx.continueIssue(ctx, issue, "", "")
		return err
	})
	return result, err
}
