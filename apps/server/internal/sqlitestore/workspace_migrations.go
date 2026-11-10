package sqlitestore

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Moving a workspace to another device (DEV-146,
// docs/devlog/DEV-146-workspace-migration.md): the job, and the one
// transaction that moves the workspace's rows to the target device.

func (s *Store) setupWorkspaceMigrations(ctx context.Context) error {
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS workspace_migrations (
			id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			state TEXT NOT NULL,
			revision INTEGER NOT NULL,
			lease_until TEXT NOT NULL DEFAULT '',
			source_device_id TEXT NOT NULL,
			target_device_id TEXT NOT NULL,
			target_path TEXT NOT NULL,
			purge_state TEXT NOT NULL DEFAULT 'none',
			created_at TEXT NOT NULL,
			payload_json TEXT NOT NULL
		)`,
		// One move under way per workspace.
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_migrations_active ON workspace_migrations(workspace_id)
			WHERE state NOT IN ('complete','canceled','failed')`,
		`CREATE INDEX IF NOT EXISTS idx_workspace_migrations_workspace ON workspace_migrations(workspace_id, created_at)`,
	} {
		if _, err := s.conn().ExecContext(ctx, q); err != nil {
			return fmt.Errorf("setup workspace migrations: %w", err)
		}
	}
	return nil
}

// workspaceMigrationSummarySQL is the workspace projection's migration:
// the move under way, else the latest complete one whose old copy is still
// on the source device, else the workspace's last move when it failed (so
// its reason and blockers stay reachable until the next move). w is the
// workspaces row.
const workspaceMigrationSummarySQL = `json((SELECT json_object(
		'id', m.id, 'state', m.state, 'sourceDeviceId', m.source_device_id, 'targetDeviceId', m.target_device_id,
		'targetDeviceLabel', COALESCE(json_extract(m.payload_json, '$.targetDeviceLabel'), ''),
		'sourceDeviceLabel', COALESCE(json_extract(m.payload_json, '$.sourceDeviceLabel'), ''),
		'step', COALESCE(json_extract(m.payload_json, '$.step'), ''),
		'files', COALESCE(json_extract(m.payload_json, '$.files'), 0),
		'bytes', COALESCE(json_extract(m.payload_json, '$.bytes'), 0),
		'totalFiles', COALESCE(json_extract(m.payload_json, '$.totalFiles'), 0),
		'totalBytes', COALESCE(json_extract(m.payload_json, '$.totalBytes'), 0),
		'waitingFor', COALESCE(json_extract(m.payload_json, '$.waitingFor'), ''))
	FROM workspace_migrations m
	WHERE m.workspace_id = w.id AND (m.state NOT IN ('complete','canceled','failed') OR (m.state = 'complete' AND m.purge_state = 'none')
		OR (m.state = 'failed' AND m.rowid = (SELECT MAX(l.rowid) FROM workspace_migrations l WHERE l.workspace_id = w.id)))
	ORDER BY CASE m.state WHEN 'complete' THEN 1 WHEN 'failed' THEN 2 ELSE 0 END, m.rowid DESC LIMIT 1))`

func scanWorkspaceMigration(row interface{ Scan(...any) error }) (store.WorkspaceMigrationRecord, error) {
	var record store.WorkspaceMigrationRecord
	var raw, lease string
	if err := row.Scan(&lease, &raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return record, store.ErrNotFound
		}
		return record, err
	}
	if err := json.Unmarshal([]byte(raw), &record); err != nil {
		return record, fmt.Errorf("decode workspace migration: %w", err)
	}
	record.LeaseUntil = lease
	return record, nil
}

const workspaceMigrationColumns = `SELECT lease_until, payload_json FROM workspace_migrations `

func (s *Store) queryWorkspaceMigrations(ctx context.Context, where string, args ...any) ([]store.WorkspaceMigrationRecord, error) {
	rows, err := s.reader().QueryContext(ctx, workspaceMigrationColumns+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []store.WorkspaceMigrationRecord{}
	for rows.Next() {
		record, err := scanWorkspaceMigration(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, record)
	}
	return items, rows.Err()
}

func (s *Store) GetWorkspaceMigration(ctx context.Context, workspaceID, id string) (store.WorkspaceMigrationRecord, error) {
	return scanWorkspaceMigration(s.conn().QueryRowContext(ctx, workspaceMigrationColumns+`WHERE workspace_id = ? AND id = ?`, workspaceID, id))
}

func (s *Store) getWorkspaceMigrationByID(ctx context.Context, id string) (store.WorkspaceMigrationRecord, error) {
	return scanWorkspaceMigration(s.conn().QueryRowContext(ctx, workspaceMigrationColumns+`WHERE id = ?`, id))
}

func (s *Store) CurrentWorkspaceMigration(ctx context.Context, workspaceID string) (store.WorkspaceMigrationRecord, error) {
	return scanWorkspaceMigration(s.reader().QueryRowContext(ctx, workspaceMigrationColumns+
		`WHERE workspace_id = ? ORDER BY CASE WHEN state IN ('complete','canceled','failed') THEN 1 ELSE 0 END, rowid DESC LIMIT 1`, workspaceID))
}

func (s *Store) DueWorkspaceMigrations(ctx context.Context, now string) ([]store.WorkspaceMigrationRecord, error) {
	return s.queryWorkspaceMigrations(ctx, `WHERE state NOT IN ('complete','canceled','failed')
		AND (lease_until = '' OR julianday(lease_until) <= julianday(?)) ORDER BY rowid LIMIT 20`, now)
}

func (s *Store) writeWorkspaceMigration(ctx context.Context, record store.WorkspaceMigrationRecord) (store.WorkspaceMigrationRecord, error) {
	record.Revision++
	record.UpdatedAt = paNow()
	raw, err := json.Marshal(record)
	if err != nil {
		return record, err
	}
	purge := record.SourcePurge.State
	if purge == "" {
		purge = "none"
	}
	_, err = s.conn().ExecContext(ctx, `UPDATE workspace_migrations SET state = ?, revision = ?, lease_until = ?,
		target_path = ?, purge_state = ?, payload_json = ? WHERE id = ?`,
		record.State, record.Revision, record.LeaseUntil, record.TargetPath, purge, string(raw), record.ID)
	return record, err
}

func (s *Store) CreateWorkspaceMigration(ctx context.Context, record store.WorkspaceMigrationRecord) (store.WorkspaceMigrationRecord, error) {
	var saved store.WorkspaceMigrationRecord
	err := s.withTx(ctx, func(tx *Store) error {
		if err := tx.assertDeviceNotRemoved(ctx, record.TargetDeviceID); err != nil {
			return err
		}
		var active bool
		if err := tx.conn().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM workspace_migrations
			WHERE workspace_id = ? AND state NOT IN ('complete','canceled','failed'))`, record.WorkspaceID).Scan(&active); err != nil {
			return err
		}
		if active {
			return store.ErrWorkspaceMigrationActive
		}
		now := paNow()
		record.State, record.Revision, record.LeaseUntil = store.WorkspaceMigrationPreflight, 1, ""
		record.CreatedAt, record.UpdatedAt = now, now
		if record.SourcePurge.State == "" {
			record.SourcePurge.State = "none"
		}
		raw, err := json.Marshal(record)
		if err != nil {
			return err
		}
		if _, err := tx.conn().ExecContext(ctx, `INSERT INTO workspace_migrations
			(id, workspace_id, state, revision, source_device_id, target_device_id, target_path, created_at, payload_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, record.ID, record.WorkspaceID, record.State, record.Revision,
			record.SourceDeviceID, record.TargetDeviceID, record.TargetPath, now, string(raw)); err != nil {
			return err
		}
		saved = record
		return nil
	})
	return saved, err
}

// workspaceMigrationTransitions are the state changes SaveWorkspaceMigration
// writes; activating moves on only through ActivateWorkspaceMigration.
var workspaceMigrationTransitions = map[string][]string{
	store.WorkspaceMigrationPreflight: {store.WorkspaceMigrationCopying, store.WorkspaceMigrationFailed, store.WorkspaceMigrationCanceled},
	store.WorkspaceMigrationCopying:   {store.WorkspaceMigrationVerifying, store.WorkspaceMigrationFailed, store.WorkspaceMigrationCanceled},
	store.WorkspaceMigrationVerifying: {store.WorkspaceMigrationCopying, store.WorkspaceMigrationActivating, store.WorkspaceMigrationFailed, store.WorkspaceMigrationCanceled},
	store.WorkspaceMigrationRetiring:  {store.WorkspaceMigrationComplete},
}

func workspaceMigrationTransitionAllowed(from, to string) bool {
	if from == to {
		// A settled job changes only its source purge.
		return !store.WorkspaceMigrationEnded(from) || from == store.WorkspaceMigrationComplete
	}
	for _, next := range workspaceMigrationTransitions[from] {
		if next == to {
			return true
		}
	}
	return false
}

func (s *Store) SaveWorkspaceMigration(ctx context.Context, record store.WorkspaceMigrationRecord) (store.WorkspaceMigrationRecord, error) {
	var saved store.WorkspaceMigrationRecord
	err := s.withTx(ctx, func(tx *Store) error {
		old, err := tx.getWorkspaceMigrationByID(ctx, record.ID)
		if err != nil {
			return err
		}
		if old.Revision != record.Revision {
			return store.ErrWorkspaceMigrationRevision
		}
		if old.WorkspaceID != record.WorkspaceID || old.SourceDeviceID != record.SourceDeviceID ||
			old.TargetDeviceID != record.TargetDeviceID || old.CancelRequested != record.CancelRequested {
			return store.ErrIdempotencyConflict
		}
		if !workspaceMigrationTransitionAllowed(old.State, record.State) {
			return fmt.Errorf("workspace migration cannot go from %s to %s", old.State, record.State)
		}
		if old.State == store.WorkspaceMigrationPreflight && record.State == store.WorkspaceMigrationCopying {
			// The freeze starts here: nothing may have started since the
			// preflight looked.
			blockers, err := tx.WorkspaceMigrationBlockers(ctx, record.WorkspaceID)
			if err != nil {
				return err
			}
			if len(blockers) > 0 {
				return fmt.Errorf("%w: %d running", store.ErrWorkspaceBusy, len(blockers))
			}
		}
		saved, err = tx.writeWorkspaceMigration(ctx, record)
		return err
	})
	return saved, err
}

func (s *Store) RenewWorkspaceMigrationLease(ctx context.Context, id, until string) (store.WorkspaceMigrationRecord, error) {
	var current store.WorkspaceMigrationRecord
	err := s.withTx(ctx, func(tx *Store) error {
		if _, err := tx.conn().ExecContext(ctx, `UPDATE workspace_migrations SET lease_until = ?
			WHERE id = ? AND state NOT IN ('complete','canceled','failed')`, until, id); err != nil {
			return err
		}
		var err error
		current, err = tx.getWorkspaceMigrationByID(ctx, id)
		return err
	})
	return current, err
}

func (s *Store) RequestWorkspaceMigrationCancel(ctx context.Context, workspaceID, id string) (store.WorkspaceMigrationRecord, error) {
	var saved store.WorkspaceMigrationRecord
	err := s.withTx(ctx, func(tx *Store) error {
		record, err := tx.GetWorkspaceMigration(ctx, workspaceID, id)
		if err != nil {
			return err
		}
		switch record.State {
		case store.WorkspaceMigrationPreflight, store.WorkspaceMigrationCopying, store.WorkspaceMigrationVerifying:
		case store.WorkspaceMigrationCanceled:
			saved = record
			return nil
		default:
			return store.ErrWorkspaceMigrationNotCancelable
		}
		if record.CancelRequested {
			saved = record
			return nil
		}
		record.CancelRequested = true
		// The driver takes it at once, whatever it was doing.
		record.LeaseUntil = ""
		saved, err = tx.writeWorkspaceMigration(ctx, record)
		return err
	})
	return saved, err
}

func (s *Store) WorkspaceMigrationBlockers(ctx context.Context, workspaceID string) ([]store.WorkspaceMigrationBlocker, error) {
	blockers := []store.WorkspaceMigrationBlocker{}
	err := scanRows(ctx, s.conn(), `
		SELECT 'session', id, COALESCE(NULLIF(json_extract(payload_json, '$.title'), ''), substr(COALESCE(json_extract(payload_json, '$.prompt'), ''), 1, 80), id)
			FROM agent_sessions WHERE workspace_id = ?1 AND status NOT IN ('completed','failed','canceled','cancelled')
		UNION ALL SELECT 'issue_run', id, title FROM issues WHERE workspace_id = ?1 AND status IN ('in_progress','verifying')
		UNION ALL SELECT 'pa_patch', id, id FROM pa_context_patches WHERE workspace_id = ?1 AND status = 'applying'
		UNION ALL SELECT 'other', c.session_id, 'Monitored assistant run' FROM pa_run_controls c JOIN agent_sessions a ON a.id = c.session_id
			WHERE a.workspace_id = ?1 AND c.state IN ('monitoring','stop_requested') AND json_extract(c.payload_json, '$.dispatchAttempted') = 1
		UNION ALL SELECT 'knowledge_vault', id, kind FROM knowledge_vaults WHERE workspace_id = ?1 AND state <> 'active'
		UNION ALL SELECT 'knowledge_vault', vault_id, 'Knowledge move' FROM knowledge_migrations
			WHERE target_workspace = ?1 AND state NOT IN ('complete','cancelled')`,
		func(rows *sql.Rows) error {
			var blocker store.WorkspaceMigrationBlocker
			if err := rows.Scan(&blocker.Kind, &blocker.ID, &blocker.Title); err != nil {
				return err
			}
			blockers = append(blockers, blocker)
			return nil
		}, workspaceID)
	return blockers, err
}

// workspaceMigrationSourceProfilesSQL selects the profile ids the
// workspace's sessions and defaults use that exist only on the source device
// (?1 workspace, ?2 source, ?3 target): its own accounts, not the server's.
const workspaceMigrationSourceProfilesSQL = `
	SELECT DISTINCT p.id AS id, COALESCE(NULLIF(json_extract(p.payload_json, '$.label'), ''), p.id) AS label
	FROM agent_profiles p
	WHERE p.device_id = ?2
		AND p.id IN (SELECT json_extract(payload_json, '$.profileId') FROM agent_sessions WHERE workspace_id = ?1
			UNION SELECT profile_id FROM agent_defaults WHERE workspace_id = ?1)
		AND NOT EXISTS (SELECT 1 FROM agent_profiles t WHERE t.device_id = ?3 AND t.id = p.id)
		AND NOT EXISTS (SELECT 1 FROM profiles s WHERE s.id = p.id)`

func (s *Store) WorkspaceMigrationNotCarried(ctx context.Context, workspaceID, sourceDeviceID, targetDeviceID string) ([]store.WorkspaceMigrationNotCarried, error) {
	items := []store.WorkspaceMigrationNotCarried{}
	err := scanRows(ctx, s.conn(), `
		SELECT 'profile', id, label FROM (`+workspaceMigrationSourceProfilesSQL+`)
		UNION ALL SELECT 'connector_binding', kind, kind FROM device_connector_bindings WHERE workspace_id = ?1 AND device_id = ?2
		UNION ALL SELECT 'service_tunnel', id, COALESCE(NULLIF(json_extract(payload_json, '$.name'), ''), id) FROM service_tunnels
			WHERE workspace_id = ?1 AND json_extract(payload_json, '$.deviceId') = ?2
		UNION ALL SELECT 'resource_lease', id, resource_id FROM resource_leases
			WHERE ended_at = '' AND holder_device_id = ?2 AND holder_session_id IN (SELECT id FROM agent_sessions WHERE workspace_id = ?1)
		UNION ALL SELECT 'feishu_gateway_grant', id, app_id FROM feishu_gateway_grants WHERE workspace_id = ?1 AND device_id = ?2`,
		func(rows *sql.Rows) error {
			var item store.WorkspaceMigrationNotCarried
			if err := rows.Scan(&item.Kind, &item.ID, &item.Label); err != nil {
				return err
			}
			items = append(items, item)
			return nil
		}, workspaceID, sourceDeviceID, targetDeviceID)
	return items, err
}

// Scopes select the rows of the workspace (the one argument).
const (
	migrationScopeWorkspaceRow = `id = ?`
	migrationScopeWorkspace    = `workspace_id = ?`
	migrationScopeSessions     = `session_id IN (SELECT id FROM agent_sessions WHERE workspace_id = ?)`
)

// How a column moves with the workspace.
const (
	// migrateDevice: the source device id becomes the target's.
	migrateDevice = "device"
	// migrateFolder: the folder becomes the target's.
	migrateFolder = "folder"
	// migrateAgent: an agent id the source device minted becomes the
	// target's (agent_<device>_<workspace>_<profile>).
	migrateAgent = "agent"
	// migrateJSON: in the JSON document, device ids, agent ids and paths
	// under the folder or the execution root move; profile ids only the
	// source device has are dropped.
	migrateJSON = "json"
)

type workspaceMigrationColumn struct {
	table, column, scope, how string
}

// workspaceMigrationRewrites is every column ActivateWorkspaceMigration
// moves. A column that names a device or a path and is in neither this list
// nor workspaceMigrationKeptColumns fails
// TestEveryDeviceOrPathColumnIsClassifiedForMigration.
var workspaceMigrationRewrites = []workspaceMigrationColumn{
	{"workspaces", "device_id", migrationScopeWorkspaceRow, migrateDevice},
	{"workspaces", "local_path", migrationScopeWorkspaceRow, migrateFolder},
	{"workspaces", "payload_json", migrationScopeWorkspaceRow, migrateJSON},
	{"agent_sessions", "device_id", migrationScopeWorkspace, migrateDevice},
	{"agent_sessions", "agent_id", migrationScopeWorkspace, migrateAgent},
	{"agent_sessions", "payload_json", migrationScopeWorkspace, migrateJSON},
	{"agent_session_native_ids", "device_id", migrationScopeSessions, migrateDevice},
	{"native_archive_targets", "device_id", migrationScopeWorkspace, migrateDevice},
	{"native_archive_targets", "payload_json", migrationScopeWorkspace, migrateJSON},
	{"native_account_dispatches", "device_id", migrationScopeSessions, migrateDevice},
	{"session_work", "device_id", migrationScopeSessions, migrateDevice},
	{"session_work", "payload_json", migrationScopeSessions, migrateJSON},
	{"chat_queue_items", "attachments_json", migrationScopeWorkspace, migrateJSON},
	{"session_inbox", "attachments_json", migrationScopeSessions, migrateJSON},
	{"issues", "payload_json", migrationScopeWorkspace, migrateJSON},
	{"evidence_records", "payload_json", migrationScopeWorkspace, migrateJSON},
	{"knowledge_vaults", "device_id", migrationScopeWorkspace, migrateDevice},
	{"knowledge_vaults", "payload_json", migrationScopeWorkspace, migrateJSON},
	{"pa_maintenance", "payload_json", migrationScopeWorkspace, migrateJSON},
	{"pending_items", "payload_json", migrationScopeWorkspace, migrateJSON},
	{"personal_agents", "home_device_id", migrationScopeWorkspace, migrateDevice},
	{"chats", "payload_json", migrationScopeWorkspace, migrateJSON},
}

// workspaceMigrationRegenerated are the workspace's rows activation deletes:
// the target device reports them again for itself.
var workspaceMigrationRegenerated = []struct{ table, where string }{
	{"workspace_draft_skills", `workspace_id = ?`},
	{"workspace_draft_revisions", `workspace_id = ?`},
	// The source device's agents for the workspace; the target registers its own.
	{"agents", `workspace_id = ? AND device_id = ?`},
}

// workspaceMigrationKeptColumns name a device or a path and stay as they
// are when a workspace moves, each for its reason.
var workspaceMigrationKeptColumns = map[string]string{
	// Regenerated: the target's registration reports them again.
	"agents.device_id":     "regenerated: activation deletes the source device's agents; the target registers its own",
	"workspace_files.path": "regenerated: paths inside the folder, replaced by the target's registration",
	// Not carried: tied to the source device, listed in the job's notCarried.
	"device_connector_bindings.device_id": "not carried: a connector held on the source device; set it up again on the target",
	"feishu_gateway_grants.device_id":     "not carried: a Feishu grant of a session on the source device",
	"resource_leases.holder_device_id":    "not carried: a device resource lease; preflight refuses running sessions, so none is held for work",
	"resource_waits.device_id":            "not carried: waits of sessions, which preflight requires to have ended",
	// Device-wide: not the workspace's.
	"agent_profiles.device_id":                "the device's own accounts",
	"deleted_workspaces.device_id":            "a deletion from that device, kept for its folder",
	"deleted_workspaces.local_path":           "a deletion from that device, kept for its folder",
	"device_account_shares.device_id":         "device account sharing",
	"device_account_shares.shared_device_id":  "device account sharing",
	"device_connector_states.device_id":       "the device's connectors",
	"device_display_names.device_id":          "the device's name",
	"device_file_access.device_id":            "the device's file access settings",
	"device_file_access.path":                 "the device's file access settings",
	"device_identities.device_id":             "the device's identity",
	"device_labels.device_id":                 "the device's labels",
	"device_outside_files.device_id":          "the device's outside-files setting",
	"device_pairing_tokens.used_by_device_id": "pairing",
	"device_presence.device_id":               "the device's presence",
	"device_profiles.device_id":               "the device's profile assignments",
	"profile_checks.device_id":                "the checks of the device's profile assignments",
	"device_skill_roots.device_id":            "the device's skill folders",
	"device_skill_roots.path":                 "the device's skill folders",
	"device_skill_scans.device_id":            "the device's skill scans",
	"device_skills.device_id":                 "the device's skills",
	"device_tools.device_id":                  "the device's tools",
	"feishu_gateway_requests.path":            "a Feishu API path of a gateway request",
	"knowledge_migrations.target_path":        "a knowledge vault move, relative to its workspace; preflight refuses one under way",
	"knowledge_vaults.root_path":              "relative to the workspace folder, which moves whole",
	"native_account_holds.device_id":          "the device's account holds",
	"profile_promotions.device_id":            "promotion of a device's profile",
	"promoted_skills.origin_device_id":        "where a promoted skill came from, history",
	"usage_turns.device_id":                   "historical usage fact; device ids are not rewritten when a workspace later moves",
	"usage_requests.device_id":                "historical request detail; device ids are not rewritten when a workspace later moves",
	"usage_daily.device_id":                   "historical usage rollup; device ids are not rewritten when a workspace later moves",
	"removed_device_credentials.device_id":    "removed devices",
	"removed_devices.device_id":               "removed devices",
	"session_work_coverage.device_id":         "the device's work discovery",
	"session_work_removed.device_id":          "the device's work discovery tombstones",
	"skill_repositories.fetch_device_id":      "skill repositories",
	"skill_repositories.subpath":              "skill repositories",
	"skill_sources.device_id":                 "skill sources",
	"workspace_migrations.source_device_id":   "the move itself",
	"workspace_migrations.target_device_id":   "the move itself",
	"workspace_migrations.target_path":        "the move itself",
}

func (s *Store) ActivateWorkspaceMigration(ctx context.Context, record store.WorkspaceMigrationRecord, activation store.WorkspaceMigrationActivation) (store.WorkspaceMigrationRecord, error) {
	var saved store.WorkspaceMigrationRecord
	err := s.withTx(ctx, func(tx *Store) error {
		if err := tx.assertDeviceNotRemoved(ctx, record.TargetDeviceID); err != nil {
			return err
		}
		old, err := tx.getWorkspaceMigrationByID(ctx, record.ID)
		if err != nil {
			return err
		}
		if old.Revision != record.Revision || old.State != store.WorkspaceMigrationActivating || old.CancelRequested {
			return store.ErrWorkspaceMigrationRevision
		}
		targetPath := strings.TrimSpace(activation.TargetPath)
		if targetPath == "" {
			targetPath = old.TargetPath
		}
		rewriter, cleared, err := tx.workspaceMigrationRewriter(ctx, old, targetPath, activation)
		if err != nil {
			return err
		}
		if err := tx.rewriteWorkspaceRows(ctx, old.WorkspaceID, rewriter, targetPath); err != nil {
			return err
		}
		label := activation.TargetDeviceLabel
		if label == "" {
			label = old.TargetDeviceLabel
		}
		if _, err := tx.conn().ExecContext(ctx, `UPDATE workspaces SET payload_json = json_remove(json_set(payload_json,
			'$.deviceId', ?, '$.deviceLabel', ?, '$.localPath', ?), '$.unavailableOnDevice') WHERE id = ?`,
			old.TargetDeviceID, label, targetPath, old.WorkspaceID); err != nil {
			return fmt.Errorf("move workspace row: %w", err)
		}
		if len(cleared) > 0 {
			ids := make([]any, 0, len(cleared)+1)
			ids = append(ids, old.WorkspaceID)
			for id := range cleared {
				ids = append(ids, id)
			}
			if _, err := tx.conn().ExecContext(ctx, `UPDATE agent_defaults SET profile_id = '' WHERE workspace_id = ? AND profile_id IN (`+
				strings.TrimSuffix(strings.Repeat("?,", len(cleared)), ",")+`)`, ids...); err != nil {
				return fmt.Errorf("clear source-only default accounts: %w", err)
			}
		}
		for _, rows := range workspaceMigrationRegenerated {
			args := []any{old.WorkspaceID}
			if strings.Count(rows.where, "?") == 2 {
				args = append(args, old.SourceDeviceID)
			}
			if _, err := tx.conn().ExecContext(ctx, `DELETE FROM `+rows.table+` WHERE `+rows.where, args...); err != nil {
				return fmt.Errorf("clear %s for the target: %w", rows.table, err)
			}
		}
		old.TargetPath = targetPath
		old.TargetDeviceLabel = label
		old.ExecutionRoot, old.PreviousExecutionRoot = activation.ExecutionRoot, activation.PreviousExecutionRoot
		old.State, old.Step, old.LeaseUntil, old.Reason, old.ReasonCode, old.WaitingFor =
			store.WorkspaceMigrationRetiring, "retiring_source", "", "", "", ""
		saved, err = tx.writeWorkspaceMigration(ctx, old)
		return err
	})
	return saved, err
}

func (s *Store) workspaceMigrationRewriter(ctx context.Context, record store.WorkspaceMigrationRecord, targetPath string,
	activation store.WorkspaceMigrationActivation) (migrationRewriter, map[string]bool, error) {
	cleared := map[string]bool{}
	err := scanRows(ctx, s.conn(), workspaceMigrationSourceProfilesSQL, func(rows *sql.Rows) error {
		var id, label string
		if err := rows.Scan(&id, &label); err != nil {
			return err
		}
		cleared[id] = true
		return nil
	}, record.WorkspaceID, record.SourceDeviceID, record.TargetDeviceID)
	if err != nil {
		return migrationRewriter{}, nil, err
	}
	rewriter := migrationRewriter{
		sourceDevice:   record.SourceDeviceID,
		targetDevice:   record.TargetDeviceID,
		agentOld:       "agent_" + workerSafeID(record.SourceDeviceID) + "_",
		agentNew:       "agent_" + workerSafeID(record.TargetDeviceID) + "_",
		clearedProfile: cleared,
	}
	rewriter.addPrefix(record.SourcePath, targetPath)
	rewriter.addPrefix(activation.PreviousExecutionRoot, activation.ExecutionRoot)
	return rewriter, cleared, nil
}

func (s *Store) rewriteWorkspaceRows(ctx context.Context, workspaceID string, rewriter migrationRewriter, targetPath string) error {
	for _, column := range workspaceMigrationRewrites {
		var err error
		switch column.how {
		case migrateDevice:
			_, err = s.conn().ExecContext(ctx, `UPDATE `+column.table+` SET `+column.column+` = ? WHERE `+column.scope+
				` AND `+column.column+` = ?`, rewriter.targetDevice, workspaceID, rewriter.sourceDevice)
		case migrateFolder:
			_, err = s.conn().ExecContext(ctx, `UPDATE `+column.table+` SET `+column.column+` = ? WHERE `+column.scope, targetPath, workspaceID)
		case migrateAgent:
			_, err = s.conn().ExecContext(ctx, `UPDATE `+column.table+` SET `+column.column+` = ? || substr(`+column.column+`, ?)
				WHERE `+column.scope+` AND substr(`+column.column+`, 1, ?) = ?`,
				rewriter.agentNew, len(rewriter.agentOld)+1, workspaceID, len(rewriter.agentOld), rewriter.agentOld)
		case migrateJSON:
			err = s.rewriteJSONColumn(ctx, column, workspaceID, rewriter)
		}
		if err != nil {
			return fmt.Errorf("move %s.%s: %w", column.table, column.column, err)
		}
	}
	return nil
}

func (s *Store) rewriteJSONColumn(ctx context.Context, column workspaceMigrationColumn, workspaceID string, rewriter migrationRewriter) error {
	type change struct {
		rowid int64
		value string
	}
	var changes []change
	err := scanRows(ctx, s.conn(), `SELECT rowid, `+column.column+` FROM `+column.table+` WHERE `+column.scope, func(rows *sql.Rows) error {
		var rowid int64
		var raw sql.NullString
		if err := rows.Scan(&rowid, &raw); err != nil {
			return err
		}
		if !raw.Valid || raw.String == "" {
			return nil
		}
		next, changed, err := rewriter.document(raw.String)
		if err != nil {
			return fmt.Errorf("row %d: %w", rowid, err)
		}
		if changed {
			changes = append(changes, change{rowid, next})
		}
		return nil
	}, workspaceID)
	if err != nil {
		return err
	}
	for _, c := range changes {
		if _, err := s.conn().ExecContext(ctx, `UPDATE `+column.table+` SET `+column.column+` = ? WHERE rowid = ?`, c.value, c.rowid); err != nil {
			return err
		}
	}
	return nil
}

// migrationRewriter moves what a JSON document of the workspace says about
// the source device and its folders to the target.
type migrationRewriter struct {
	sourceDevice, targetDevice string
	agentOld, agentNew         string
	// prefixes are folder pairs (old, new): the workspace folder and the
	// execution root.
	prefixes       [][2]string
	clearedProfile map[string]bool
}

func (r *migrationRewriter) addPrefix(old, next string) {
	old, next = strings.TrimSpace(old), strings.TrimSpace(next)
	if old == "" || next == "" || old == next {
		return
	}
	r.prefixes = append(r.prefixes, [2]string{cleanFolder(old), cleanFolder(next)})
}

func cleanFolder(folder string) string {
	if strings.Contains(folder, `\`) && !strings.Contains(folder, "/") {
		return strings.TrimRight(folder, `\`)
	}
	return path.Clean(folder)
}

func (r migrationRewriter) document(raw string) (string, bool, error) {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", false, err
	}
	next, changed := r.walk("", value)
	if !changed {
		return raw, false, nil
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(next); err != nil {
		return "", false, err
	}
	return strings.TrimSuffix(buffer.String(), "\n"), true, nil
}

func (r migrationRewriter) walk(key string, value any) (any, bool) {
	switch typed := value.(type) {
	case map[string]any:
		changed := false
		for k, v := range typed {
			if k == "profileId" {
				if id, ok := v.(string); ok && r.clearedProfile[id] {
					delete(typed, k)
					changed = true
					continue
				}
			}
			next, c := r.walk(k, v)
			if c {
				typed[k] = next
				changed = true
			}
		}
		return typed, changed
	case []any:
		changed := false
		for i, v := range typed {
			next, c := r.walk(key, v)
			if c {
				typed[i] = next
				changed = true
			}
		}
		return typed, changed
	case string:
		next := r.text(key, typed)
		return next, next != typed
	}
	return value, false
}

func (r migrationRewriter) text(key, value string) string {
	switch {
	case key == "deviceId" || strings.HasSuffix(key, "DeviceId"):
		if value == r.sourceDevice {
			return r.targetDevice
		}
	case key == "agentId" || strings.HasSuffix(key, "AgentId"):
		if strings.HasPrefix(value, r.agentOld) {
			return r.agentNew + strings.TrimPrefix(value, r.agentOld)
		}
	case key == "path" || key == "cwd" || strings.HasSuffix(key, "Path") || strings.HasSuffix(key, "Cwd") || strings.HasSuffix(key, "Root"):
		return r.movePath(value)
	}
	return value
}

func (r migrationRewriter) movePath(value string) string {
	for _, pair := range r.prefixes {
		old, next := pair[0], pair[1]
		if value == old {
			return next
		}
		for _, separator := range []string{"/", `\`} {
			if strings.HasPrefix(value, old+separator) {
				rest := strings.TrimPrefix(value, old+separator)
				if strings.Contains(next, `\`) && !strings.Contains(next, "/") {
					return next + `\` + strings.ReplaceAll(rest, "/", `\`)
				}
				return next + "/" + strings.ReplaceAll(rest, `\`, "/")
			}
		}
	}
	return value
}

var workerUnsafeID = regexp.MustCompile(`[^a-z0-9]+`)

// workerSafeID is the worker's safeID (packages/worker/src/platform/utils.ts),
// with which it mints agent ids.
func workerSafeID(input string) string {
	return strings.Trim(workerUnsafeID.ReplaceAllString(strings.ToLower(input), "_"), "_")
}

// workspaceMovedFromDevice reports a workspace that moved from deviceID to
// another device: the source's later report of it is not a claim.
func (s *Store) workspaceMovedFromDevice(ctx context.Context, workspaceID, deviceID string) (bool, error) {
	if workspaceID == "" || deviceID == "" {
		return false, nil
	}
	var moved bool
	err := s.conn().QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM workspace_migrations m JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.source_device_id = ? AND m.state IN ('retiring','complete') AND w.device_id <> m.source_device_id)`,
		workspaceID, deviceID).Scan(&moved)
	return moved, err
}
