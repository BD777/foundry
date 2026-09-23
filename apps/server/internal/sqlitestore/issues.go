package sqlitestore

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Store) ListIssues(ctx context.Context, workspaceID string) ([]store.Issue, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	var issues []store.Issue
	var err error
	if workspaceID != "" {
		issues, err = listJSON[store.Issue](ctx, s.conn(), `SELECT payload_json FROM issues WHERE workspace_id = ? ORDER BY updated_at DESC`, workspaceID)
	} else {
		issues, err = listJSON[store.Issue](ctx, s.conn(), `SELECT payload_json FROM issues ORDER BY updated_at DESC`)
	}
	for index := range issues {
		issues[index] = normalizeIssueStatus(issues[index])
	}
	return issues, err
}

func (s *Store) GetIssue(ctx context.Context, id string) (store.Issue, error) {
	issue, err := getJSON[store.Issue](ctx, s.conn(), `SELECT payload_json FROM issues WHERE id = ? OR short_id = ?`, id, id)
	return normalizeIssueStatus(issue), err
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

func (s *Store) UpdateIssueStatus(ctx context.Context, id string, status string) (store.Issue, error) {
	var updated store.Issue
	err := s.withTx(ctx, func(tx *Store) error {
		issue, err := tx.GetIssue(ctx, id)
		if err != nil {
			return err
		}
		// Recover-claim and other re-queue paths go through here; a removed
		// device must never receive new dispatchable work.
		if status == "pending" {
			if err := tx.assertWorkspaceDeviceNotRemoved(ctx, issue.WorkspaceID); err != nil {
				return err
			}
		}
		if (status == "accepted" || status == "integrated") && issue.Status != "accepted" {
			return fmt.Errorf("accept_protocol_upgrade_required: acceptance requires an integrated decision")
		}
		issue.Status = status
		issue = normalizeIssueStatus(issue)
		issue.UpdatedLabel = "just now"
		if status == "accepted" {
			issue.Checks = appendUnique(issue.Checks, "Accepted into baseline")
		}
		if status == "pending" {
			issue.Checks = appendUnique(issue.Checks, "Changes requested")
		}
		if err := tx.saveIssue(ctx, issue, time.Time{}, time.Now().UTC()); err != nil {
			return err
		}
		updated = issue
		return nil
	})
	if err != nil {
		return store.Issue{}, err
	}
	return updated, nil
}

func (s *Store) RequestIssueChanges(ctx context.Context, id string, message string, expectedRunID string) (store.Issue, error) {
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
		if message != "" {
			issue.Messages = append(issue.Messages, store.IssueConversationMessage{ID: fmt.Sprintf("msg_%s_%d", issue.ID, len(issue.Messages)+1), Role: "user", Text: message, CreatedAt: time.Now().UTC().Format(time.RFC3339)})
		}
		issue.Status = "pending"
		issue.BlockedReason = nil
		issue.Checks = appendUnique(issue.Checks, "Changes requested")
		issue.UpdatedLabel = "just now"
		if err = tx.saveIssue(ctx, issue, time.Time{}, time.Now().UTC()); err != nil {
			return err
		}
		result = issue
		return nil
	})
	return result, err
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
		issue.Status = "abandoned"
		issue.BlockedReason = nil
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
		return listJSON[store.Run](ctx, s.conn(), `SELECT payload_json FROM runs WHERE workspace_id = ? ORDER BY updated_at DESC`, workspaceID)
	}
	return listJSON[store.Run](ctx, s.conn(), `SELECT payload_json FROM runs ORDER BY updated_at DESC`)
}

func (s *Store) ListRunEvents(ctx context.Context, workspaceID string) ([]store.RunEvent, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID != "" {
		return listJSON[store.RunEvent](ctx, s.conn(), `SELECT run_events.payload_json
			FROM run_events
			INNER JOIN runs ON runs.id = run_events.run_id
			WHERE runs.workspace_id = ?
			ORDER BY run_events.created_at DESC LIMIT 200`, workspaceID)
	}
	return listJSON[store.RunEvent](ctx, s.conn(), `SELECT payload_json FROM run_events ORDER BY created_at DESC LIMIT 200`)
}
