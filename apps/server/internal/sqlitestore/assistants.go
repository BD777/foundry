package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A person's assistants (DEV-191). The table replaces personal_agents, which
// keyed the one assistant by user_id: each person's row there becomes their
// default assistant here, and the old table is kept renamed as
// personal_agents_legacy (never read again) so nothing is lost. Every
// record of an assistant carries its id as assistant_id (assistantRecordTables).

const assistantColumns = `id, owner_user_id, name, is_default, home_workspace_id, home_device_id, state, settings_json, permission_package_id, prompt_version, created_at, updated_at, stopped_at, former_workspace_ids`

func (s *Store) setupAssistants(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS assistants (
			id TEXT PRIMARY KEY,
			owner_user_id TEXT NOT NULL,
			name TEXT NOT NULL DEFAULT '',
			is_default INTEGER NOT NULL DEFAULT 0,
			home_workspace_id TEXT NOT NULL UNIQUE,
			home_device_id TEXT NOT NULL,
			state TEXT NOT NULL,
			settings_json TEXT NOT NULL,
			permission_package_id TEXT NOT NULL DEFAULT '',
			prompt_version TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			stopped_at TEXT NOT NULL DEFAULT '',
			former_workspace_ids TEXT NOT NULL DEFAULT '[]',
			digest_sent_on TEXT NOT NULL DEFAULT '',
			connector_opt_out TEXT NOT NULL DEFAULT '[]'
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_assistants_default ON assistants(owner_user_id) WHERE is_default = 1`,
		`CREATE INDEX IF NOT EXISTS idx_assistants_owner ON assistants(owner_user_id, created_at)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate assistants: %w", err)
		}
	}
	if err := s.withTx(ctx, func(tx *Store) error { return tx.migrateLegacyPersonalAgents(ctx) }); err != nil {
		return err
	}
	if _, err := s.conn().ExecContext(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_assistants_feishu_app
		ON assistants(owner_user_id, json_extract(settings_json, '$.feishuAppId'))
		WHERE coalesce(json_extract(settings_json, '$.feishuAppId'), '') <> ''`); err != nil {
		return fmt.Errorf("migrate Feishu app bindings: %w", err)
	}
	return nil
}

// migrateLegacyPersonalAgents copies every personal_agents row into
// assistants as its person's default assistant, with every column as it
// was, then renames the old table. Idempotent: a person who already has a
// default, or a workspace that already has an assistant, is skipped, and a
// database without the old table has nothing to do.
func (s *Store) migrateLegacyPersonalAgents(ctx context.Context) error {
	var legacy int
	if err := s.conn().QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'personal_agents'`).Scan(&legacy); err != nil {
		return fmt.Errorf("migrate assistants: %w", err)
	}
	if legacy == 0 {
		return nil
	}
	// Columns older databases may lack, as the earlier migrations added them.
	for _, column := range []string{
		`permission_package_id TEXT NOT NULL DEFAULT ''`,
		`prompt_version TEXT NOT NULL DEFAULT ''`,
		`stopped_at TEXT NOT NULL DEFAULT ''`,
		`former_workspace_ids TEXT NOT NULL DEFAULT '[]'`,
		`digest_sent_on TEXT NOT NULL DEFAULT ''`,
		`connector_opt_out TEXT NOT NULL DEFAULT '[]'`,
	} {
		if _, err := s.conn().ExecContext(ctx, `ALTER TABLE personal_agents ADD COLUMN `+column); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("migrate assistants: %w", err)
		}
	}
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO assistants (id, owner_user_id, name, is_default, home_workspace_id, home_device_id, state,
			settings_json, permission_package_id, prompt_version, created_at, updated_at, stopped_at, former_workspace_ids, digest_sent_on, connector_opt_out)
		SELECT 'asst_' || lower(hex(randomblob(16))), p.user_id, coalesce(json_extract(p.settings_json, '$.assistantName'), ''), 1,
			p.workspace_id, p.home_device_id, p.state, p.settings_json, p.permission_package_id, p.prompt_version, p.created_at, p.updated_at,
			p.stopped_at, p.former_workspace_ids, p.digest_sent_on, p.connector_opt_out
		FROM personal_agents p
		WHERE NOT EXISTS (SELECT 1 FROM assistants a WHERE a.owner_user_id = p.user_id AND a.is_default = 1)
			AND NOT EXISTS (SELECT 1 FROM assistants a WHERE a.home_workspace_id = p.workspace_id)`); err != nil {
		return fmt.Errorf("migrate assistants: %w", err)
	}
	var kept int
	if err := s.conn().QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE name = 'personal_agents_legacy'`).Scan(&kept); err != nil {
		return fmt.Errorf("migrate assistants: %w", err)
	}
	if kept > 0 {
		// A copy from an earlier run is already kept; this one was recreated
		// by an older binary, and its rows are in assistants now.
		if _, err := s.conn().ExecContext(ctx, `DROP TABLE personal_agents`); err != nil {
			return fmt.Errorf("migrate assistants: %w", err)
		}
		return nil
	}
	if _, err := s.conn().ExecContext(ctx, `ALTER TABLE personal_agents RENAME TO personal_agents_legacy`); err != nil {
		return fmt.Errorf("migrate assistants: %w", err)
	}
	return nil
}

// assistantRecordTables are the tables whose rows belong to one assistant.
// Each gets assistant_id, backfilled with the owner's default assistant;
// pending_items only for the items the assistant handles.
var assistantRecordTables = []struct{ table, backfillWhere string }{
	{"pa_memory", ""},
	{"pa_proposals", ""},
	{"pa_tasks", ""},
	{"pa_actions", ""},
	{"pa_routing_decisions", ""},
	{"pa_direct_chats", ""},
	{"pa_items", ""},
	{"pa_inbox", ""},
	{"pa_operations", ""},
	{"pa_run_snapshots", ""},
	{"pa_run_controls", ""},
	{"pa_maintenance", ""},
	{"pa_context_patches", ""},
	{"pending_items", ` AND handler = 'assistant'`},
}

// setupAssistantRecords adds and backfills assistant_id, and moves the
// per-person keys that mean per-assistant onto it. It runs after every
// table it touches exists, on every start.
func (s *Store) setupAssistantRecords(ctx context.Context) error {
	for _, record := range assistantRecordTables {
		if _, err := s.conn().ExecContext(ctx, `ALTER TABLE `+record.table+` ADD COLUMN assistant_id TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("migrate %s assistant: %w", record.table, err)
		}
		if _, err := s.conn().ExecContext(ctx, `UPDATE `+record.table+` SET assistant_id = coalesce((SELECT a.id FROM assistants a
			WHERE a.owner_user_id = `+record.table+`.user_id AND a.is_default = 1), '')
			WHERE assistant_id = ''`+record.backfillWhere+` AND EXISTS (SELECT 1 FROM assistants a WHERE a.owner_user_id = `+record.table+`.user_id AND a.is_default = 1)`); err != nil {
			return fmt.Errorf("backfill %s assistant: %w", record.table, err)
		}
		if record.table == "pa_direct_chats" {
			continue
		}
		if _, err := s.conn().ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_`+record.table+`_assistant ON `+record.table+`(assistant_id)`); err != nil {
			return fmt.Errorf("index %s assistant: %w", record.table, err)
		}
	}
	for _, statement := range []string{
		// One capture key per assistant, as it was one per person.
		`DROP INDEX IF EXISTS idx_pa_items_capture`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_pa_items_assistant_capture ON pa_items(assistant_id, capture_key) WHERE capture_key <> ''`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate assistant keys: %w", err)
		}
	}
	return s.withTx(ctx, func(tx *Store) error { return tx.migratePersonalAgentDirectChats(ctx) })
}

// migratePersonalAgentDirectChats moves the introduction key from the person
// to the assistant. A person may now bind each app to a different assistant,
// so one person's introductions are no longer one namespace.
func (s *Store) migratePersonalAgentDirectChats(ctx context.Context) error {
	rows, err := s.conn().QueryContext(ctx, `PRAGMA table_info(pa_direct_chats)`)
	if err != nil {
		return fmt.Errorf("read direct chat schema: %w", err)
	}
	defer rows.Close()
	assistantPK, appPK := false, false
	for rows.Next() {
		var cid, notNull, pk int
		var name, kind string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &kind, &notNull, &defaultValue, &pk); err != nil {
			return fmt.Errorf("read direct chat schema: %w", err)
		}
		if pk > 0 && name == "assistant_id" {
			assistantPK = true
		}
		if pk > 0 && name == "app_id" {
			appPK = true
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read direct chat schema: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("read direct chat schema: %w", err)
	}
	if assistantPK && appPK {
		return nil
	}
	for _, statement := range []string{
		`DROP TABLE IF EXISTS pa_direct_chats_assistant`,
		`CREATE TABLE pa_direct_chats_assistant (
			assistant_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			app_id TEXT NOT NULL,
			introduced_at TEXT NOT NULL,
			PRIMARY KEY (assistant_id, app_id)
		)`,
		`INSERT INTO pa_direct_chats_assistant (assistant_id, user_id, app_id, introduced_at)
			SELECT assistant_id, user_id, app_id, introduced_at FROM pa_direct_chats`,
		`DROP TABLE pa_direct_chats`,
		`ALTER TABLE pa_direct_chats_assistant RENAME TO pa_direct_chats`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate direct chat introductions: %w", err)
		}
	}
	return nil
}

func scanPersonalAgent(row interface{ Scan(...any) error }) (store.PersonalAgent, error) {
	var agent store.PersonalAgent
	var settings, former string
	var isDefault int
	if err := row.Scan(&agent.ID, &agent.UserID, &agent.Name, &isDefault, &agent.WorkspaceID, &agent.HomeDeviceID, &agent.State, &settings,
		&agent.PermissionPackageID, &agent.PromptVersion, &agent.CreatedAt, &agent.UpdatedAt, &agent.StoppedAt, &former); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return store.PersonalAgent{}, store.ErrNotFound
		}
		return store.PersonalAgent{}, err
	}
	agent.IsDefault = isDefault == 1
	if err := json.Unmarshal([]byte(settings), &agent.Settings); err != nil {
		return store.PersonalAgent{}, fmt.Errorf("assistant settings: %w", err)
	}
	if err := json.Unmarshal([]byte(former), &agent.FormerWorkspaceIDs); err != nil {
		return store.PersonalAgent{}, fmt.Errorf("assistant former workspaces: %w", err)
	}
	return agent, nil
}

func (s *Store) queryAssistants(ctx context.Context, where string, args ...any) ([]store.PersonalAgent, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+assistantColumns+` FROM assistants WHERE `+where, args...)
	if err != nil {
		return nil, fmt.Errorf("list assistants: %w", err)
	}
	defer rows.Close()
	agents := []store.PersonalAgent{}
	for rows.Next() {
		agent, err := scanPersonalAgent(rows)
		if err != nil {
			return nil, err
		}
		agents = append(agents, agent)
	}
	return agents, rows.Err()
}

func (s *Store) getAssistantWhere(ctx context.Context, where string, args ...any) (store.PersonalAgent, error) {
	return scanPersonalAgent(s.conn().QueryRowContext(ctx, `SELECT `+assistantColumns+` FROM assistants WHERE `+where, args...))
}

// GetPersonalAgent is the person's default assistant. Transitional
// (DEV-191 A1): see store.PersonalAgentStore.
func (s *Store) GetPersonalAgent(ctx context.Context, userID string) (store.PersonalAgent, error) {
	return s.DefaultAssistant(ctx, userID)
}

func (s *Store) DefaultAssistant(ctx context.Context, ownerUserID string) (store.PersonalAgent, error) {
	return s.getAssistantWhere(ctx, `owner_user_id = ? AND is_default = 1`, ownerUserID)
}

func (s *Store) GetAssistant(ctx context.Context, assistantID string) (store.PersonalAgent, error) {
	return s.getAssistantWhere(ctx, `id = ?`, assistantID)
}

func (s *Store) ListAssistants(ctx context.Context, ownerUserID string) ([]store.PersonalAgent, error) {
	return s.queryAssistants(ctx, `owner_user_id = ? ORDER BY is_default DESC, created_at, id`, ownerUserID)
}

func (s *Store) AssistantForWorkspace(ctx context.Context, workspaceID string) (store.PersonalAgent, error) {
	return s.getAssistantWhere(ctx, `home_workspace_id = ?`, workspaceID)
}

// AssistantForFeishuApp is the owner's assistant explicitly bound to appID.
// An empty binding is not a match: the caller falls back to the default.
func (s *Store) AssistantForFeishuApp(ctx context.Context, ownerUserID, appID string) (store.PersonalAgent, error) {
	if appID == "" {
		return store.PersonalAgent{}, store.ErrNotFound
	}
	return s.getAssistantWhere(ctx, `owner_user_id = ? AND json_extract(settings_json, '$.feishuAppId') = ?`, ownerUserID, appID)
}

func (s *Store) AssistantForSession(ctx context.Context, sessionID string) (store.PersonalAgent, error) {
	var workspaceID string
	err := s.reader().QueryRowContext(ctx, `SELECT workspace_id FROM agent_sessions WHERE id = ?`, sessionID).Scan(&workspaceID)
	if errors.Is(err, sql.ErrNoRows) {
		return store.PersonalAgent{}, store.ErrNotFound
	}
	if err != nil {
		return store.PersonalAgent{}, err
	}
	agent, err := s.getAssistantWhere(ctx, `home_workspace_id = ? OR EXISTS (SELECT 1 FROM json_each(former_workspace_ids) WHERE value = ?)
		ORDER BY home_workspace_id = ? DESC LIMIT 1`, workspaceID, workspaceID, workspaceID)
	if !errors.Is(err, store.ErrNotFound) {
		return agent, err
	}
	var assistantID string
	err = s.reader().QueryRowContext(ctx, `SELECT assistant_id FROM pa_tasks WHERE session_id = ? AND assistant_id <> ''
		UNION ALL SELECT assistant_id FROM pa_operations WHERE json_extract(payload_json, '$.sessionId') = ? AND assistant_id <> ''
		LIMIT 1`, sessionID, sessionID).Scan(&assistantID)
	if errors.Is(err, sql.ErrNoRows) {
		return store.PersonalAgent{}, store.ErrNotFound
	}
	if err != nil {
		return store.PersonalAgent{}, err
	}
	return s.GetAssistant(ctx, assistantID)
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
	var others int
	if err := s.conn().QueryRowContext(ctx, `SELECT count(*) FROM assistants WHERE owner_user_id = ?`, agent.UserID).Scan(&others); err != nil {
		return store.PersonalAgent{}, err
	}
	if others == 0 {
		agent.IsDefault = true
	} else if agent.IsDefault {
		return store.PersonalAgent{}, store.ErrPersonalAgentExists
	}
	var taken int
	if err := s.conn().QueryRowContext(ctx, `SELECT count(*) FROM assistants WHERE home_workspace_id = ?`, agent.WorkspaceID).Scan(&taken); err != nil {
		return store.PersonalAgent{}, err
	}
	if taken > 0 {
		return store.PersonalAgent{}, store.ErrPersonalAgentExists
	}
	settings, err := json.Marshal(agent.Settings)
	if err != nil {
		return store.PersonalAgent{}, err
	}
	now := paNow()
	agent.ID, agent.CreatedAt, agent.UpdatedAt = paID("asst"), now, now
	if agent.State == "" {
		agent.State = store.PersonalAgentActive
	}
	pkg, err := s.createDefaultPermissionPackage(ctx, agent.UserID)
	if err != nil {
		return store.PersonalAgent{}, err
	}
	if !agent.IsDefault {
		// A later assistant reaches no workspace, identity resource or
		// connector account until the person adds them.
		pkg.Workspaces = store.PermissionListRule{Scope: store.PermissionListScopeListed, Include: []string{}, Exclude: []string{}}
		pkg.ConnectorDefault = store.ConnectorAccessLevelOff
		pkg.IdentityResources = store.PermissionIdentityResources{Scope: store.PermissionListScopeListed, Allowed: []string{}}
		if pkg, err = s.SavePermissionPackage(ctx, pkg); err != nil {
			return store.PersonalAgent{}, err
		}
	}
	agent.PermissionPackageID = pkg.ID
	isDefault := 0
	if agent.IsDefault {
		isDefault = 1
	}
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO assistants (`+assistantColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '[]')`,
		agent.ID, agent.UserID, agent.Name, isDefault, agent.WorkspaceID, agent.HomeDeviceID, agent.State, string(settings),
		agent.PermissionPackageID, agent.PromptVersion, now, now); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return store.PersonalAgent{}, store.ErrPersonalAgentExists
		}
		return store.PersonalAgent{}, fmt.Errorf("create assistant: %w", err)
	}
	return agent, nil
}

func (s *Store) RenameAssistant(ctx context.Context, assistantID, name string) (store.PersonalAgent, error) {
	if err := s.updatePersonalAgent(ctx, assistantID, `name = ?, updated_at = ?`, strings.TrimSpace(name), paNow()); err != nil {
		return store.PersonalAgent{}, err
	}
	return s.GetAssistant(ctx, assistantID)
}

func (s *Store) DeleteAssistant(ctx context.Context, assistantID string) error {
	return s.withTx(ctx, func(tx *Store) error {
		agent, err := tx.GetAssistant(ctx, assistantID)
		if err != nil {
			return err
		}
		if agent.IsDefault {
			return store.ErrAssistantIsDefault
		}
		for _, record := range assistantRecordTables {
			switch record.table {
			case "pending_items":
				// The person's items stay theirs.
				if _, err := tx.conn().ExecContext(ctx, `UPDATE `+record.table+` SET assistant_id = '' WHERE assistant_id = ?`, assistantID); err != nil {
					return fmt.Errorf("delete assistant %s: %w", record.table, err)
				}
			default:
				if _, err := tx.conn().ExecContext(ctx, `DELETE FROM `+record.table+` WHERE assistant_id = ?`, assistantID); err != nil {
					return fmt.Errorf("delete assistant %s: %w", record.table, err)
				}
			}
		}
		if agent.PermissionPackageID != "" {
			if _, err := tx.conn().ExecContext(ctx, `DELETE FROM permission_packages WHERE id = ? AND owner_user_id = ?`, agent.PermissionPackageID, agent.UserID); err != nil {
				return fmt.Errorf("delete assistant package: %w", err)
			}
		}
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM assistants WHERE id = ?`, assistantID); err != nil {
			return fmt.Errorf("delete assistant: %w", err)
		}
		return nil
	})
}

func (s *Store) updatePersonalAgent(ctx context.Context, assistantID, set string, args ...any) error {
	result, err := s.conn().ExecContext(ctx, `UPDATE assistants SET `+set+` WHERE id = ?`, append(args, assistantID)...)
	if err != nil {
		return fmt.Errorf("update assistant: %w", err)
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return store.ErrNotFound
	}
	return nil
}
