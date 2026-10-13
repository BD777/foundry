package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
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
	_, err := s.RegisterDaemonChanges(ctx, input)
	return err
}

// RegisterDaemonChanges stores a device's report and says what it changed.
func (s *Store) RegisterDaemonChanges(ctx context.Context, input store.DaemonRegistration) (store.DaemonChanges, error) {
	now := time.Now().UTC()
	// A name given on the server outlives the hostname the worker reports.
	if name, err := s.deviceDisplayName(ctx, input.Device.ID); err != nil {
		return store.DaemonChanges{}, err
	} else if name != "" {
		input.Device.Label = name
	}
	input.Workspace.DeviceID = input.Device.ID
	input.Workspace.DeviceLabel = input.Device.Label
	// Each chat is compared before the transaction, so the writer is held
	// only to write the chats that changed.
	comparisons := make([]chatComparison, len(input.Chats))
	if input.Workspace.ID != "" {
		for index, chat := range input.Chats {
			if chat.WorkspaceID == "" {
				chat.WorkspaceID = input.Workspace.ID
			}
			comparisons[index] = s.compareChat(ctx, chat)
		}
	}
	var changes store.DaemonChanges
	err := s.withTx(ctx, func(tx *Store) error {
		// A soft-removed device must never upsert itself back. Refuse the whole
		// registration (device, workspace, profiles, chats) so a reconnecting
		// worker cannot resurrect anything.
		if err := tx.assertDeviceNotRemoved(ctx, input.Device.ID); err != nil {
			return err
		}
		input := input
		// A workspace the person deleted from this device stays deleted:
		// only the device's own news is kept.
		deleted, err := tx.WorkspaceDeletedFromDevice(ctx, input.Workspace.ID, input.Device.ID)
		if err != nil {
			return err
		}
		if deleted {
			changes.DeletedWorkspace = input.Workspace.ID
			input.Workspace = store.WorkspaceProjection{}
		}
		before, err := tx.daemonState(ctx, input.Device.ID, input.Workspace.ID)
		if err != nil {
			return err
		}
		chatsChanged, err := tx.registerDaemon(ctx, input, comparisons, now)
		if err != nil {
			return err
		}
		after, err := tx.daemonState(ctx, input.Device.ID, input.Workspace.ID)
		if err != nil {
			return err
		}
		parts := store.DaemonChangedParts{
			Known:          true,
			Device:         before.device != after.device,
			ProviderHealth: before.health != after.health,
			AgentProfiles:  before.profiles != after.profiles,
			NewWorkspace:   !before.hasWorkspace && after.hasWorkspace,
			Workspace:      before.workspace != after.workspace,
			Agents:         before.agents != after.agents,
			Assets:         before.assets != after.assets,
			Skills:         before.skills != after.skills,
			WorkspaceFiles: before.files != after.files,
			Chats:          chatsChanged,
		}
		changes.Parts = parts
		changes.Global = parts.Device || parts.ProviderHealth || parts.AgentProfiles || parts.NewWorkspace
		if input.Workspace.ID != "" && (parts.Chats || parts.Workspace || parts.Agents || parts.Assets || parts.Skills || parts.WorkspaceFiles) {
			changes.Workspaces = []string{input.Workspace.ID}
		}
		return nil
	})
	if err != nil {
		return store.DaemonChanges{}, err
	}
	return changes, nil
}

// registerDaemon writes a registration in the caller's transaction and
// reports whether its chats changed.
func (s *Store) registerDaemon(ctx context.Context, input store.DaemonRegistration, comparisons []chatComparison, now time.Time) (bool, error) {
	// A device that has no workspace yet reports only itself.
	if input.Workspace.ID == "" {
		if err := s.saveDevice(ctx, input.Device, now); err != nil {
			return false, err
		}
		if err := s.replaceDeviceProviderHealth(ctx, input.Device.ID, input.ProviderHealth, now); err != nil {
			return false, err
		}
		return false, s.replaceDeviceAgentProfiles(ctx, input.Device.ID, input.AgentProfiles, now)
	}
	if err := s.assertWorkspaceClaimable(ctx, input.Workspace.ID, input.Device.ID); err != nil {
		return false, err
	}
	if err := s.saveWorkspace(ctx, input.Workspace, now); err != nil {
		return false, err
	}
	if err := s.ensureDeviceOwnerMembership(ctx, input.Workspace.ID, input.Device.ID); err != nil {
		return false, err
	}
	if err := s.saveDevice(ctx, input.Device, now); err != nil {
		return false, err
	}
	// A daemon report is the machine's full picture, so anything it stops
	// reporting has to disappear here too. Upserting alone left phantom rows
	// that no UI could delete.
	if err := s.replaceDeviceProviderHealth(ctx, input.Device.ID, input.ProviderHealth, now); err != nil {
		return false, err
	}
	if err := s.replaceDeviceAgentProfiles(ctx, input.Device.ID, input.AgentProfiles, now); err != nil {
		return false, err
	}
	chatsChanged := false
	for index, chat := range input.Chats {
		if chat.WorkspaceID == "" {
			chat.WorkspaceID = input.Workspace.ID
		}
		changed, _, err := s.saveComparedChat(ctx, chat, now, comparisons[index])
		if err != nil {
			return false, err
		}
		chatsChanged = chatsChanged || changed
	}
	if err := s.replaceWorkspaceAssets(ctx, input.Workspace.ID, input.Assets, now); err != nil {
		return false, err
	}
	if err := s.replaceWorkspaceSkills(ctx, input.Workspace.ID, input.Skills, now); err != nil {
		return false, err
	}
	if err := s.replaceWorkspaceFiles(ctx, input.Workspace.ID, input.WorkspaceFiles, now); err != nil {
		return false, err
	}
	return chatsChanged, s.replaceWorkspaceAgents(ctx, input.Workspace.ID, input.Device.ID, input.Agents, now)
}

// daemonState is what a registration writes that clients read, as stored:
// the device (its row, provider health and agent profiles), and the
// workspace with its agents, assets, skills and files (all "" when there is
// no workspace row). A device's status travels in device_status_changed,
// which is routed by workspace: only without one does it count here.
type daemonState struct {
	device, health, profiles                 string
	hasWorkspace                             bool
	workspace, agents, assets, skills, files string
}

func (s *Store) daemonState(ctx context.Context, deviceID, workspaceID string) (daemonState, error) {
	read := func(query string, args ...any) (string, error) {
		rows, err := listStrings(ctx, s.conn(), query, args...)
		return strings.Join(rows, "\n"), err
	}
	var state daemonState
	var err error
	if state.health, err = read(`SELECT payload_json FROM provider_health WHERE substr(provider, 1, length(?)) = ? ORDER BY provider`, deviceID+":", deviceID+":"); err != nil {
		return state, err
	}
	if state.profiles, err = read(`SELECT payload_json FROM agent_profiles WHERE device_id = ? ORDER BY id`, deviceID); err != nil {
		return state, err
	}
	row := `SELECT json_remove(payload_json, '$.status', '$.lastSeenLabel') FROM devices WHERE id = ?`
	if workspaceID == "" {
		row = `SELECT payload_json FROM devices WHERE id = ?`
	}
	if state.device, err = read(row, deviceID); err != nil {
		return state, err
	}
	if workspaceID == "" {
		return state, nil
	}
	if state.workspace, err = read(`SELECT payload_json FROM workspaces WHERE id = ?`, workspaceID); err != nil || state.workspace == "" {
		// No workspace row yet.
		return state, err
	}
	state.hasWorkspace = true
	for _, part := range []struct {
		into *string
		sql  string
		args []any
	}{
		{&state.agents, `SELECT payload_json FROM agents WHERE workspace_id = ? AND device_id = ? ORDER BY id`, []any{workspaceID, deviceID}},
		{&state.assets, `SELECT payload_json FROM assets WHERE workspace_id = ? ORDER BY id`, []any{workspaceID}},
		{&state.skills, `SELECT payload_json FROM skills WHERE workspace_id = ? ORDER BY id`, []any{workspaceID}},
		{&state.files, `SELECT payload_json FROM workspace_files WHERE workspace_id = ? ORDER BY id`, []any{workspaceID}},
	} {
		if *part.into, err = read(part.sql, part.args...); err != nil {
			return state, err
		}
	}
	return state, nil
}

func (s *Store) ClaimNextIssue(ctx context.Context, deviceID string, workspaceID string) (store.Issue, error) {
	var issue store.Issue
	err := s.withTx(ctx, func(tx *Store) error {
		claimed, err := tx.claimNextIssue(ctx, deviceID, workspaceID)
		issue = claimed
		return err
	})
	if err != nil {
		return store.Issue{}, err
	}
	return issue, nil
}

// ClaimIssueExecution claims the next ready Issue for the device and creates
// the session that implements it, in one transaction: a claimed Issue always
// has its execution session.
func (s *Store) ClaimIssueExecution(ctx context.Context, deviceID string, workspaceID string) (store.Issue, store.AgentSession, error) {
	var (
		issue   store.Issue
		session store.AgentSession
	)
	err := s.withTx(ctx, func(tx *Store) error {
		claimed, err := tx.claimNextIssue(ctx, deviceID, workspaceID)
		if err != nil {
			return err
		}
		created, err := tx.createIssueExecutionSession(ctx, claimed, deviceID)
		if err != nil {
			return err
		}
		issue, session = claimed, created
		return nil
	})
	if err != nil {
		return store.Issue{}, store.AgentSession{}, err
	}
	return issue, session, nil
}

func (s *Store) createIssueExecutionSession(ctx context.Context, issue store.Issue, deviceID string) (store.AgentSession, error) {
	now := time.Now().UTC()
	id := newSessionID(now)
	prompt := fmt.Sprintf("Implement %s under its confirmed contract (revision %d).", issue.ShortID, *issue.CurrentContractRevision)
	session := store.AgentSession{
		CreatedByUserID:      issue.CreatedByUserID,
		ID:                   id,
		ThreadID:             id,
		WorkspaceID:          issue.WorkspaceID,
		DeviceID:             deviceID,
		Provider:             issue.Runtime,
		ProfileID:            issue.ProfileID,
		Source:               "issue",
		Role:                 store.AgentSessionRoleIssueExecution,
		IssueID:              issue.ID,
		Model:                issue.Model,
		ClaudeEffort:         issue.ClaudeEffort,
		CodexReasoningEffort: issue.CodexReasoningEffort,
		CodexSpeed:           issue.CodexSpeed,
		Status:               "queued",
		Title:                titleFromInput(issue.Title),
		Prompt:               prompt,
		Input:                store.SessionInput{ID: newSessionInputID(now), Prompt: prompt, At: formatTime(now)},
		CreatedLabel:         "just now",
		UpdatedLabel:         "queued",
		Events:               []store.AgentSessionEvent{},
	}
	if err := s.saveAgentSession(ctx, session, now, now); err != nil {
		return store.AgentSession{}, err
	}
	if err := s.recordSessionInput(ctx, session.ID, session.Input, now); err != nil {
		return store.AgentSession{}, err
	}
	return session, nil
}

// ExecutionIssue is the Issue an execution session implements, with the
// confirmed contract it runs under attached.
func (s *Store) ExecutionIssue(ctx context.Context, issueID string) (store.Issue, error) {
	issue, err := s.GetIssue(ctx, issueID)
	if err != nil {
		return store.Issue{}, err
	}
	if err := s.requireConfirmedContract(ctx, issue); err != nil {
		return store.Issue{}, err
	}
	contract, err := s.contractByRevision(ctx, issue.ID, *issue.CurrentContractRevision)
	if err != nil {
		return store.Issue{}, err
	}
	issue.ExecutionContract = &contract
	return issue, nil
}

func (s *Store) claimNextIssue(ctx context.Context, deviceID string, workspaceID string) (store.Issue, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	var issue store.Issue
	err := func(tx *Store) error {
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
		if err := claimed.Apply(store.IssueEventExecutionStarted, nil); err != nil {
			return err
		}
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
	}(s)
	if err != nil {
		return store.Issue{}, err
	}
	return issue, nil
}

// SyncChats stores a device's native chats. Each one is checked against the
// native sessions Foundry sessions own in the same transaction it is
// written in, so a chat being continued at that moment cannot reappear.
func (s *Store) SyncChats(ctx context.Context, input store.SyncChatsInput) error {
	_, err := s.SyncChatsChanges(ctx, input)
	return err
}

// SyncChatsChanges is SyncChats reporting the workspaces whose chat list
// changed. A worker resends chats it is unsure about; an unchanged one
// changes nothing.
func (s *Store) SyncChatsChanges(ctx context.Context, input store.SyncChatsInput) (store.DaemonChanges, error) {
	now := time.Now().UTC()
	var changes store.DaemonChanges
	for _, chat := range input.Chats {
		if chat.ID == "" {
			continue
		}
		if chat.WorkspaceID == "" {
			chat.WorkspaceID = input.WorkspaceID
		}
		comparison := s.compareChat(ctx, chat)
		var changed, refused bool
		if err := s.withTx(ctx, func(tx *Store) error {
			var err error
			changed, refused, err = tx.saveComparedChat(ctx, chat, now, comparison)
			return err
		}); err != nil {
			return changes, err
		}
		if refused {
			changes.RefusedChats = append(changes.RefusedChats, chat.ID)
		}
		if changed && !slices.Contains(changes.Workspaces, chat.WorkspaceID) {
			changes.Workspaces = append(changes.Workspaces, chat.WorkspaceID)
		}
	}
	return changes, nil
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
	// Readers iterate events; a run always carries a list, empty at start.
	if run.Events == nil {
		run.Events = []store.RunEvent{}
	}
	if run.StartedAt == "" {
		run.StartedAt = time.Now().UTC().Format(time.RFC3339)
	}
	// The claim already started the Issue; a run started otherwise starts it here.
	if issue.Status != "in_progress" {
		if err := issue.Apply(store.IssueEventExecutionStarted, nil); err != nil {
			return store.Issue{}, err
		}
	}
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
	event, reason := store.IssueEventExecutionFinished, (*store.IssueBlockedReason)(nil)
	switch question := issue.Question; {
	case input.Canceled:
		run.Status = "canceled"
		event, reason = store.IssueEventExecutionStopped, &store.IssueBlockedReason{Kind: "needs_input", Message: "Execution stopped. Send a message to continue in the retained candidate workspace."}
	case input.Error != "":
		run.Status = "failed"
		event, reason = store.IssueEventExecutionFailed, &store.IssueBlockedReason{Kind: "system_error", Message: input.Error}
	case question != nil && question.RunID == run.ID:
		// A turn that ended on a question waits for the person, not for review.
		event, reason = store.IssueEventExecutionAsked, &store.IssueBlockedReason{Kind: "needs_" + question.Kind, Message: question.Text}
	}
	if err := issue.Apply(event, reason); err != nil {
		return store.Issue{}, err
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
