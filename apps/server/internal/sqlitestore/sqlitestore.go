package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/secretstore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	_ "modernc.org/sqlite"
)

type Store struct {
	db   *sql.DB
	exec dbExecutor
	kek  secretstore.KEK
}

// issueSequenceStart keeps generated issue numbers in the same range the
// demo seed and earlier count-based sequencing produced.
const issueSequenceStart = 106

type Options struct {
	SeedDemo bool
	// SecretKeyPath enables the envelope-encrypted secret store: the KEK
	// file is loaded (or created), paired with the database via a sealed
	// canary, and kept in memory for request-time sealing. Empty disables
	// the feature entirely.
	SecretKeyPath string
}

func Open(path string) (*Store, error) {
	return OpenWithOptions(path, Options{})
}

func OpenWithOptions(path string, options Options) (*Store, error) {
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, fmt.Errorf("create sqlite directory: %w", err)
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)

	s := &Store{db: db}
	if err := s.configure(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := s.migrate(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	if options.SecretKeyPath != "" {
		if err := s.setupSecretStore(context.Background(), options.SecretKeyPath); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	if options.SeedDemo {
		if err := s.seedDemo(context.Background()); err != nil {
			_ = db.Close()
			return nil, err
		}
	}

	return s, nil
}

func OpenDemo(path string) (*Store, error) {
	return OpenWithOptions(path, Options{SeedDemo: true})
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) configure() error {
	statements := []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA foreign_keys = ON",
		"PRAGMA busy_timeout = 5000",
	}
	for _, statement := range statements {
		if _, err := s.db.Exec(statement); err != nil {
			return fmt.Errorf("configure sqlite %q: %w", statement, err)
		}
	}
	return nil
}

func (s *Store) migrate(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS evidence_records (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			issue_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			sequence INTEGER NOT NULL,
			payload_json TEXT NOT NULL,
			UNIQUE(issue_id, kind, sequence)
		)`,
		`CREATE INDEX IF NOT EXISTS evidence_records_issue ON evidence_records(issue_id, kind, sequence)`,
		`CREATE TABLE IF NOT EXISTS evidence_requests (
			scope TEXT NOT NULL,
			request_id TEXT NOT NULL,
			request_digest TEXT NOT NULL,
			response_json TEXT NOT NULL,
			PRIMARY KEY(scope, request_id)
		)`,
		`CREATE TABLE IF NOT EXISTS workspaces (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			local_path TEXT NOT NULL,
			baseline TEXT NOT NULL,
			context_summary TEXT NOT NULL,
			accepted_count INTEGER NOT NULL,
			resolved_count INTEGER NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS devices (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			status TEXT NOT NULL,
			last_seen_label TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		// Soft removal: a tombstoned device keeps its history rows but daemon
		// (re)registration is refused, so a reconnecting worker cannot make it
		// reappear in the available device list.
		`CREATE TABLE IF NOT EXISTS removed_devices (
			device_id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			removed_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS workspace_display_names (
			workspace_id TEXT PRIMARY KEY,
			name TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS provider_health (
			provider TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			auth_mode TEXT NOT NULL,
			secret_stored TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS agent_profiles (
			id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			runtime TEXT NOT NULL,
			status TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (device_id, id)
		)`,
		`CREATE TABLE IF NOT EXISTS agents (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			provider TEXT NOT NULL,
			status TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS workspace_files (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			path TEXT NOT NULL,
			kind TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS issues (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL DEFAULT '',
			short_id TEXT NOT NULL UNIQUE,
			title TEXT NOT NULL,
			status TEXT NOT NULL,
			priority TEXT NOT NULL,
			runtime TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS runs (
			id TEXT PRIMARY KEY,
			issue_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL,
			runtime TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS run_events (
			id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			level TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS agent_sessions (
			id TEXT PRIMARY KEY,
			thread_id TEXT NOT NULL DEFAULT '',
			workspace_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			provider TEXT NOT NULL,
			status TEXT NOT NULL,
			parent_session_id TEXT NOT NULL DEFAULT '',
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS agent_session_events (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			level TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS acceptance_artifacts (
			id TEXT PRIMARY KEY,
			issue_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS chat_titles (
			workspace_id TEXT NOT NULL,
			chat_id TEXT NOT NULL,
			title TEXT NOT NULL,
			version TEXT NOT NULL,
			generation_session_id TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (workspace_id, chat_id)
		)`,
		`CREATE TABLE IF NOT EXISTS chat_layouts (
			workspace_id TEXT PRIMARY KEY,
			revision INTEGER NOT NULL,
			payload_json TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS chat_deletions (
			workspace_id TEXT NOT NULL,
			deletion_key TEXT NOT NULL,
			PRIMARY KEY (workspace_id, deletion_key)
		)`,
		`CREATE TABLE IF NOT EXISTS chats (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS assets (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL DEFAULT '',
			name TEXT NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS skills (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			name TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS secret_records (
			id TEXT PRIMARY KEY,
			aad TEXT NOT NULL,
			ciphertext BLOB NOT NULL,
			wrapped_dek BLOB NOT NULL,
			dek_nonce BLOB NOT NULL,
			ct_nonce BLOB NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS secret_store_meta (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			canary_ciphertext BLOB NOT NULL,
			canary_wrapped_dek BLOB NOT NULL,
			canary_dek_nonce BLOB NOT NULL,
			canary_ct_nonce BLOB NOT NULL,
			kek_fingerprint TEXT NOT NULL,
			initialized_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		// Ephemeral bearer tokens minted at dispatch for the session-scoped
		// MCP/CLI surface (CHAT-01). Only SHA-256 hashes are stored; plaintext
		// lives just long enough to ride run_session to the daemon. Rows are
		// deleted when a session reaches a terminal state.
		`CREATE TABLE IF NOT EXISTS agent_session_tokens (
			session_id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL,
			created_at TEXT NOT NULL,
			last_used_at TEXT NOT NULL,
			expires_at TEXT NOT NULL
		)`,
	}
	statements = append(statements, indexStatements()...)

	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite: %w", err)
		}
	}
	if err := s.ensureColumn(ctx, "chat_titles", "generation_session_id", `ALTER TABLE chat_titles ADD COLUMN generation_session_id TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if _, err := s.conn().ExecContext(ctx, `UPDATE agent_sessions SET payload_json = json_set(payload_json, '$.answerRevision', id || ':' || COALESCE(json_extract(payload_json, '$.completedAt'), '')) WHERE json_extract(payload_json, '$.status') = 'completed' AND COALESCE(json_extract(payload_json, '$.response'), '') <> '' AND json_extract(payload_json, '$.answerRevision') IS NULL`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "assets", "workspace_id", `ALTER TABLE assets ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "issues", "workspace_id", `ALTER TABLE issues ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "runs", "workspace_id", `ALTER TABLE runs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "agent_sessions", "thread_id", `ALTER TABLE agent_sessions ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "agent_sessions", "parent_session_id", `ALTER TABLE agent_sessions ADD COLUMN parent_session_id TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if _, err := s.conn().ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_agent_sessions_parent ON agent_sessions (parent_session_id)`); err != nil {
		return fmt.Errorf("index agent session lineage: %w", err)
	}
	if err := s.backfillAgentSessionThreadIDs(ctx); err != nil {
		return err
	}
	if _, err := s.conn().ExecContext(ctx, `DROP INDEX IF EXISTS idx_agent_sessions_workspace_thread_created`); err != nil {
		return fmt.Errorf("remove superseded agent session thread index: %w", err)
	}
	if _, err := s.conn().ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace_thread_created_id ON agent_sessions (workspace_id, thread_id, created_at ASC, id ASC)`); err != nil {
		return fmt.Errorf("index agent session threads: %w", err)
	}
	if err := s.setupProfiles(ctx); err != nil {
		return err
	}
	if err := s.setupSkillCatalog(ctx); err != nil {
		return err
	}
	if err := s.setupFeishu(ctx); err != nil {
		return err
	}
	if err := s.setupAccounts(ctx); err != nil {
		return err
	}
	if err := s.setupDeviceCredentials(ctx); err != nil {
		return err
	}
	if err := s.setupOwnership(ctx); err != nil {
		return err
	}
	if err := s.backfillWorkspaceScopedRecords(ctx); err != nil {
		return err
	}
	if err := s.pruneAgentSessionInlineEvents(ctx); err != nil {
		return err
	}
	return nil
}

func (s *Store) backfillAgentSessionThreadIDs(ctx context.Context) error {
	_, err := s.conn().ExecContext(ctx, `UPDATE agent_sessions
		SET thread_id = COALESCE(
			NULLIF(TRIM(json_extract(payload_json, '$.threadId')), ''),
			NULLIF(TRIM(json_extract(payload_json, '$.nativeSessionId')), ''),
			id
		)
		WHERE thread_id = ''`)
	if err != nil {
		return fmt.Errorf("backfill agent session thread ids: %w", err)
	}
	return nil
}

func (s *Store) ensureColumn(ctx context.Context, table string, column string, statement string) error {
	rows, err := s.conn().QueryContext(ctx, fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return fmt.Errorf("inspect %s columns: %w", table, err)
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name string
		var columnType string
		var notNull int
		var defaultValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &pk); err != nil {
			return fmt.Errorf("scan %s column: %w", table, err)
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("inspect %s columns: %w", table, err)
	}
	if _, err := s.conn().ExecContext(ctx, statement); err != nil {
		return fmt.Errorf("add %s.%s: %w", table, column, err)
	}
	return nil
}

func (s *Store) backfillWorkspaceScopedRecords(ctx context.Context) error {
	if _, err := s.conn().ExecContext(ctx, `UPDATE issues
		SET workspace_id = COALESCE(json_extract(payload_json, '$.workspaceId'), '')
		WHERE workspace_id = ''`); err != nil {
		return fmt.Errorf("backfill issue workspace ids: %w", err)
	}
	if _, err := s.conn().ExecContext(ctx, `UPDATE runs
		SET workspace_id = COALESCE(json_extract(payload_json, '$.workspaceId'), '')
		WHERE workspace_id = ''`); err != nil {
		return fmt.Errorf("backfill run workspace ids: %w", err)
	}
	defaultWorkspaceID := s.defaultWorkspaceID(ctx)
	if defaultWorkspaceID != "" {
		if _, err := s.conn().ExecContext(ctx, `UPDATE issues SET workspace_id = ? WHERE workspace_id = ''`, defaultWorkspaceID); err != nil {
			return fmt.Errorf("assign legacy issue workspace ids: %w", err)
		}
	}
	if _, err := s.conn().ExecContext(ctx, `UPDATE runs
		SET workspace_id = (
			SELECT issues.workspace_id FROM issues WHERE issues.id = runs.issue_id
		)
		WHERE workspace_id = ''
			AND EXISTS (
				SELECT 1 FROM issues WHERE issues.id = runs.issue_id AND issues.workspace_id != ''
			)`); err != nil {
		return fmt.Errorf("assign run workspace ids from issues: %w", err)
	}
	if defaultWorkspaceID != "" {
		if _, err := s.conn().ExecContext(ctx, `UPDATE runs SET workspace_id = ? WHERE workspace_id = ''`, defaultWorkspaceID); err != nil {
			return fmt.Errorf("assign legacy run workspace ids: %w", err)
		}
	}
	return nil
}

func (s *Store) pruneAgentSessionInlineEvents(ctx context.Context) error {
	if _, err := s.conn().ExecContext(ctx, `UPDATE agent_sessions
		SET payload_json = json_remove(payload_json, '$.events')
		WHERE json_type(payload_json, '$.events') IS NOT NULL`); err != nil {
		return fmt.Errorf("prune inline agent session events: %w", err)
	}
	return nil
}

func (s *Store) defaultWorkspaceID(ctx context.Context) string {
	var id string
	if err := s.conn().QueryRowContext(ctx, `SELECT id FROM workspaces ORDER BY updated_at DESC, name LIMIT 1`).Scan(&id); err != nil {
		return ""
	}
	return id
}

func (s *Store) workspaceIDForDevice(ctx context.Context, deviceID string) string {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return s.defaultWorkspaceID(ctx)
	}
	var id string
	if err := s.conn().QueryRowContext(ctx, `SELECT id FROM workspaces
		WHERE json_extract(payload_json, '$.deviceId') = ?
		ORDER BY updated_at DESC, name LIMIT 1`, deviceID).Scan(&id); err != nil {
		return ""
	}
	return id
}

func (s *Store) ListWorkspaces(ctx context.Context) ([]store.WorkspaceProjection, error) {
	return listJSON[store.WorkspaceProjection](ctx, s.conn(), `SELECT
		CASE WHEN d.name IS NULL THEN w.payload_json ELSE json_set(w.payload_json, '$.name', d.name) END
		FROM workspaces w LEFT JOIN workspace_display_names d ON d.workspace_id = w.id
		ORDER BY w.updated_at DESC, w.name`)
}

func (s *Store) GetWorkspace(ctx context.Context, id string) (store.WorkspaceProjection, error) {
	return getJSON[store.WorkspaceProjection](ctx, s.conn(), `SELECT
		CASE WHEN d.name IS NULL THEN w.payload_json ELSE json_set(w.payload_json, '$.name', d.name) END
		FROM workspaces w LEFT JOIN workspace_display_names d ON d.workspace_id = w.id WHERE w.id = ?`, id)
}

// Display names belong to the server, independently of daemon folder snapshots.
// Renaming never moves a folder or changes the workspace identity.
func (s *Store) RenameWorkspace(ctx context.Context, id string, name string) (store.WorkspaceProjection, error) {
	if _, err := s.GetWorkspace(ctx, id); err != nil {
		return store.WorkspaceProjection{}, err
	}
	_, err := s.conn().ExecContext(ctx, `INSERT INTO workspace_display_names (workspace_id, name)
		SELECT id, ? FROM workspaces WHERE id = ?
		ON CONFLICT(workspace_id) DO UPDATE SET name = excluded.name`, name, id)
	if err != nil {
		return store.WorkspaceProjection{}, err
	}
	return s.GetWorkspace(ctx, id)
}

func (s *Store) DeleteWorkspace(ctx context.Context, id string) (store.WorkspaceProjection, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return store.WorkspaceProjection{}, store.ErrNotFound
	}
	workspace, err := s.GetWorkspace(ctx, id)
	if err != nil {
		return store.WorkspaceProjection{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return store.WorkspaceProjection{}, err
	}
	defer tx.Rollback()

	var active int
	if err := tx.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM runs WHERE workspace_id = ? AND status NOT IN ('completed','failed','canceled','cancelled')) +
		(SELECT count(*) FROM agent_sessions WHERE workspace_id = ? AND status NOT IN ('completed','failed','canceled','cancelled'))`,
		id, id).Scan(&active); err != nil {
		return store.WorkspaceProjection{}, err
	}
	if active > 0 {
		return store.WorkspaceProjection{}, store.ErrWorkspaceBusy
	}

	statements := []struct {
		label string
		query string
	}{
		{
			label: "delete workspace run events",
			query: `DELETE FROM run_events
				WHERE run_id IN (SELECT id FROM runs WHERE workspace_id = ?)`,
		},
		{
			label: "delete workspace agent session events",
			query: `DELETE FROM agent_session_events
				WHERE session_id IN (SELECT id FROM agent_sessions WHERE workspace_id = ?)`,
		},
		{
			label: "delete workspace acceptance artifacts",
			query: `DELETE FROM acceptance_artifacts
				WHERE issue_id IN (SELECT id FROM issues WHERE workspace_id = ?)`,
		},
		{
			label: "delete workspace runs",
			query: `DELETE FROM runs WHERE workspace_id = ?`,
		},
		{
			label: "delete workspace issues",
			query: `DELETE FROM issues WHERE workspace_id = ?`,
		},
		{
			label: "delete workspace agent sessions",
			query: `DELETE FROM agent_sessions WHERE workspace_id = ?`,
		},
		{
			label: "delete workspace chats",
			query: `DELETE FROM chats
				WHERE json_extract(payload_json, '$.workspaceId') = ?`,
		},
		{label: "delete workspace chat titles", query: `DELETE FROM chat_titles WHERE workspace_id = ?`},
		{label: "delete workspace chat layout", query: `DELETE FROM chat_layouts WHERE workspace_id = ?`},
		{label: "delete workspace chat deletion markers", query: `DELETE FROM chat_deletions WHERE workspace_id = ?`},
		{label: "delete workspace display name", query: `DELETE FROM workspace_display_names WHERE workspace_id = ?`},
		{
			label: "delete workspace agents",
			query: `DELETE FROM agents WHERE workspace_id = ?`,
		},
		{
			label: "delete workspace files",
			query: `DELETE FROM workspace_files WHERE workspace_id = ?`,
		},
		{
			label: "delete workspace assets",
			query: `DELETE FROM assets WHERE workspace_id = ?`,
		},
		{
			label: "delete workspace skills",
			query: `DELETE FROM skills WHERE workspace_id = ?`,
		},
		{
			label: "delete workspace row",
			query: `DELETE FROM workspaces WHERE id = ?`,
		},
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement.query, id); err != nil {
			return store.WorkspaceProjection{}, fmt.Errorf("%s: %w", statement.label, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return store.WorkspaceProjection{}, fmt.Errorf("delete workspace: %w", err)
	}
	return workspace, nil
}

func (s *Store) ListDevices(ctx context.Context) ([]store.DeviceProjection, error) {
	// Tombstoned devices keep their rows (history views still resolve their
	// label) but are projected as "removed" so the UI can hide them from the
	// available device list and mark them elsewhere.
	return listJSON[store.DeviceProjection](ctx, s.conn(), `SELECT
		CASE WHEN r.device_id IS NULL THEN d.payload_json ELSE
			json_set(json_set(d.payload_json, '$.status', 'removed'),
				'$.lastSeenLabel', 'Removed from Foundry')
		END
		FROM devices d
		LEFT JOIN removed_devices r ON r.device_id = d.id
		ORDER BY d.label`)
}

func (s *Store) ListProviderHealth(ctx context.Context, deviceID string) ([]store.ProviderHealth, error) {
	providers, err := listJSON[store.ProviderHealth](ctx, s.conn(), `SELECT payload_json FROM provider_health ORDER BY provider`)
	if err != nil {
		return nil, err
	}
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return providers, nil
	}
	filtered := providers[:0]
	for _, provider := range providers {
		if provider.DeviceID == deviceID {
			filtered = append(filtered, provider)
		}
	}
	return filtered, nil
}

func (s *Store) ListAgentProfiles(ctx context.Context, deviceID string) ([]store.AgentProfileProjection, error) {
	if deviceID != "" {
		return listJSON[store.AgentProfileProjection](ctx, s.conn(), `SELECT payload_json FROM agent_profiles WHERE device_id = ? ORDER BY runtime, id`, deviceID)
	}
	return listJSON[store.AgentProfileProjection](ctx, s.conn(), `SELECT payload_json FROM agent_profiles ORDER BY device_id, runtime, id`)
}

func (s *Store) ListAgents(ctx context.Context, workspaceID string, deviceID string) ([]store.AgentProjection, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	deviceID = strings.TrimSpace(deviceID)
	if workspaceID != "" && deviceID != "" {
		return listJSON[store.AgentProjection](ctx, s.conn(), `SELECT payload_json FROM agents WHERE workspace_id = ? AND device_id = ? ORDER BY updated_at DESC, provider`, workspaceID, deviceID)
	}
	if workspaceID != "" {
		return listJSON[store.AgentProjection](ctx, s.conn(), `SELECT payload_json FROM agents WHERE workspace_id = ? ORDER BY updated_at DESC, provider`, workspaceID)
	}
	if deviceID != "" {
		return listJSON[store.AgentProjection](ctx, s.conn(), `SELECT payload_json FROM agents WHERE device_id = ? ORDER BY updated_at DESC, provider`, deviceID)
	}
	return listJSON[store.AgentProjection](ctx, s.conn(), `SELECT payload_json FROM agents ORDER BY updated_at DESC, provider`)
}

func (s *Store) ListWorkspaceFiles(ctx context.Context, workspaceID string) ([]store.WorkspaceFileEntry, error) {
	if workspaceID == "" {
		return listJSON[store.WorkspaceFileEntry](ctx, s.conn(), `SELECT payload_json FROM workspace_files ORDER BY path`)
	}
	return listJSON[store.WorkspaceFileEntry](ctx, s.conn(), `SELECT payload_json FROM workspace_files WHERE workspace_id = ? ORDER BY path`, workspaceID)
}

func (s *Store) ListAssets(ctx context.Context, workspaceID string) ([]store.AssetProjection, error) {
	if workspaceID != "" {
		return listJSON[store.AssetProjection](ctx, s.conn(), `SELECT payload_json FROM assets WHERE workspace_id = ? ORDER BY name`, workspaceID)
	}
	return listJSON[store.AssetProjection](ctx, s.conn(), `SELECT payload_json FROM assets ORDER BY name`)
}

func (s *Store) ListSkills(ctx context.Context, workspaceID string) ([]store.SkillPackRef, error) {
	if workspaceID != "" {
		return listJSON[store.SkillPackRef](ctx, s.conn(), `SELECT payload_json FROM skills WHERE workspace_id = ? ORDER BY name`, workspaceID)
	}
	return listJSON[store.SkillPackRef](ctx, s.conn(), `SELECT payload_json FROM skills ORDER BY workspace_id, name`)
}

func (s *Store) ListChats(ctx context.Context, workspaceID string) ([]store.ChatThread, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	chats, err := listJSON[store.ChatThread](ctx, s.conn(), `SELECT json_remove(payload_json, '$.handoffContext', '$.recentMessages', '$.transcript') FROM chats
		WHERE (? = '' OR json_extract(payload_json, '$.workspaceId') = ? OR json_extract(payload_json, '$.workspaceId') IS NULL)
		AND `+visibleChatSQL+` ORDER BY updated_at DESC`, workspaceID, workspaceID)
	if err != nil {
		return nil, err
	}
	claimed, err := s.claimedNativeChatKeys(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	return filterClaimedNativeChats(chats, claimed), nil
}

func (s *Store) GetChat(ctx context.Context, id string) (store.ChatThread, error) {
	chat, err := getJSON[store.ChatThread](ctx, s.conn(), `SELECT payload_json FROM chats WHERE id = ? AND `+visibleChatSQL, id)
	if err != nil {
		return store.ChatThread{}, err
	}
	claimed, err := s.claimedNativeChatKeys(ctx, chat.WorkspaceID)
	if err != nil {
		return store.ChatThread{}, err
	}
	if claimed[nativeChatKey(chat.Provider, chat.NativeSessionID)] {
		return store.ChatThread{}, store.ErrNotFound
	}
	return chat, nil
}

// nextIssueSequence returns one past the highest numeric suffix already used by
// an issue id or short id, so deleting an issue can never hand its number to a
// new one. Callers must hold the surrounding transaction.
func (s *Store) nextIssueSequence(ctx context.Context) (int, error) {
	var highest sql.NullInt64
	if err := s.conn().QueryRowContext(ctx, `SELECT MAX(sequence) FROM (
			SELECT CAST(substr(id, 5) AS INTEGER) AS sequence FROM issues
				WHERE substr(id, 1, 4) = 'iss_' AND substr(id, 5) GLOB '[0-9]*'
			UNION ALL
			SELECT CAST(substr(short_id, 5) AS INTEGER) AS sequence FROM issues
				WHERE substr(short_id, 1, 4) = 'ISS-' AND substr(short_id, 5) GLOB '[0-9]*'
		)`).Scan(&highest); err != nil {
		return 0, fmt.Errorf("next issue sequence: %w", err)
	}
	next := issueSequenceStart
	if highest.Valid && int(highest.Int64) >= next {
		next = int(highest.Int64) + 1
	}
	return next, nil
}

func (s *Store) saveIssue(ctx context.Context, issue store.Issue, createdAt time.Time, updatedAt time.Time) error {
	payload, err := encode(issue)
	if err != nil {
		return err
	}
	if createdAt.IsZero() {
		createdAt = updatedAt
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO issues
		(id, workspace_id, short_id, title, status, priority, runtime, payload_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			workspace_id = excluded.workspace_id,
			title = excluded.title,
			status = excluded.status,
			priority = excluded.priority,
			runtime = excluded.runtime,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at`,
		issue.ID,
		issue.WorkspaceID,
		issue.ShortID,
		issue.Title,
		issue.Status,
		issue.Priority,
		issue.Runtime,
		payload,
		formatTime(createdAt),
		formatTime(updatedAt),
	)
	if err != nil {
		return fmt.Errorf("save issue: %w", err)
	}
	return nil
}

func (s *Store) saveWorkspace(ctx context.Context, value store.WorkspaceProjection, updatedAt time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO workspaces
		(id, name, local_path, baseline, context_summary, accepted_count, resolved_count, payload_json, updated_at, device_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			device_id = excluded.device_id,
			name = excluded.name,
			local_path = excluded.local_path,
			baseline = excluded.baseline,
			context_summary = excluded.context_summary,
			accepted_count = excluded.accepted_count,
			resolved_count = excluded.resolved_count,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at`,
		value.ID,
		value.Name,
		value.LocalPath,
		value.Baseline,
		value.ContextSummary,
		value.AcceptedCount,
		value.ResolvedCount,
		payload,
		formatTime(updatedAt),
		value.DeviceID,
	)
	if err != nil {
		return fmt.Errorf("save workspace: %w", err)
	}
	return nil
}

func (s *Store) saveDevice(ctx context.Context, value store.DeviceProjection, updatedAt time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO devices
		(id, label, status, last_seen_label, payload_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			label = excluded.label,
			status = excluded.status,
			last_seen_label = excluded.last_seen_label,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at`,
		value.ID,
		value.Label,
		value.Status,
		value.LastSeenLabel,
		payload,
		formatTime(updatedAt),
	)
	if err != nil {
		return fmt.Errorf("save device: %w", err)
	}
	return nil
}

func (s *Store) saveChat(ctx context.Context, value store.ChatThread, updatedAt time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO chats
		(id, title, payload_json, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			title = excluded.title,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at`,
		value.ID,
		value.Title,
		payload,
		formatTime(updatedAt),
	)
	if err != nil {
		return fmt.Errorf("save chat: %w", err)
	}
	return nil
}

func (s *Store) saveChatIfChanged(ctx context.Context, value store.ChatThread, updatedAt time.Time) error {
	deleted, err := s.chatDeleted(ctx, value.WorkspaceID, value.ID, value.Provider, value.NativeSessionID)
	if err != nil {
		return err
	}
	if deleted {
		// A deleted, previously unloaded projection may reveal its native ID on
		// the next sync. Retain that identity too so later aliases stay deleted.
		if value.Provider != "" && value.NativeSessionID != "" {
			_, err = s.conn().ExecContext(ctx, `INSERT OR IGNORE INTO chat_deletions(workspace_id, deletion_key) VALUES (?, ?)`, value.WorkspaceID, "native:"+value.Provider+":"+value.NativeSessionID)
		}
		return err
	}
	if value.NativeSessionID != "" {
		claimed, err := s.claimedNativeChatKeys(ctx, value.WorkspaceID)
		if err != nil {
			return err
		}
		if claimed[nativeChatKey(value.Provider, value.NativeSessionID)] {
			return s.deleteNativeChat(ctx, value.WorkspaceID, value.Provider, value.NativeSessionID)
		}
	}

	payload, err := encode(value)
	if err != nil {
		return err
	}

	var current string
	err = s.conn().QueryRowContext(ctx, `SELECT payload_json FROM chats WHERE id = ?`, value.ID).Scan(&current)
	// During a rolling worker upgrade, unchanged legacy snapshots must not erase
	// structured detail already synced by a newer worker. Changed history falls
	// back to its legacy display until it is imported again.
	if err == nil && value.Transcript == nil {
		var previous store.ChatThread
		if json.Unmarshal([]byte(current), &previous) == nil &&
			previous.HandoffContext == value.HandoffContext && previous.AnswerRevision == value.AnswerRevision {
			value.Transcript = previous.Transcript
			payload, err = encode(value)
			if err != nil {
				return err
			}
		}
	}
	if err == nil && current == payload {
		return nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read chat: %w", err)
	}

	_, err = s.conn().ExecContext(ctx, `INSERT INTO chats
		(id, title, payload_json, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			title = excluded.title,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at`,
		value.ID,
		value.Title,
		payload,
		formatTime(updatedAt),
	)
	if err != nil {
		return fmt.Errorf("save chat: %w", err)
	}
	return nil
}

func nativeChatKey(provider string, nativeSessionID string) string {
	provider = strings.TrimSpace(provider)
	nativeSessionID = strings.TrimSpace(nativeSessionID)
	if provider == "" || nativeSessionID == "" {
		return ""
	}
	return provider + "\x00" + nativeSessionID
}

func (s *Store) claimedNativeChatKeys(ctx context.Context, workspaceID string) (map[string]bool, error) {
	query := `SELECT
		COALESCE(json_extract(payload_json, '$.source'), ''),
		COALESCE(provider, ''),
		COALESCE(json_extract(payload_json, '$.nativeSessionId'), '')
		FROM agent_sessions`
	args := []any{}
	if workspaceID = strings.TrimSpace(workspaceID); workspaceID != "" {
		query += ` WHERE workspace_id = ?`
		args = append(args, workspaceID)
	}
	rows, err := s.conn().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	claimed := map[string]bool{}
	for rows.Next() {
		var source, provider, nativeSessionID string
		if err := rows.Scan(&source, &provider, &nativeSessionID); err != nil {
			return nil, err
		}
		if !isChatSessionSource(source) && source != "naming" {
			continue
		}
		key := nativeChatKey(provider, nativeSessionID)
		if key == "" {
			continue
		}
		claimed[key] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return claimed, nil
}

func filterClaimedNativeChats(chats []store.ChatThread, claimed map[string]bool) []store.ChatThread {
	if len(chats) == 0 || len(claimed) == 0 {
		return chats
	}
	filtered := chats[:0]
	for _, chat := range chats {
		key := nativeChatKey(chat.Provider, chat.NativeSessionID)
		if key != "" && claimed[key] {
			continue
		}
		filtered = append(filtered, chat)
	}
	return filtered
}

func isChatSessionSource(source string) bool {
	return source == "" || source == "chat"
}

func (s *Store) deleteClaimedNativeChat(ctx context.Context, session store.AgentSession) error {
	if (!isChatSessionSource(session.Source) && session.Source != "naming") || session.NativeSessionID == "" {
		return nil
	}
	return s.deleteNativeChat(ctx, session.WorkspaceID, session.Provider, session.NativeSessionID)
}

func (s *Store) deleteNativeChat(ctx context.Context, workspaceID string, provider string, nativeSessionID string) error {
	provider = strings.TrimSpace(provider)
	nativeSessionID = strings.TrimSpace(nativeSessionID)
	if provider == "" || nativeSessionID == "" {
		return nil
	}
	_, err := s.conn().ExecContext(ctx, `DELETE FROM chats
		WHERE json_extract(payload_json, '$.provider') = ?
			AND json_extract(payload_json, '$.nativeSessionId') = ?
			AND (? = '' OR json_extract(payload_json, '$.workspaceId') = ?)`,
		provider,
		nativeSessionID,
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(workspaceID),
	)
	if err != nil {
		return fmt.Errorf("delete native chat: %w", err)
	}
	return nil
}

func (s *Store) saveProviderHealth(ctx context.Context, value store.ProviderHealth, updatedAt time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	dbID := value.Provider
	if value.DeviceID != "" {
		dbID = value.DeviceID + ":" + value.Provider
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO provider_health
		(provider, status, auth_mode, secret_stored, payload_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(provider) DO UPDATE SET
			status = excluded.status,
			auth_mode = excluded.auth_mode,
			secret_stored = excluded.secret_stored,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at`,
		dbID,
		value.Status,
		value.AuthMode,
		value.SecretStored,
		payload,
		formatTime(updatedAt),
	)
	if err != nil {
		return fmt.Errorf("save provider health: %w", err)
	}
	return nil
}

// replaceDeviceProviderHealth makes a daemon report authoritative for its
// device's providers. Rows are keyed `<deviceId>:<provider>`, so a provider the
// machine no longer has is deleted by prefix rather than left to age.
func (s *Store) replaceDeviceProviderHealth(ctx context.Context, deviceID string, health []store.ProviderHealth, updatedAt time.Time) error {
	keep := []any{deviceID + ":%"}
	placeholders := make([]string, 0, len(health))
	for _, provider := range health {
		if provider.DeviceID == "" {
			provider.DeviceID = deviceID
		}
		if err := s.saveProviderHealth(ctx, provider, updatedAt); err != nil {
			return err
		}
		keep = append(keep, provider.DeviceID+":"+provider.Provider)
		placeholders = append(placeholders, "?")
	}
	query := `DELETE FROM provider_health WHERE provider LIKE ?`
	if len(placeholders) > 0 {
		query += ` AND provider NOT IN (` + strings.Join(placeholders, ",") + `)`
	}
	if _, err := s.conn().ExecContext(ctx, query, keep...); err != nil {
		return fmt.Errorf("replace device provider health: %w", err)
	}
	return nil
}

func (s *Store) saveAgentProfile(ctx context.Context, value store.AgentProfileProjection, updatedAt time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO agent_profiles
		(id, device_id, runtime, status, payload_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(device_id, id) DO UPDATE SET
			runtime = excluded.runtime,
			status = excluded.status,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at`,
		value.ID,
		value.DeviceID,
		value.Runtime,
		value.Status,
		payload,
		formatTime(updatedAt),
	)
	if err != nil {
		return fmt.Errorf("save agent profile: %w", err)
	}
	return nil
}

// replaceDeviceAgentProfiles makes a daemon report authoritative for its
// device. A registration carries the machine's complete profile set, so a
// profile the user removed from local configuration — or an endpoint variable
// they unset — has to disappear here too instead of lingering as a phantom row
// nobody can delete.
func (s *Store) replaceDeviceAgentProfiles(ctx context.Context, deviceID string, profiles []store.AgentProfileProjection, updatedAt time.Time) error {
	keep := make([]any, 0, len(profiles)+1)
	keep = append(keep, deviceID)
	placeholders := make([]string, 0, len(profiles))
	for _, profile := range profiles {
		if profile.DeviceID == "" {
			profile.DeviceID = deviceID
		}
		if err := s.saveAgentProfile(ctx, profile, updatedAt); err != nil {
			return err
		}
		keep = append(keep, profile.ID)
		placeholders = append(placeholders, "?")
	}
	query := `DELETE FROM agent_profiles WHERE device_id = ?`
	if len(placeholders) > 0 {
		query += ` AND id NOT IN (` + strings.Join(placeholders, ",") + `)`
	}
	if _, err := s.conn().ExecContext(ctx, query, keep...); err != nil {
		return fmt.Errorf("replace device agent profiles: %w", err)
	}
	return nil
}

func (s *Store) getAgent(ctx context.Context, id string, workspaceID string, provider string) (store.AgentProjection, error) {
	if id != "" {
		return getJSON[store.AgentProjection](ctx, s.conn(), `SELECT payload_json FROM agents WHERE id = ?`, id)
	}
	if workspaceID != "" && provider != "" {
		return getJSON[store.AgentProjection](ctx, s.conn(), `SELECT payload_json FROM agents WHERE workspace_id = ? AND provider = ? ORDER BY updated_at DESC LIMIT 1`, workspaceID, provider)
	}
	return store.AgentProjection{}, store.ErrNotFound
}

func (s *Store) saveAgent(ctx context.Context, value store.AgentProjection, updatedAt time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO agents
		(id, workspace_id, device_id, provider, status, payload_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			workspace_id = excluded.workspace_id,
			device_id = excluded.device_id,
			provider = excluded.provider,
			status = excluded.status,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at`,
		value.ID,
		value.WorkspaceID,
		value.DeviceID,
		value.Provider,
		value.Status,
		payload,
		formatTime(updatedAt),
	)
	if err != nil {
		return fmt.Errorf("save agent: %w", err)
	}
	return nil
}

func (s *Store) replaceWorkspaceAgents(ctx context.Context, workspaceID string, deviceID string, agents []store.AgentProjection, updatedAt time.Time) error {
	if workspaceID == "" || deviceID == "" {
		return nil
	}
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM agents WHERE workspace_id = ? AND device_id = ?`, workspaceID, deviceID); err != nil {
		return fmt.Errorf("clear workspace agents: %w", err)
	}
	for _, agent := range agents {
		if agent.WorkspaceID == "" {
			agent.WorkspaceID = workspaceID
		}
		if agent.DeviceID == "" {
			agent.DeviceID = deviceID
		}
		if err := s.saveAgent(ctx, agent, updatedAt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) replaceWorkspaceFiles(ctx context.Context, workspaceID string, files []store.WorkspaceFileEntry, updatedAt time.Time) error {
	if workspaceID == "" {
		return nil
	}
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM workspace_files WHERE workspace_id = ?`, workspaceID); err != nil {
		return fmt.Errorf("clear workspace files: %w", err)
	}
	for _, file := range files {
		if file.WorkspaceID == "" {
			file.WorkspaceID = workspaceID
		}
		if err := s.saveWorkspaceFile(ctx, file, updatedAt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) replaceWorkspaceAssets(ctx context.Context, workspaceID string, assets []store.AssetProjection, updatedAt time.Time) error {
	if workspaceID == "" {
		return nil
	}
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM assets WHERE workspace_id = ?`, workspaceID); err != nil {
		return fmt.Errorf("clear workspace assets: %w", err)
	}
	for _, asset := range assets {
		if asset.WorkspaceID == "" {
			asset.WorkspaceID = workspaceID
		}
		if err := s.saveAsset(ctx, asset, updatedAt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) replaceWorkspaceSkills(ctx context.Context, workspaceID string, skills []store.SkillPackRef, updatedAt time.Time) error {
	if workspaceID == "" {
		return nil
	}
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM skills WHERE workspace_id = ?`, workspaceID); err != nil {
		return fmt.Errorf("clear workspace skills: %w", err)
	}
	for _, skill := range skills {
		if skill.WorkspaceID == "" {
			skill.WorkspaceID = workspaceID
		}
		if skill.Scope == "" {
			skill.Scope = "workspace"
		}
		if err := s.saveSkill(ctx, skill, updatedAt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) saveWorkspaceFile(ctx context.Context, value store.WorkspaceFileEntry, updatedAt time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO workspace_files
		(id, workspace_id, path, kind, payload_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			workspace_id = excluded.workspace_id,
			path = excluded.path,
			kind = excluded.kind,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at`,
		value.ID,
		value.WorkspaceID,
		value.Path,
		value.Kind,
		payload,
		formatTime(updatedAt),
	)
	if err != nil {
		return fmt.Errorf("save workspace file: %w", err)
	}
	return nil
}

func (s *Store) saveAsset(ctx context.Context, value store.AssetProjection, updatedAt time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	dbID := value.ID
	if value.WorkspaceID != "" {
		dbID = value.WorkspaceID + ":" + value.ID
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO assets
		(id, workspace_id, name, kind, status, payload_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			workspace_id = excluded.workspace_id,
			name = excluded.name,
			kind = excluded.kind,
			status = excluded.status,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at`,
		dbID,
		value.WorkspaceID,
		value.Name,
		value.Kind,
		value.Status,
		payload,
		formatTime(updatedAt),
	)
	if err != nil {
		return fmt.Errorf("save asset: %w", err)
	}
	return nil
}

func (s *Store) saveSkill(ctx context.Context, value store.SkillPackRef, updatedAt time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	dbID := value.ID
	if value.WorkspaceID != "" {
		dbID = value.WorkspaceID + ":" + value.ID
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO skills
		(id, workspace_id, name, payload_json, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			workspace_id = excluded.workspace_id,
			name = excluded.name,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at`,
		dbID,
		value.WorkspaceID,
		value.Name,
		payload,
		formatTime(updatedAt),
	)
	if err != nil {
		return fmt.Errorf("save skill: %w", err)
	}
	return nil
}

func (s *Store) attachAgentSessionEvents(ctx context.Context, session *store.AgentSession) error {
	events, err := listJSON[store.AgentSessionEvent](ctx, s.conn(), `SELECT payload_json FROM agent_session_events WHERE session_id = ? ORDER BY created_at ASC`, session.ID)
	if err != nil {
		return err
	}
	session.Events = events
	return nil
}

func (s *Store) saveAgentSession(ctx context.Context, value store.AgentSession, createdAt time.Time, updatedAt time.Time) error {
	value.Events = nil
	payload, err := encode(value)
	if err != nil {
		return err
	}
	if createdAt.IsZero() {
		createdAt = updatedAt
	}
	threadID := strings.TrimSpace(value.ThreadID)
	if threadID == "" {
		threadID = strings.TrimSpace(value.NativeSessionID)
	}
	if threadID == "" {
		threadID = value.ID
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO agent_sessions
		(id, thread_id, workspace_id, agent_id, device_id, provider, status, parent_session_id, payload_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			thread_id = excluded.thread_id,
			workspace_id = excluded.workspace_id,
			agent_id = excluded.agent_id,
			device_id = excluded.device_id,
			provider = excluded.provider,
			status = excluded.status,
			parent_session_id = excluded.parent_session_id,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at`,
		value.ID,
		threadID,
		value.WorkspaceID,
		value.AgentID,
		value.DeviceID,
		value.Provider,
		value.Status,
		strings.TrimSpace(value.ParentSessionID),
		payload,
		formatTime(createdAt),
		formatTime(updatedAt),
	)
	if err != nil {
		return fmt.Errorf("save agent session: %w", err)
	}
	// A session reaching a terminal state can no longer drive the MCP/CLI
	// surface; revoke its dispatch token in the same transaction.
	if isTerminalAgentSession(value.Status) {
		if _, err := s.conn().ExecContext(ctx, `DELETE FROM agent_session_tokens WHERE session_id = ?`, value.ID); err != nil {
			return fmt.Errorf("revoke agent session token: %w", err)
		}
	}
	return nil
}

func (s *Store) saveAgentSessionEvent(ctx context.Context, value store.AgentSessionEvent, createdAt time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO agent_session_events
		(id, session_id, level, payload_json, created_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			level = excluded.level,
			payload_json = excluded.payload_json,
			created_at = excluded.created_at`,
		value.ID,
		value.SessionID,
		value.Level,
		payload,
		formatTime(createdAt),
	)
	if err != nil {
		return fmt.Errorf("save agent session event: %w", err)
	}
	return nil
}

func (s *Store) getRun(ctx context.Context, id string) (store.Run, error) {
	return getJSON[store.Run](ctx, s.conn(), `SELECT payload_json FROM runs WHERE id = ?`, id)
}

func (s *Store) saveRun(ctx context.Context, value store.Run, updatedAt time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO runs
		(id, issue_id, workspace_id, status, runtime, payload_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			issue_id = excluded.issue_id,
			workspace_id = excluded.workspace_id,
			status = excluded.status,
			runtime = excluded.runtime,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at`,
		value.ID,
		value.IssueID,
		value.WorkspaceID,
		value.Status,
		value.Runtime,
		payload,
		formatTime(updatedAt),
	)
	if err != nil {
		return fmt.Errorf("save run: %w", err)
	}
	return nil
}

func (s *Store) saveRunEvent(ctx context.Context, value store.RunEvent, createdAt time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO run_events
		(id, run_id, level, payload_json, created_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			level = excluded.level,
			payload_json = excluded.payload_json`,
		value.ID,
		value.RunID,
		value.Level,
		payload,
		formatTime(createdAt),
	)
	if err != nil {
		return fmt.Errorf("save run event: %w", err)
	}
	return nil
}

func (s *Store) saveArtifact(ctx context.Context, value store.AcceptanceArtifact, updatedAt time.Time) error {
	payload, err := encode(value)
	if err != nil {
		return err
	}
	_, err = s.conn().ExecContext(ctx, `INSERT INTO acceptance_artifacts
		(id, issue_id, kind, payload_json, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			issue_id = excluded.issue_id,
			kind = excluded.kind,
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at`,
		value.ID,
		value.IssueID,
		value.Kind,
		payload,
		formatTime(updatedAt),
	)
	if err != nil {
		return fmt.Errorf("save artifact: %w", err)
	}
	return nil
}

func listJSON[T any](ctx context.Context, db dbExecutor, query string, args ...any) ([]T, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]T, 0)
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		var item T
		if err := json.Unmarshal([]byte(payload), &item); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func getJSON[T any](ctx context.Context, db dbExecutor, query string, args ...any) (T, error) {
	var payload string
	if err := db.QueryRowContext(ctx, query, args...).Scan(&payload); err != nil {
		var zero T
		if errors.Is(err, sql.ErrNoRows) {
			return zero, store.ErrNotFound
		}
		return zero, err
	}
	var item T
	if err := json.Unmarshal([]byte(payload), &item); err != nil {
		var zero T
		return zero, err
	}
	return item, nil
}

func encode(value any) (string, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(payload), nil
}

func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func titleFromInput(input string) string {
	input = strings.Join(strings.Fields(input), " ")
	runes := []rune(input)
	if len(runes) <= 72 {
		return input
	}
	return string(runes[:69]) + "..."
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}
