package sqlitestore

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) ListIssues(ctx context.Context, workspaceID string) ([]store.Issue, error) {
	if workspaceID = strings.TrimSpace(workspaceID); workspaceID != "" {
		return listJSON[store.Issue](ctx, s.reader(), `SELECT payload_json FROM issues WHERE workspace_id = ? ORDER BY updated_at DESC`, workspaceID)
	}
	return listJSON[store.Issue](ctx, s.reader(), `SELECT payload_json FROM issues ORDER BY updated_at DESC`)
}

func (s *Store) GetIssue(ctx context.Context, id string) (store.Issue, error) {
	return getJSON[store.Issue](ctx, s.conn(), `SELECT payload_json FROM issues WHERE id = ? OR short_id = ?`, id, id)
}

func (s *Store) CreateIssue(ctx context.Context, input store.CreateIssueInput) (store.Issue, error) {
	var issue store.Issue
	err := s.withTx(ctx, func(tx *Store) error {
		created, err := tx.createIssue(ctx, input)
		if err != nil {
			return err
		}
		issue = created
		return nil
	})
	if err != nil {
		return store.Issue{}, err
	}
	return issue, nil
}

func (s *Store) createIssue(ctx context.Context, input store.CreateIssueInput) (store.Issue, error) {
	if err := input.ValidateRuntimeOptions(); err != nil {
		return store.Issue{}, err
	}
	now := time.Now().UTC()
	sequence, err := s.nextIssueSequence(ctx)
	if err != nil {
		return store.Issue{}, err
	}

	sourceInput := strings.TrimSpace(input.SourceInput)
	if sourceInput == "" {
		sourceInput = strings.TrimSpace(input.Title)
	}
	if sourceInput == "" {
		sourceInput = "Untitled Foundry issue"
	}

	title := strings.TrimSpace(input.Title)
	if title == "" {
		title = titleFromInput(sourceInput)
	}

	runtime := strings.TrimSpace(input.Runtime)
	if runtime == "" {
		runtime = "mock"
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	// Defense in depth (the UI can no longer select this device's workspaces):
	// no new issues can be created for a soft-removed device. Runs in the same
	// tx gate again when execution actually starts.
	if err := s.assertWorkspaceDeviceNotRemoved(ctx, workspaceID); err != nil {
		return store.Issue{}, err
	}

	issue := store.Issue{
		CreatedByUserID:      input.CreatedByUserID,
		CodexSpeed:           input.CodexSpeed,
		Model:                strings.TrimSpace(input.Model),
		ProfileID:            strings.TrimSpace(input.ProfileID),
		ClaudeEffort:         input.ClaudeEffort,
		CodexReasoningEffort: input.CodexReasoningEffort,
		ID:                   fmt.Sprintf("iss_%d", sequence),
		WorkspaceID:          workspaceID,
		ShortID:              fmt.Sprintf("ISS-%d", sequence),
		Title:                title,
		Status:               "pending",
		Priority:             "medium",
		SourceInput:          sourceInput,
		InferredTask:         "",
		Runtime:              runtime,
		Skills:               []store.SkillPackRef{},
		AcceptanceCriteria:   []string{},
		Checks:               []string{},
		UpdatedLabel:         "just now",
	}

	if err := s.createInitialContract(ctx, &issue); err != nil {
		return store.Issue{}, err
	}
	if err := s.saveIssue(ctx, issue, now, now); err != nil {
		return store.Issue{}, err
	}
	return issue, nil
}

func (s *Store) RequestIssueChanges(ctx context.Context, id string, message string, expectedRunID string, via string) (store.Issue, error) {
	var result store.Issue
	err := s.withTx(ctx, func(tx *Store) error {
		issue, err := tx.GetIssue(ctx, id)
		if err != nil {
			return err
		}
		if issue.Status == "in_progress" || issue.Status == "accepted" || issue.Status == "abandoned" {
			return fmt.Errorf("issue cannot continue in its current state")
		}
		if err := tx.assertWorkspaceDeviceNotRemoved(ctx, issue.WorkspaceID); err != nil {
			return err
		}
		if expectedRunID != "" && (issue.Run == nil || issue.Run.ID != expectedRunID) {
			return fmt.Errorf("issue run changed; refresh before continuing")
		}
		message = strings.TrimSpace(message)
		if len(message) > 32000 {
			return fmt.Errorf("feedback exceeds 32000 bytes")
		}
		// Repeated submission while already queued does not append duplicate turns.
		if issue.Status == "pending" && issue.ContractState == "confirmed" {
			if message != "" && (len(issue.Messages) == 0 || issue.Messages[len(issue.Messages)-1].Role != "user" || issue.Messages[len(issue.Messages)-1].Text != message) {
				return fmt.Errorf("issue is already queued; wait for this run before adding another follow-up")
			}
			result = issue
			return nil
		}
		result, err = tx.continueIssue(ctx, issue, message, via)
		return err
	})
	return result, err
}

// continueIssue queues the Issue to continue in its candidate with the
// person's message, which the next execution reads as feedback.
func (s *Store) continueIssue(ctx context.Context, issue store.Issue, message, via string) (store.Issue, error) {
	if message != "" {
		issue.Messages = append(issue.Messages, store.IssueConversationMessage{ID: fmt.Sprintf("msg_%s_%d", issue.ID, len(issue.Messages)+1), Role: "user", Text: message, CreatedAt: time.Now().UTC().Format(time.RFC3339), Via: via})
	}
	if err := issue.Apply(store.IssueEventContinued, nil); err != nil {
		return store.Issue{}, err
	}
	issue.Checks = appendUnique(issue.Checks, "Changes requested")
	issue.UpdatedLabel = "just now"
	if err := s.saveIssue(ctx, issue, time.Time{}, time.Now().UTC()); err != nil {
		return store.Issue{}, err
	}
	return issue, nil
}

func (s *Store) AbandonIssue(ctx context.Context, id string, expectedRunID string) (store.Issue, error) {
	var result store.Issue
	err := s.withTx(ctx, func(tx *Store) error {
		issue, err := tx.GetIssue(ctx, id)
		if err != nil {
			return err
		}
		if issue.Status == "abandoned" {
			result = issue
			return nil
		}
		if issue.Status == "accepted" || issue.Status == "in_progress" || (issue.Run != nil && issue.Run.Status == "running") {
			return fmt.Errorf("stop execution before abandoning an unfinished Issue; accepted Issues cannot be abandoned")
		}
		currentRunID := ""
		if issue.Run != nil {
			currentRunID = issue.Run.ID
		}
		if expectedRunID != currentRunID {
			return fmt.Errorf("issue execution changed; refresh before abandoning")
		}
		if err := issue.Apply(store.IssueEventAbandoned, nil); err != nil {
			return err
		}
		issue.UpdatedLabel = "just now"
		issue.Checks = appendUnique(issue.Checks, "Abandoned by user; candidate and history retained")
		if err := tx.saveIssue(ctx, issue, time.Time{}, time.Now().UTC()); err != nil {
			return err
		}
		result = issue
		return nil
	})
	return result, err
}

func (s *Store) ListRuns(ctx context.Context, workspaceID string) ([]store.Run, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID != "" {
		return listJSON[store.Run](ctx, s.reader(), `SELECT payload_json FROM runs WHERE workspace_id = ? ORDER BY updated_at DESC`, workspaceID)
	}
	return listJSON[store.Run](ctx, s.reader(), `SELECT payload_json FROM runs ORDER BY updated_at DESC`)
}
