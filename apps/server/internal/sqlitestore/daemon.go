package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// assertWorkspaceClaimable keeps a workspace on the device that registered it
// while that device is still present on the server.
func (s *Store) assertWorkspaceClaimable(ctx context.Context, workspaceID, deviceID string) error {
	var current sql.NullString
	err := s.conn().QueryRowContext(ctx,
		`SELECT json_extract(payload_json, '$.deviceId') FROM workspaces WHERE id = ?`, workspaceID).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) || !current.Valid || current.String == "" || current.String == deviceID {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read workspace device: %w", err)
	}
	removed, err := s.isDeviceRemoved(ctx, current.String)
	if err != nil {
		return err
	}
	if removed {
		return nil
	}
	return fmt.Errorf("%w: %s", store.ErrWorkspaceOwnedByAnotherDevice, workspaceID)
}

func (s *Store) RegisterDaemon(ctx context.Context, input store.DaemonRegistration) error {
	now := time.Now().UTC()
	input.Workspace.DeviceID = input.Device.ID
	input.Workspace.DeviceLabel = input.Device.Label
	return s.withTx(ctx, func(tx *Store) error {
		// A soft-removed device must never upsert itself back. Refuse the whole
		// registration (device, workspace, profiles, chats) so a reconnecting
		// worker cannot resurrect anything.
		if err := tx.assertDeviceNotRemoved(ctx, input.Device.ID); err != nil {
			return err
		}
		if err := tx.assertWorkspaceClaimable(ctx, input.Workspace.ID, input.Device.ID); err != nil {
			return err
		}
		if err := tx.saveWorkspace(ctx, input.Workspace, now); err != nil {
			return err
		}
		if err := tx.ensureDeviceOwnerMembership(ctx, input.Workspace.ID, input.Device.ID); err != nil {
			return err
		}
		if err := tx.saveDevice(ctx, input.Device, now); err != nil {
			return err
		}
		// A daemon report is the machine's full picture, so anything it stops
		// reporting has to disappear here too. Upserting alone left phantom rows
		// that no UI could delete.
		if err := tx.replaceDeviceProviderHealth(ctx, input.Device.ID, input.ProviderHealth, now); err != nil {
			return err
		}
		if err := tx.replaceDeviceAgentProfiles(ctx, input.Device.ID, input.AgentProfiles, now); err != nil {
			return err
		}
		for _, chat := range input.Chats {
			if chat.WorkspaceID == "" {
				chat.WorkspaceID = input.Workspace.ID
			}
			if err := tx.saveChatIfChanged(ctx, chat, now); err != nil {
				return err
			}
		}
		if err := tx.replaceWorkspaceAssets(ctx, input.Workspace.ID, input.Assets, now); err != nil {
			return err
		}
		if err := tx.replaceWorkspaceSkills(ctx, input.Workspace.ID, input.Skills, now); err != nil {
			return err
		}
		if err := tx.replaceWorkspaceFiles(ctx, input.Workspace.ID, input.WorkspaceFiles, now); err != nil {
			return err
		}
		return tx.replaceWorkspaceAgents(ctx, input.Workspace.ID, input.Device.ID, input.Agents, now)
	})
}

func (s *Store) ClaimNextIssue(ctx context.Context, deviceID string, workspaceID string) (store.Issue, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	var issue store.Issue
	err := s.withTx(ctx, func(tx *Store) error {
		// Gate the claiming worker itself, regardless of which workspace the
		// issue belongs to. The check shares this serialized transaction with
		// the claim update, so it cannot race a concurrent SoftRemoveDevice.
		if err := tx.assertDeviceNotRemoved(ctx, deviceID); err != nil {
			return err
		}
		if workspaceID == "" {
			workspaceID = tx.workspaceIDForDevice(ctx, deviceID)
		}
		claimed, err := getJSON[store.Issue](ctx, tx.conn(), `SELECT payload_json FROM issues
			WHERE status IN ('ready', 'pending') AND json_extract(payload_json, '$.contractState') = 'confirmed'
			AND (? = '' OR workspace_id = ? OR workspace_id = '')
			ORDER BY updated_at ASC LIMIT 1`, workspaceID, workspaceID)
		if err != nil {
			return err
		}
		if claimed.WorkspaceID == "" {
			claimed.WorkspaceID = workspaceID
		}
		// A recovered/re-queued issue still belongs to its original device's
		// workspace; it must not be dispatched after that device was removed.
		if err := tx.assertWorkspaceDeviceNotRemoved(ctx, claimed.WorkspaceID); err != nil {
			return err
		}
		if err := tx.requireConfirmedContract(ctx, claimed); err != nil {
			return err
		}
		claimed.Status = "in_progress"
		claimed.BlockedReason = nil
		claimed.UpdatedLabel = "just now"
		claimed.Checks = appendUnique(claimed.Checks, "Dispatched to local worker "+deviceID)
		if err := tx.saveIssue(ctx, claimed, time.Time{}, time.Now().UTC()); err != nil {
			return err
		}
		issue = claimed
		contract, err := tx.contractByRevision(ctx, claimed.ID, *claimed.CurrentContractRevision)
		if err != nil {
			return err
		}
		// Attach only to the dispatch result. The immutable record remains canonical.
		issue.ExecutionContract = &contract
		return nil
	})
	if err != nil {
		return store.Issue{}, err
	}
	return issue, nil
}

func (s *Store) SyncChats(ctx context.Context, input store.SyncChatsInput) error {
	now := time.Now().UTC()
	for _, chat := range input.Chats {
		if chat.ID == "" {
			continue
		}
		if chat.WorkspaceID == "" {
			chat.WorkspaceID = input.WorkspaceID
		}
		if err := s.saveChatIfChanged(ctx, chat, now); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) StartIssueRun(ctx context.Context, issueID string, run store.Run) (store.Issue, error) {
	var issue store.Issue
	err := s.withTx(ctx, func(tx *Store) error {
		started, err := tx.startIssueRun(ctx, issueID, run)
		if err != nil {
			return err
		}
		issue = started
		return nil
	})
	if err != nil {
		return store.Issue{}, err
	}
	return issue, nil
}

func (s *Store) startIssueRun(ctx context.Context, issueID string, run store.Run) (store.Issue, error) {
	issue, err := s.GetIssue(ctx, issueID)
	if err != nil {
		return store.Issue{}, err
	}
	if existing, lookupErr := s.getRun(ctx, run.ID); lookupErr == nil {
		if existing.IssueID != issue.ID {
			return store.Issue{}, fmt.Errorf("run belongs to another issue")
		}
		return issue, nil
	} else if !errors.Is(lookupErr, store.ErrNotFound) {
		return store.Issue{}, lookupErr
	}
	if err := s.requireConfirmedContract(ctx, issue); err != nil {
		return store.Issue{}, err
	}
	if err := s.assertWorkspaceDeviceNotRemoved(ctx, issue.WorkspaceID); err != nil {
		return store.Issue{}, err
	}
	if issue.Status == "accepted" || issue.Status == "abandoned" || (issue.Run != nil && issue.Run.Status == "running") {
		return store.Issue{}, fmt.Errorf("issue is not available for another run")
	}
	run.IssueID = issue.ID
	run.WorkspaceID = issue.WorkspaceID
	run.Status = "running"
	if run.StartedAt == "" {
		run.StartedAt = time.Now().UTC().Format(time.RFC3339)
	}
	issue.Status = "in_progress"
	// Starting another implementation invalidates the current review projection,
	// even before the first file write. Historical snapshots remain immutable.
	issue.CurrentCandidateSnapshotID = nil
	issue.CurrentReviewSnapshotID = nil
	issue.VerificationSummary = nil
	issue.BlockedReason = nil
	issue.Run = &run
	issue.UpdatedLabel = "just now"
	issue.Checks = appendUnique(issue.Checks, "Local worker run started")
	now := time.Now().UTC()
	if err := s.saveRun(ctx, run, now); err != nil {
		return store.Issue{}, err
	}
	if err := s.saveIssue(ctx, issue, time.Time{}, now); err != nil {
		return store.Issue{}, err
	}
	return issue, nil
}

func (s *Store) AppendRunEvent(ctx context.Context, event store.RunEvent) error {
	return s.withTx(ctx, func(tx *Store) error {
		return tx.appendRunEvent(ctx, event)
	})
}

func (s *Store) appendRunEvent(ctx context.Context, event store.RunEvent) error {
	run, err := s.getRun(ctx, event.RunID)
	if err != nil {
		return err
	}
	for _, existing := range run.Events {
		if existing.ID == event.ID {
			return nil
		}
	}
	run.Events = append(run.Events, event)
	now := time.Now().UTC()
	if err := s.saveRun(ctx, run, now); err != nil {
		return err
	}
	issue, err := s.GetIssue(ctx, run.IssueID)
	if err != nil {
		return err
	}
	if issue.Run != nil && issue.Run.ID == run.ID {
		issue.Run = &run
		if event.Label == "Steered into active turn" {
			issue.Messages = append(issue.Messages, store.IssueConversationMessage{ID: "msg_" + event.ID, Role: "user", Text: event.Detail, RunID: run.ID, CreatedAt: event.At})
		}
		if err := s.saveIssue(ctx, issue, time.Time{}, now); err != nil {
			return err
		}
	}
	return s.saveRunEvent(ctx, event, now)
}

func (s *Store) CompleteIssue(ctx context.Context, issueID string, input store.CompleteIssueInput) (store.Issue, error) {
	var issue store.Issue
	err := s.withTx(ctx, func(tx *Store) error {
		completed, err := tx.completeIssue(ctx, issueID, input)
		if err != nil {
			return err
		}
		issue = completed
		return nil
	})
	if err != nil {
		return store.Issue{}, err
	}
	return issue, nil
}

func (s *Store) completeIssue(ctx context.Context, issueID string, input store.CompleteIssueInput) (store.Issue, error) {
	issue, err := s.GetIssue(ctx, issueID)
	if err != nil {
		return store.Issue{}, err
	}
	run, err := s.getRun(ctx, input.RunID)
	if err != nil {
		return store.Issue{}, err
	}
	if run.IssueID != issue.ID {
		return store.Issue{}, fmt.Errorf("run belongs to another issue")
	}
	if run.Status == "completed" || run.Status == "failed" || run.Status == "canceled" {
		return issue, nil
	}
	if issue.Run == nil || issue.Run.ID != run.ID {
		return store.Issue{}, fmt.Errorf("completion does not belong to current issue run")
	}
	run.EnvironmentID = input.EnvironmentID
	run.EnvironmentRevision = input.EnvironmentRevision
	run.ExecutionCwd = input.ExecutionCwd
	run.Error = input.Error
	if input.Response != "" {
		issue.Messages = append(issue.Messages, store.IssueConversationMessage{ID: "msg_" + run.ID, Role: "assistant", Text: input.Response, RunID: run.ID, CreatedAt: time.Now().UTC().Format(time.RFC3339)})
	}
	if run.WorkspaceID == "" {
		run.WorkspaceID = issue.WorkspaceID
	}
	run.Status = "completed"
	run.CompletedAt = time.Now().UTC().Format(time.RFC3339)
	issue.Status = "verifying"
	issue.BlockedReason = nil
	if input.Error != "" {
		run.Status = "failed"
		issue.Status = "blocked"
		issue.BlockedReason = &store.IssueBlockedReason{Kind: "system_error", Message: input.Error}
	}
	if input.Canceled {
		run.Status = "canceled"
		issue.Status = "blocked"
		issue.BlockedReason = &store.IssueBlockedReason{Kind: "needs_input", Message: "Execution stopped. Send a message to continue in the retained candidate workspace."}
	}
	issue.Artifact = &input.Artifact
	issue.Run = &run
	issue.UpdatedLabel = "just now"
	issue.Checks = appendUnique(issue.Checks, "Acceptance artifact produced")
	for _, check := range input.Checks {
		issue.Checks = appendUnique(issue.Checks, check)
	}

	now := time.Now().UTC()
	if err := s.saveRun(ctx, run, now); err != nil {
		return store.Issue{}, err
	}
	if err := s.saveArtifact(ctx, input.Artifact, now); err != nil {
		return store.Issue{}, err
	}
	if err := s.saveIssue(ctx, issue, time.Time{}, now); err != nil {
		return store.Issue{}, err
	}
	return issue, nil
}
