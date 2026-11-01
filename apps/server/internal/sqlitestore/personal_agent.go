package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The Personal Agent's tables (docs/personal-agent.md §2–§9): one assistant
// per person, its memory about the person, the actions waiting for the
// person's yes, the work it handed off, its audit trail and its routing
// decisions. Every row belongs to one person (user_id).

var _ store.PersonalAgentStore = (*Store)(nil)

// personalAgentActionRetention is how long pa_actions keeps a row (§5).
const personalAgentActionRetention = 90 * 24 * time.Hour

func (s *Store) setupPersonalAgents(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS personal_agents (
			user_id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL UNIQUE,
			home_device_id TEXT NOT NULL,
			state TEXT NOT NULL,
			settings_json TEXT NOT NULL,
			prompt_version TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			stopped_at TEXT NOT NULL DEFAULT '',
			former_workspace_ids TEXT NOT NULL DEFAULT '[]',
			digest_sent_on TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS pa_memory (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			content TEXT NOT NULL,
			origin TEXT NOT NULL,
			status TEXT NOT NULL,
			source_session_id TEXT NOT NULL DEFAULT '',
			source_input_id TEXT NOT NULL DEFAULT '',
			supersedes TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			verified_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_pa_memory_user ON pa_memory (user_id, created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS pa_proposals (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			workspace_id TEXT NOT NULL DEFAULT '',
			spec_json TEXT NOT NULL,
			summary TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			decided_at TEXT NOT NULL DEFAULT '',
			decided_via TEXT NOT NULL DEFAULT '',
			error TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_pa_proposals_user ON pa_proposals (user_id, status, created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS pa_tasks (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			conversation_session_id TEXT NOT NULL,
			session_id TEXT NOT NULL DEFAULT '',
			workspace_id TEXT NOT NULL,
			title TEXT NOT NULL,
			status TEXT NOT NULL,
			read_only INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_event_at TEXT NOT NULL DEFAULT '',
			ended_at TEXT NOT NULL DEFAULT '',
			stuck_since TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_pa_tasks_user ON pa_tasks (user_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_pa_tasks_session ON pa_tasks (session_id)`,
		`CREATE TABLE IF NOT EXISTS pa_actions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			session_id TEXT NOT NULL DEFAULT '',
			tool TEXT NOT NULL,
			args_summary TEXT NOT NULL,
			args_json TEXT NOT NULL DEFAULT '{}',
			workspace_id TEXT NOT NULL DEFAULT '',
			decision TEXT NOT NULL DEFAULT '',
			outcome TEXT NOT NULL,
			refusal TEXT NOT NULL DEFAULT '',
			proposal_id TEXT NOT NULL DEFAULT '',
			confirmed_via TEXT NOT NULL DEFAULT '',
			error TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_pa_actions_user ON pa_actions (user_id, created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS pa_routing_decisions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			input_id TEXT NOT NULL DEFAULT '',
			request TEXT NOT NULL,
			request_class TEXT NOT NULL,
			target TEXT NOT NULL,
			workspace_id TEXT NOT NULL DEFAULT '',
			confidence TEXT NOT NULL,
			candidates_json TEXT NOT NULL DEFAULT '[]',
			corrected INTEGER NOT NULL DEFAULT 0,
			corrected_workspace_id TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_pa_routing_decisions_user ON pa_routing_decisions (user_id, created_at DESC)`,
		// The person's Feishu direct chats (one per app) told once that the
		// assistant took them over (§14).
		`CREATE TABLE IF NOT EXISTS pa_direct_chats (
			user_id TEXT NOT NULL,
			app_id TEXT NOT NULL,
			introduced_at TEXT NOT NULL,
			PRIMARY KEY (user_id, app_id)
		)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite personal agents: %w", err)
		}
	}
	return nil
}

func paNow() string { return formatTime(time.Now()) }

func paID(prefix string) string { return prefix + "_" + strings.ReplaceAll(uuid.NewString(), "-", "") }

// inStatuses is " AND column IN (?, …)" for a non-empty list, and its args.
func inStatuses(column string, statuses []string) (string, []any) {
	if len(statuses) == 0 {
		return "", nil
	}
	args := make([]any, len(statuses))
	for index, status := range statuses {
		args[index] = status
	}
	return " AND " + column + " IN (" + strings.TrimSuffix(strings.Repeat("?, ", len(statuses)), ", ") + ")", args
}

const personalAgentColumns = `user_id, workspace_id, home_device_id, state, settings_json, prompt_version, created_at, updated_at, stopped_at`

// personalAgentRead is what reading an assistant selects.
const personalAgentRead = personalAgentColumns + `, former_workspace_ids`

func scanPersonalAgent(row interface{ Scan(...any) error }) (store.PersonalAgent, error) {
	var agent store.PersonalAgent
	var settings, former string
	if err := row.Scan(&agent.UserID, &agent.WorkspaceID, &agent.HomeDeviceID, &agent.State, &settings,
		&agent.PromptVersion, &agent.CreatedAt, &agent.UpdatedAt, &agent.StoppedAt, &former); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return store.PersonalAgent{}, store.ErrNotFound
		}
		return store.PersonalAgent{}, err
	}
	if err := json.Unmarshal([]byte(settings), &agent.Settings); err != nil {
		return store.PersonalAgent{}, fmt.Errorf("personal agent settings: %w", err)
	}
	if err := json.Unmarshal([]byte(former), &agent.FormerWorkspaceIDs); err != nil {
		return store.PersonalAgent{}, fmt.Errorf("personal agent former workspaces: %w", err)
	}
	return agent, nil
}

func (s *Store) GetPersonalAgent(ctx context.Context, userID string) (store.PersonalAgent, error) {
	return scanPersonalAgent(s.conn().QueryRowContext(ctx, `SELECT `+personalAgentRead+` FROM personal_agents WHERE user_id = ?`, userID))
}

func (s *Store) PersonalAgentForWorkspace(ctx context.Context, workspaceID string) (store.PersonalAgent, error) {
	return scanPersonalAgent(s.conn().QueryRowContext(ctx, `SELECT `+personalAgentRead+` FROM personal_agents WHERE workspace_id = ?`, workspaceID))
}

func (s *Store) CreatePersonalAgent(ctx context.Context, agent store.PersonalAgent) (store.PersonalAgent, error) {
	var saved store.PersonalAgent
	err := s.withTx(ctx, func(tx *Store) error {
		if err := tx.assertDeviceNotRemoved(ctx, agent.HomeDeviceID); err != nil {
			return err
		}
		if err := tx.validatePersonalAgentDeviceReferences(ctx, store.PersonalAgentSettings{}, agent.Settings); err != nil {
			return err
		}
		var err error
		saved, err = tx.createPersonalAgent(ctx, agent)
		return err
	})
	return saved, err
}

func (s *Store) createPersonalAgent(ctx context.Context, agent store.PersonalAgent) (store.PersonalAgent, error) {
	if agent.UserID == "" || agent.WorkspaceID == "" {
		return store.PersonalAgent{}, errors.New("an assistant needs a person and a workspace")
	}
	settings, err := json.Marshal(agent.Settings)
	if err != nil {
		return store.PersonalAgent{}, err
	}
	now := paNow()
	agent.CreatedAt, agent.UpdatedAt = now, now
	if agent.State == "" {
		agent.State = store.PersonalAgentActive
	}
	result, err := s.conn().ExecContext(ctx, `INSERT INTO personal_agents (`+personalAgentColumns+`)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ''
		WHERE NOT EXISTS (SELECT 1 FROM personal_agents WHERE user_id = ? OR workspace_id = ?)`,
		agent.UserID, agent.WorkspaceID, agent.HomeDeviceID, agent.State, string(settings), agent.PromptVersion, now, now,
		agent.UserID, agent.WorkspaceID)
	if err != nil {
		return store.PersonalAgent{}, fmt.Errorf("create personal agent: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return store.PersonalAgent{}, store.ErrPersonalAgentExists
	}
	return agent, nil
}

func (s *Store) SavePersonalAgentSettings(ctx context.Context, userID string, settings store.PersonalAgentSettings) (store.PersonalAgent, error) {
	var saved store.PersonalAgent
	err := s.withTx(ctx, func(tx *Store) error {
		previous, err := tx.GetPersonalAgent(ctx, userID)
		if err != nil {
			return err
		}
		if err := tx.validatePersonalAgentDeviceReferences(ctx, previous.Settings, settings); err != nil {
			return err
		}
		settings.Devices, err = tx.currentPersonalAgentGrants(ctx, settings.Devices)
		if err != nil {
			return err
		}
		raw, err := json.Marshal(settings)
		if err != nil {
			return err
		}
		if err := tx.updatePersonalAgent(ctx, userID, `settings_json = ?, updated_at = ?`, string(raw), paNow()); err != nil {
			return err
		}
		saved, err = tx.GetPersonalAgent(ctx, userID)
		return err
	})
	return saved, err
}

func (s *Store) FillPersonalAgentTimezone(ctx context.Context, userID, timezone string) (store.PersonalAgent, error) {
	if _, err := s.conn().ExecContext(ctx, `UPDATE personal_agents
		SET settings_json = json_set(settings_json, '$.timezone', ?), updated_at = ?
		WHERE user_id = ? AND coalesce(json_extract(settings_json, '$.timezone'), '') = ''`,
		timezone, paNow(), userID); err != nil {
		return store.PersonalAgent{}, fmt.Errorf("fill personal agent time zone: %w", err)
	}
	return s.GetPersonalAgent(ctx, userID)
}

func (s *Store) SetPersonalAgentState(ctx context.Context, userID, state string) (store.PersonalAgent, error) {
	if state != store.PersonalAgentActive && state != store.PersonalAgentStopped {
		return store.PersonalAgent{}, fmt.Errorf("invalid assistant state %q", state)
	}
	now, stoppedAt := paNow(), ""
	if state == store.PersonalAgentStopped {
		stoppedAt = now
	}
	if err := s.withTx(ctx, func(tx *Store) error {
		if e := tx.updatePersonalAgent(ctx, userID, `state = ?, stopped_at = ?, updated_at = ?`, state, stoppedAt, now); e != nil {
			return e
		}
		if state == store.PersonalAgentStopped {
			if _, e := tx.conn().ExecContext(ctx, `UPDATE pa_run_controls SET state='stop_requested',revision=revision+1,payload_json=json_set(payload_json,'$.state','stop_requested','$.stopReason','assistant_stopped','$.revision',revision+1,'$.updatedAt',?) WHERE user_id=? AND state='monitoring'`, now, userID); e != nil {
				return e
			}
			if e := tx.CancelUndispatchedPersonalAgentOperations(ctx, userID); e != nil {
				return e
			}
		}
		return nil
	}); err != nil {
		return store.PersonalAgent{}, err
	}
	return s.GetPersonalAgent(ctx, userID)
}

// MovePersonalAgentHome makes workspaceID on deviceID the assistant's
// workspace and home (§2); the workspace it leaves joins its former ones,
// and one it comes back to leaves them.
func (s *Store) MovePersonalAgentHome(ctx context.Context, userID, workspaceID, deviceID string) (store.PersonalAgent, error) {
	var moved store.PersonalAgent
	err := s.withTx(ctx, func(tx *Store) error {
		if err := tx.assertDeviceNotRemoved(ctx, deviceID); err != nil {
			return err
		}
		agent, err := tx.GetPersonalAgent(ctx, userID)
		if err != nil {
			return err
		}
		former := []string{}
		for _, id := range append(agent.FormerWorkspaceIDs, agent.WorkspaceID) {
			if id != workspaceID && !slices.Contains(former, id) {
				former = append(former, id)
			}
		}
		encoded, err := json.Marshal(former)
		if err != nil {
			return err
		}
		if err := tx.updatePersonalAgent(ctx, userID, `workspace_id = ?, home_device_id = ?, former_workspace_ids = ?, updated_at = ?`,
			workspaceID, deviceID, string(encoded), paNow()); err != nil {
			return err
		}
		moved, err = tx.GetPersonalAgent(ctx, userID)
		return err
	})
	return moved, err
}

// PersonalAgentChatIntroduced reports whether the person's direct chat on
// app appID was told the assistant took it over.
func (s *Store) PersonalAgentChatIntroduced(ctx context.Context, userID, appID string) (bool, error) {
	var found int
	err := s.conn().QueryRowContext(ctx, `SELECT 1 FROM pa_direct_chats WHERE user_id = ? AND app_id = ?`, userID, appID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read direct chat introduction: %w", err)
	}
	return true, nil
}

// ClaimPersonalAgentChatIntroduction records that the chat is being told;
// false when it was already.
func (s *Store) ClaimPersonalAgentChatIntroduction(ctx context.Context, userID, appID string) (bool, error) {
	result, err := s.conn().ExecContext(ctx, `INSERT INTO pa_direct_chats (user_id, app_id, introduced_at) VALUES (?, ?, ?)
		ON CONFLICT (user_id, app_id) DO NOTHING`, userID, appID, paNow())
	if err != nil {
		return false, fmt.Errorf("record direct chat introduction: %w", err)
	}
	count, _ := result.RowsAffected()
	return count > 0, nil
}

func (s *Store) updatePersonalAgent(ctx context.Context, userID, set string, args ...any) error {
	result, err := s.conn().ExecContext(ctx, `UPDATE personal_agents SET `+set+` WHERE user_id = ?`, append(args, userID)...)
	if err != nil {
		return fmt.Errorf("update personal agent: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return store.ErrNotFound
	}
	return nil
}

const memoryColumns = `id, user_id, content, origin, status, source_session_id, source_input_id, supersedes, created_at, updated_at, verified_at`

func scanMemory(row interface{ Scan(...any) error }) (store.PersonalAgentMemoryItem, error) {
	var item store.PersonalAgentMemoryItem
	err := row.Scan(&item.ID, &item.UserID, &item.Content, &item.Origin, &item.Status, &item.SourceSessionID,
		&item.SourceInputID, &item.Supersedes, &item.CreatedAt, &item.UpdatedAt, &item.VerifiedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return item, store.ErrNotFound
	}
	return item, err
}

func (s *Store) ListPersonalAgentMemory(ctx context.Context, userID string) ([]store.PersonalAgentMemoryItem, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+memoryColumns+` FROM pa_memory WHERE user_id = ? ORDER BY created_at DESC, rowid DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("list personal agent memory: %w", err)
	}
	defer rows.Close()
	items := []store.PersonalAgentMemoryItem{}
	for rows.Next() {
		item, err := scanMemory(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) GetPersonalAgentMemory(ctx context.Context, userID, id string) (store.PersonalAgentMemoryItem, error) {
	return scanMemory(s.conn().QueryRowContext(ctx, `SELECT `+memoryColumns+` FROM pa_memory WHERE user_id = ? AND id = ?`, userID, id))
}

func (s *Store) AddPersonalAgentMemory(ctx context.Context, item store.PersonalAgentMemoryItem) (store.PersonalAgentMemoryItem, error) {
	if item.UserID == "" {
		return item, errors.New("a memory item needs a person")
	}
	now := paNow()
	item.ID, item.CreatedAt, item.UpdatedAt = paID("mem"), now, now
	if item.Origin == store.PersonalAgentMemoryStated || item.Origin == store.PersonalAgentMemoryEdited {
		item.VerifiedAt = now
	}
	_, err := s.conn().ExecContext(ctx, `INSERT INTO pa_memory (`+memoryColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		item.ID, item.UserID, item.Content, item.Origin, item.Status, item.SourceSessionID, item.SourceInputID,
		item.Supersedes, item.CreatedAt, item.UpdatedAt, item.VerifiedAt)
	if err != nil {
		return item, fmt.Errorf("add personal agent memory: %w", err)
	}
	return item, nil
}

func (s *Store) SupersedePersonalAgentMemory(ctx context.Context, userID, oldID string, next store.PersonalAgentMemoryItem) (store.PersonalAgentMemoryItem, error) {
	var saved store.PersonalAgentMemoryItem
	err := s.withTx(ctx, func(tx *Store) error {
		result, err := tx.conn().ExecContext(ctx, `UPDATE pa_memory SET status = ?, updated_at = ?
			WHERE user_id = ? AND id = ? AND status IN (?, ?)`,
			store.PersonalAgentMemorySuperseded, paNow(), userID, oldID, store.PersonalAgentMemoryActive, store.PersonalAgentMemoryPending)
		if err != nil {
			return fmt.Errorf("supersede personal agent memory: %w", err)
		}
		if count, _ := result.RowsAffected(); count == 0 {
			return store.ErrNotFound
		}
		next.UserID, next.Supersedes = userID, oldID
		saved, err = tx.AddPersonalAgentMemory(ctx, next)
		return err
	})
	return saved, err
}

func (s *Store) ConfirmPersonalAgentMemory(ctx context.Context, userID, id string) (store.PersonalAgentMemoryItem, error) {
	now := paNow()
	result, err := s.conn().ExecContext(ctx, `UPDATE pa_memory SET status = ?, origin = ?, verified_at = ?, updated_at = ?
		WHERE user_id = ? AND id = ? AND status IN (?, ?)`,
		store.PersonalAgentMemoryActive, store.PersonalAgentMemoryEdited, now, now, userID, id,
		store.PersonalAgentMemoryActive, store.PersonalAgentMemoryPending)
	if err != nil {
		return store.PersonalAgentMemoryItem{}, fmt.Errorf("confirm personal agent memory: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return store.PersonalAgentMemoryItem{}, store.ErrNotFound
	}
	return s.GetPersonalAgentMemory(ctx, userID, id)
}

// ForgetPersonalAgentMemory erases the item and the chain it replaced:
// forgetting is real deletion of the content (§2).
func (s *Store) ForgetPersonalAgentMemory(ctx context.Context, userID, id string) error {
	return s.withTx(ctx, func(tx *Store) error {
		if err := tx.forgetLegacyTransfer(ctx, userID, id); err != nil {
			return err
		}
		return tx.eraseLegacyMemoryChain(ctx, userID, id)
	})
}
func (tx *Store) eraseLegacyMemoryChain(ctx context.Context, userID, id string) error {
	item, err := tx.GetPersonalAgentMemory(ctx, userID, id)
	if err != nil {
		return err
	}
	now := paNow()
	for visited := map[string]bool{}; item.ID != "" && !visited[item.ID]; {
		visited[item.ID] = true
		if _, err := tx.conn().ExecContext(ctx, `UPDATE pa_memory SET content = '', status = ?, updated_at = ? WHERE user_id = ? AND id = ?`,
			store.PersonalAgentMemoryForgotten, now, userID, item.ID); err != nil {
			return fmt.Errorf("forget personal agent memory: %w", err)
		}
		if item.Supersedes == "" {
			break
		}
		if item, err = tx.GetPersonalAgentMemory(ctx, userID, item.Supersedes); errors.Is(err, store.ErrNotFound) {
			break
		} else if err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) ForgetAllPersonalAgentMemory(ctx context.Context, userID string) (int, error) {
	count := 0
	err := s.withTx(ctx, func(tx *Store) error {
		rows, e := tx.reader().QueryContext(ctx, `SELECT id FROM pa_memory WHERE user_id=? AND status<>?`, userID, store.PersonalAgentMemoryForgotten)
		if e != nil {
			return e
		}
		ids := []string{}
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				rows.Close()
				return e
			}
			ids = append(ids, id)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		for _, id := range ids {
			if e = tx.ForgetPersonalAgentMemory(ctx, userID, id); e != nil {
				return e
			}
			count++
		}
		return nil
	})
	return count, err
}

const proposalColumns = `id, user_id, session_id, kind, workspace_id, spec_json, summary, status, created_at, expires_at, decided_at, decided_via, error`

func scanProposal(row interface{ Scan(...any) error }) (store.PersonalAgentProposal, error) {
	var proposal store.PersonalAgentProposal
	var spec string
	err := row.Scan(&proposal.ID, &proposal.UserID, &proposal.SessionID, &proposal.Kind, &proposal.WorkspaceID, &spec,
		&proposal.Summary, &proposal.Status, &proposal.CreatedAt, &proposal.ExpiresAt, &proposal.DecidedAt,
		&proposal.DecidedVia, &proposal.Error)
	if errors.Is(err, sql.ErrNoRows) {
		return proposal, store.ErrNotFound
	}
	proposal.Spec = json.RawMessage(spec)
	return proposal, err
}

func (s *Store) CreatePersonalAgentProposal(ctx context.Context, proposal store.PersonalAgentProposal) (store.PersonalAgentProposal, error) {
	if proposal.UserID == "" || proposal.Kind == "" || proposal.ExpiresAt == "" {
		return proposal, errors.New("a proposal needs a person, a kind and an expiry")
	}
	if len(proposal.Spec) == 0 {
		proposal.Spec = json.RawMessage(`{}`)
	}
	proposal.ID, proposal.CreatedAt = paID("pap"), paNow()
	proposal.Status = store.PersonalAgentProposalPending
	_, err := s.conn().ExecContext(ctx, `INSERT INTO pa_proposals (`+proposalColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '')`,
		proposal.ID, proposal.UserID, proposal.SessionID, proposal.Kind, proposal.WorkspaceID, string(proposal.Spec),
		proposal.Summary, proposal.Status, proposal.CreatedAt, proposal.ExpiresAt)
	if err != nil {
		return proposal, fmt.Errorf("create personal agent proposal: %w", err)
	}
	return proposal, nil
}

func (s *Store) GetPersonalAgentProposal(ctx context.Context, userID, id string) (store.PersonalAgentProposal, error) {
	return scanProposal(s.conn().QueryRowContext(ctx, `SELECT `+proposalColumns+` FROM pa_proposals WHERE user_id = ? AND id = ?`, userID, id))
}

func (s *Store) ListPersonalAgentProposals(ctx context.Context, userID string, statuses []string) ([]store.PersonalAgentProposal, error) {
	filter, args := inStatuses("status", statuses)
	rows, err := s.reader().QueryContext(ctx, `SELECT `+proposalColumns+` FROM pa_proposals WHERE user_id = ?`+filter+`
		ORDER BY created_at DESC, rowid DESC`, append([]any{userID}, args...)...)
	if err != nil {
		return nil, fmt.Errorf("list personal agent proposals: %w", err)
	}
	defer rows.Close()
	proposals := []store.PersonalAgentProposal{}
	for rows.Next() {
		proposal, err := scanProposal(rows)
		if err != nil {
			return nil, err
		}
		proposals = append(proposals, proposal)
	}
	return proposals, rows.Err()
}

func (s *Store) SetPersonalAgentProposalStatus(ctx context.Context, userID, id string, from []string, status, via, errText string) (store.PersonalAgentProposal, error) {
	filter, args := inStatuses("status", from)
	if filter == "" {
		return store.PersonalAgentProposal{}, errors.New("a proposal moves from a known status")
	}
	set, setArgs := `status = ?, error = ?`, []any{status, errText}
	if via != "" {
		set += `, decided_at = ?, decided_via = ?`
		setArgs = append(setArgs, paNow(), via)
	}
	query := `UPDATE pa_proposals SET ` + set + ` WHERE user_id = ? AND id = ?` + filter
	result, err := s.conn().ExecContext(ctx, query, append(append(setArgs, userID, id), args...)...)
	if err != nil {
		return store.PersonalAgentProposal{}, fmt.Errorf("answer personal agent proposal: %w", err)
	}
	proposal, err := s.GetPersonalAgentProposal(ctx, userID, id)
	if err != nil {
		return proposal, err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return proposal, store.ErrPersonalAgentProposalSettled
	}
	return proposal, nil
}

func (s *Store) ExpirePersonalAgentProposals(ctx context.Context, userID, now string) (int, error) {
	query, args := `UPDATE pa_proposals SET status = ? WHERE user_id = ? AND status = ?`,
		[]any{store.PersonalAgentProposalExpired, userID, store.PersonalAgentProposalPending}
	if now != "" {
		query += ` AND expires_at <= ?`
		args = append(args, now)
	}
	result, err := s.conn().ExecContext(ctx, query, args...)
	if err != nil {
		return 0, fmt.Errorf("expire personal agent proposals: %w", err)
	}
	count, _ := result.RowsAffected()
	return int(count), nil
}

const taskColumns = `id, user_id, conversation_session_id, session_id, workspace_id, title, status, read_only, created_at, updated_at, last_event_at, ended_at, stuck_since`

func scanTask(row interface{ Scan(...any) error }) (store.PersonalAgentTask, error) {
	var task store.PersonalAgentTask
	err := row.Scan(&task.ID, &task.UserID, &task.ConversationSessionID, &task.SessionID, &task.WorkspaceID, &task.Title,
		&task.Status, &task.ReadOnly, &task.CreatedAt, &task.UpdatedAt, &task.LastEventAt, &task.EndedAt, &task.StuckSince)
	if errors.Is(err, sql.ErrNoRows) {
		return task, store.ErrNotFound
	}
	return task, err
}

func (s *Store) CreatePersonalAgentTask(ctx context.Context, task store.PersonalAgentTask) (store.PersonalAgentTask, error) {
	var out store.PersonalAgentTask
	err := s.withTx(ctx, func(tx *Store) error {
		if task.SessionID != "" {
			old, e := scanTask(tx.reader().QueryRowContext(ctx, `SELECT `+taskColumns+` FROM pa_tasks WHERE user_id=? AND session_id=? ORDER BY created_at DESC LIMIT 1`, task.UserID, task.SessionID))
			if e == nil {
				if old.WorkspaceID != task.WorkspaceID {
					return store.ErrIdempotencyConflict
				}
				if task.ConversationSessionID != "" && task.ConversationSessionID != old.ConversationSessionID {
					old.ConversationSessionID = task.ConversationSessionID
					if e = tx.UpdatePersonalAgentTask(ctx, old); e != nil {
						return e
					}
				}
				out = old
				return nil
			}
			if !errors.Is(e, store.ErrNotFound) {
				return e
			}
		}
		var e error
		out, e = tx.insertPersonalAgentTask(ctx, task)
		return e
	})
	return out, err
}
func (tx *Store) insertPersonalAgentTask(ctx context.Context, task store.PersonalAgentTask) (store.PersonalAgentTask, error) {
	if task.UserID == "" || task.WorkspaceID == "" {
		return task, errors.New("a task needs a person and a workspace")
	}
	now := paNow()
	task.ID, task.CreatedAt, task.UpdatedAt = paID("pat"), now, now
	if task.Status == "" {
		task.Status = store.PersonalAgentTaskRunning
	}
	_, err := tx.conn().ExecContext(ctx, `INSERT INTO pa_tasks (`+taskColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		task.ID, task.UserID, task.ConversationSessionID, task.SessionID, task.WorkspaceID, task.Title, task.Status,
		task.ReadOnly, task.CreatedAt, task.UpdatedAt, task.LastEventAt, task.EndedAt, task.StuckSince)
	if err != nil {
		return task, fmt.Errorf("create personal agent task: %w", err)
	}
	return task, nil
}

func (s *Store) ListPersonalAgentTasks(ctx context.Context, userID string, statuses []string) ([]store.PersonalAgentTask, error) {
	filter, args := inStatuses("status", statuses)
	rows, err := s.reader().QueryContext(ctx, `SELECT `+taskColumns+` FROM pa_tasks WHERE user_id = ?`+filter+`
		ORDER BY created_at DESC, rowid DESC`, append([]any{userID}, args...)...)
	if err != nil {
		return nil, fmt.Errorf("list personal agent tasks: %w", err)
	}
	defer rows.Close()
	tasks := []store.PersonalAgentTask{}
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

func (s *Store) UpdatePersonalAgentTask(ctx context.Context, task store.PersonalAgentTask) error {
	result, err := s.conn().ExecContext(ctx, `UPDATE pa_tasks SET conversation_session_id = ?, session_id = ?, title = ?, status = ?, updated_at = ?,
		last_event_at = ?, ended_at = ?, stuck_since = ? WHERE user_id = ? AND id = ?`,
		task.ConversationSessionID, task.SessionID, task.Title, task.Status, paNow(), task.LastEventAt, task.EndedAt, task.StuckSince, task.UserID, task.ID)
	if err != nil {
		return fmt.Errorf("update personal agent task: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return store.ErrNotFound
	}
	return nil
}

const actionColumns = `id, user_id, session_id, tool, args_summary, workspace_id, decision, outcome, refusal, proposal_id, confirmed_via, error, created_at`

func (s *Store) RecordPersonalAgentAction(ctx context.Context, record store.PersonalAgentActionRecord, args json.RawMessage) (store.PersonalAgentActionRecord, error) {
	if record.UserID == "" || record.Tool == "" || record.Outcome == "" {
		return record, errors.New("an action record needs a person, a tool and an outcome")
	}
	if len(args) == 0 || !json.Valid(args) {
		args = json.RawMessage(`{}`)
	}
	now := time.Now()
	record.ID, record.CreatedAt = paID("paa"), formatTime(now)
	err := s.withTx(ctx, func(tx *Store) error {
		if _, err := tx.conn().ExecContext(ctx, `INSERT INTO pa_actions (`+actionColumns+`, args_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			record.ID, record.UserID, record.SessionID, record.Tool, record.ArgsSummary, record.WorkspaceID, record.Decision,
			record.Outcome, record.Refusal, record.ProposalID, record.ConfirmedVia, record.Error, record.CreatedAt, string(args)); err != nil {
			return fmt.Errorf("record personal agent action: %w", err)
		}
		_, err := tx.conn().ExecContext(ctx, `DELETE FROM pa_actions WHERE user_id = ? AND created_at < ?`,
			record.UserID, formatTime(now.Add(-personalAgentActionRetention)))
		return err
	})
	return record, err
}

func (s *Store) ListPersonalAgentActions(ctx context.Context, userID string, limit int) ([]store.PersonalAgentActionRecord, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT `+actionColumns+` FROM pa_actions WHERE user_id = ?
		ORDER BY created_at DESC, rowid DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("list personal agent actions: %w", err)
	}
	defer rows.Close()
	records := []store.PersonalAgentActionRecord{}
	for rows.Next() {
		var record store.PersonalAgentActionRecord
		if err := rows.Scan(&record.ID, &record.UserID, &record.SessionID, &record.Tool, &record.ArgsSummary, &record.WorkspaceID,
			&record.Decision, &record.Outcome, &record.Refusal, &record.ProposalID, &record.ConfirmedVia, &record.Error, &record.CreatedAt); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *Store) PersonalAgentCreatedWorkspace(ctx context.Context, userID, workspaceID string) (bool, error) {
	var created bool
	err := s.conn().QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM pa_actions WHERE user_id = ? AND workspace_id = ?
		AND tool IN (?, ?) AND outcome = ?)`, userID, workspaceID, store.PersonalAgentActionCreateWorkspace,
		store.PersonalAgentActionRegisterFolder, store.PersonalAgentOutcomeApplied).Scan(&created)
	return created, err
}

func (s *Store) PersonalAgentConnectorBoundBefore(ctx context.Context, userID, workspaceID, accountID string) (bool, error) {
	var bound bool
	err := s.conn().QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM pa_actions, json_each(pa_actions.args_json, '$.connectors.add') AS added
		WHERE pa_actions.user_id = ? AND pa_actions.workspace_id = ? AND pa_actions.outcome = ? AND added.value = ?)`,
		userID, workspaceID, store.PersonalAgentOutcomeApplied, accountID).Scan(&bound)
	return bound, err
}

func (s *Store) RecordPersonalAgentRoutingDecision(ctx context.Context, decision store.PersonalAgentRoutingDecision) (store.PersonalAgentRoutingDecision, error) {
	if decision.UserID == "" {
		return decision, errors.New("a routing decision needs a person")
	}
	candidates, err := json.Marshal(nonNilStrings(decision.Candidates))
	if err != nil {
		return decision, err
	}
	decision.ID, decision.CreatedAt = paID("prd"), paNow()
	_, err = s.conn().ExecContext(ctx, `INSERT INTO pa_routing_decisions (id, user_id, session_id, input_id, request, request_class,
		target, workspace_id, confidence, candidates_json, corrected, corrected_workspace_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		decision.ID, decision.UserID, decision.SessionID, decision.InputID, decision.Request, decision.RequestClass, decision.Target,
		decision.WorkspaceID, decision.Confidence, string(candidates), decision.Corrected, decision.CorrectedWorkspaceID, decision.CreatedAt)
	if err != nil {
		return decision, fmt.Errorf("record personal agent routing decision: %w", err)
	}
	return decision, nil
}

func (s *Store) ListPersonalAgentRoutingDecisions(ctx context.Context, userID string, limit int) ([]store.PersonalAgentRoutingDecision, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := s.reader().QueryContext(ctx, `SELECT id, user_id, session_id, input_id, request, request_class, target, workspace_id,
		confidence, candidates_json, corrected, corrected_workspace_id, created_at FROM pa_routing_decisions WHERE user_id = ?
		ORDER BY created_at DESC, rowid DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("list personal agent routing decisions: %w", err)
	}
	defer rows.Close()
	decisions := []store.PersonalAgentRoutingDecision{}
	for rows.Next() {
		var decision store.PersonalAgentRoutingDecision
		var candidates string
		if err := rows.Scan(&decision.ID, &decision.UserID, &decision.SessionID, &decision.InputID, &decision.Request,
			&decision.RequestClass, &decision.Target, &decision.WorkspaceID, &decision.Confidence, &candidates,
			&decision.Corrected, &decision.CorrectedWorkspaceID, &decision.CreatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(candidates), &decision.Candidates); err != nil {
			return nil, fmt.Errorf("routing decision candidates: %w", err)
		}
		decisions = append(decisions, decision)
	}
	return decisions, rows.Err()
}

// activeSessionStatuses are the statuses of a session still doing work.
const activeSessionStatuses = `('queued', 'running', 'blocked')`

// assistantSessions selects the assistant's own conversations: sessions
// in its workspace no session started (its tasks' are in pa_tasks).
const assistantSessions = `SELECT id FROM agent_sessions WHERE workspace_id = ? AND parent_session_id = ''
	AND COALESCE(json_extract(payload_json, '$.source'), '') NOT IN ('digest', 'verification')`

func (s *Store) PersonalAgentUsage(ctx context.Context, agent store.PersonalAgent, windows store.PersonalAgentWindows) (store.PersonalAgentUsage, error) {
	var usage store.PersonalAgentUsage
	err := s.readSnapshot(ctx, func(db dbExecutor) error {
		counts := []struct {
			target *int
			query  string
			args   []any
		}{
			{&usage.ActiveSessions, `SELECT COUNT(*) FROM pa_tasks JOIN agent_sessions ON agent_sessions.id = pa_tasks.session_id
				WHERE pa_tasks.user_id = ? AND agent_sessions.status IN ` + activeSessionStatuses, []any{agent.UserID}},
			{&usage.SessionsToday, `SELECT COUNT(*) FROM pa_tasks WHERE user_id = ? AND session_id != '' AND created_at >= ?`,
				[]any{agent.UserID, windows.DayStart}},
			{&usage.WorkspacesToday, `SELECT COUNT(*) FROM pa_actions WHERE user_id = ? AND tool IN (?, ?) AND outcome = ? AND created_at >= ?`,
				[]any{agent.UserID, store.PersonalAgentActionCreateWorkspace, store.PersonalAgentActionRegisterFolder, store.PersonalAgentOutcomeApplied, windows.DayStart}},
			{&usage.WorkspacesThisWeek, `SELECT COUNT(*) FROM pa_actions WHERE user_id = ? AND tool IN (?, ?) AND outcome = ? AND created_at >= ?`,
				[]any{agent.UserID, store.PersonalAgentActionCreateWorkspace, store.PersonalAgentActionRegisterFolder, store.PersonalAgentOutcomeApplied, windows.WeekStart}},
			{&usage.TurnsThisHour, `SELECT COUNT(*) FROM agent_session_events WHERE session_id IN (` + assistantSessions + `)
				AND json_extract(payload_json, '$.label') = ? AND created_at >= ?`,
				[]any{agent.WorkspaceID, store.SessionInputEventLabel, windows.HourAgo}},
			{&usage.DigestSessionsToday, `SELECT COUNT(*) FROM agent_sessions WHERE json_extract(payload_json, '$.source') = ?
				AND (workspace_id = ? OR json_extract(payload_json, '$.createdByUserId') = ?) AND created_at >= ?`,
				[]any{store.DigestSessionSource, agent.WorkspaceID, agent.UserID, windows.DayStart}},
		}
		for _, count := range counts {
			if err := db.QueryRowContext(ctx, count.query, count.args...).Scan(count.target); err != nil {
				return fmt.Errorf("count personal agent usage: %w", err)
			}
		}
		// Tokens as workers report them, for the assistant's conversations
		// and the sessions it handed work to.
		return db.QueryRowContext(ctx, `SELECT COALESCE(SUM(
				COALESCE(json_extract(payload_json, '$.metadata.turnUsage.inputTokens'), 0) +
				COALESCE(json_extract(payload_json, '$.metadata.turnUsage.outputTokens'), 0)), 0)
			FROM agent_session_events WHERE created_at >= ? AND json_type(payload_json, '$.metadata.turnUsage') IS NOT NULL
			AND session_id IN (`+assistantSessions+` UNION SELECT session_id FROM pa_tasks WHERE user_id = ? AND session_id != '')`,
			windows.MonthStart, agent.WorkspaceID, agent.UserID).Scan(&usage.TokensThisMonth)
	})
	return usage, err
}

func (s *Store) PersonalAgentActiveSessions(ctx context.Context, agent store.PersonalAgent) ([]string, error) {
	rows, err := s.conn().QueryContext(ctx, `SELECT id FROM agent_sessions WHERE status IN `+activeSessionStatuses+`
		AND (id IN (`+assistantSessions+`) OR id IN (SELECT session_id FROM pa_tasks WHERE user_id = ? AND session_id != ''))
		ORDER BY created_at`, agent.WorkspaceID, agent.UserID)
	if err != nil {
		return nil, fmt.Errorf("list the assistant's active sessions: %w", err)
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
