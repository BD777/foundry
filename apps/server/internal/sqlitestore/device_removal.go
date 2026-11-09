package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A removed device leaves only its tombstone: removed_devices (its id) and
// removed_device_credentials (the hash of the credential it held), so a
// worker that comes back with that credential is told "device removed" and
// parks instead of retrying, and the id is never handed out again. Every
// other row it owned is deleted: RemoveDevice writes the tombstone, then
// PurgeRemovedDevice deletes the rest.

// RemoveDevice tombstones a device and revokes its credential. An offline
// device is always removable: the work it left (sessions, queues, scheduled
// work) is deleted with it, as it will never report on it again. A connected
// device with turns running is refused (DeviceTurnsRunningError) unless the
// person confirmed they stop with it.
//
// The check and the tombstone share one transaction. Every path that starts
// work on a device (claim, run start, session create/start) checks the
// tombstone (assertDeviceNotRemoved) inside its own write transaction, so
// either the work commits first and is counted here, or the tombstone does
// and the work is refused with ErrDeviceRemoved.
//
// Removing a device already removed but not yet purged succeeds again, so a
// failed purge can be retried; once it is purged the device is not found.
func (s *Store) RemoveDevice(ctx context.Context, input store.RemoveDeviceInput) (store.DeviceProjection, error) {
	id := strings.TrimSpace(input.ID)
	if id == "" {
		return store.DeviceProjection{}, store.ErrNotFound
	}
	var device store.DeviceProjection
	err := s.withTx(ctx, func(tx *Store) error {
		d, err := getJSON[store.DeviceProjection](ctx, tx.conn(),
			`SELECT payload_json FROM devices WHERE id = ?`, id)
		if err != nil {
			return err
		}
		device = d
		removed, err := tx.isDeviceRemoved(ctx, id)
		if err != nil || removed {
			return err
		}
		if input.Connected && !input.StopRunningTurns {
			turns, err := tx.RunningDeviceTurns(ctx, id)
			if err != nil {
				return err
			}
			if turns > 0 {
				return &store.DeviceTurnsRunningError{Turns: turns}
			}
		}
		if _, err := tx.conn().ExecContext(ctx,
			`INSERT INTO removed_devices (device_id, label, removed_at) VALUES (?, ?, ?)`,
			id, d.Label, formatTime(time.Now().UTC())); err != nil {
			return fmt.Errorf("tombstone device: %w", err)
		}
		// The person's grants to it go now: it is no longer one of their
		// computers, so a form holding them could not be saved.
		if err := tx.invalidateRemovedDeviceReferences(ctx, id); err != nil {
			return err
		}
		return tx.retireDeviceCredential(ctx, id)
	})
	if err != nil {
		return store.DeviceProjection{}, err
	}
	return device, nil
}

// RunningDeviceTurns counts the turns running on the device now: its agent
// sessions (an Issue's execution among them) that run or wait on a question.
func (s *Store) RunningDeviceTurns(ctx context.Context, deviceID string) (int, error) {
	var turns int
	err := s.conn().QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM agent_sessions WHERE status IN ('running','blocked')
			AND (device_id = ?1 OR workspace_id IN (SELECT id FROM workspaces WHERE device_id = ?1)))`, deviceID).Scan(&turns)
	return turns, err
}

// retireDeviceCredential moves the device's credential into its tombstone:
// the identity row goes, the hash stays to recognize a returning worker.
func (s *Store) retireDeviceCredential(ctx context.Context, deviceID string) error {
	if _, err := s.conn().ExecContext(ctx, `INSERT OR IGNORE INTO removed_device_credentials (credential_hash, device_id)
		SELECT credential_hash, device_id FROM device_identities WHERE device_id = ?`, deviceID); err != nil {
		return fmt.Errorf("keep removed device credential: %w", err)
	}
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM device_identities WHERE device_id = ?`, deviceID); err != nil {
		return fmt.Errorf("delete removed device identity: %w", err)
	}
	return nil
}

// RemovedDeviceCredential reports whether credentialHash was the credential
// of a removed device.
func (s *Store) RemovedDeviceCredential(ctx context.Context, credentialHash string) (bool, error) {
	var found int
	err := s.reader().QueryRowContext(ctx,
		`SELECT 1 FROM removed_device_credentials WHERE credential_hash = ?`, credentialHash).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read removed device credential: %w", err)
	}
	return true, nil
}

// DeviceRemoved reports whether the device is tombstoned. Safe to call on any
// executor (pool handle or transaction clone).
func (s *Store) DeviceRemoved(ctx context.Context, deviceID string) (bool, error) {
	return s.isDeviceRemoved(ctx, deviceID)
}

// DeviceRemovalPreview counts the rows PurgeRemovedDevice would delete,
// using the same ordered plan it executes. Counts share one read snapshot and
// write nothing.
func (s *Store) DeviceRemovalPreview(ctx context.Context, deviceID string) (store.DeviceRemovalPreview, error) {
	deviceID = strings.TrimSpace(deviceID)
	preview := store.DeviceRemovalPreview{
		Workspaces: []store.DeviceRemovalWorkspace{},
		Other:      map[string]int{},
	}
	if deviceID == "" {
		return preview, store.ErrNotFound
	}
	err := s.readSnapshot(ctx, func(db dbExecutor) error {
		var exists int
		err := db.QueryRowContext(ctx, `SELECT 1 FROM devices WHERE id = ?`, deviceID).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			return store.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("preview device %s: %w", deviceID, err)
		}

		err = scanRows(ctx, db, `SELECT w.id, COALESCE(d.name, w.name)
			FROM workspaces w LEFT JOIN workspace_display_names d ON d.workspace_id = w.id
			WHERE w.device_id = ? ORDER BY w.updated_at DESC, w.name`, func(rows *sql.Rows) error {
			var workspace store.DeviceRemovalWorkspace
			if err := rows.Scan(&workspace.ID, &workspace.Name); err != nil {
				return err
			}
			preview.Workspaces = append(preview.Workspaces, workspace)
			return nil
		}, deviceID)
		if err != nil {
			return fmt.Errorf("preview device %s workspaces: %w", deviceID, err)
		}
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM (`+deviceSessions+`)`, deviceID).Scan(&preview.Sessions); err != nil {
			return fmt.Errorf("preview device %s sessions: %w", deviceID, err)
		}
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM issues WHERE workspace_id IN (`+deviceWorkspaces+`)`, deviceID).Scan(&preview.Issues); err != nil {
			return fmt.Errorf("preview device %s issues: %w", deviceID, err)
		}

		counted := map[string]bool{}
		for _, step := range deviceRemovalPlan {
			if step.set != "" || counted[step.table] || previewSummaryTable(step.table) {
				continue
			}
			counted[step.table] = true
			selectors := make([]string, 0, 1)
			for _, candidate := range deviceRemovalPlan {
				if candidate.table == step.table && candidate.set == "" {
					selectors = append(selectors, `SELECT rowid FROM `+step.table+` WHERE `+candidate.where)
				}
			}
			query := `SELECT count(*) FROM ` + step.table + ` WHERE rowid IN (` + strings.Join(selectors, ` UNION `) + `)`
			var count int
			if err := db.QueryRowContext(ctx, query, deviceID).Scan(&count); err != nil {
				return fmt.Errorf("preview device %s %s: %w", deviceID, step.table, err)
			}
			if count > 0 {
				preview.Other[step.table] = count
			}
		}
		return nil
	})
	return preview, err
}

func previewSummaryTable(table string) bool {
	switch table {
	case "workspaces", "agent_sessions", "issues":
		return true
	default:
		return false
	}
}

func (s *Store) isDeviceRemoved(ctx context.Context, deviceID string) (bool, error) {
	var found int
	err := s.conn().QueryRowContext(ctx,
		`SELECT 1 FROM removed_devices WHERE device_id = ? LIMIT 1`, deviceID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// assertDeviceNotRemoved is the centralized work-creation gate. Every store
// path that starts new execution on a device must call it (through the
// transaction clone, so the check and the work insertion share one serialized
// transaction) before committing non-terminal work.
func (s *Store) assertDeviceNotRemoved(ctx context.Context, deviceID string) error {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return nil
	}
	var found int
	err := s.conn().QueryRowContext(ctx,
		`SELECT 1 FROM removed_devices WHERE device_id = ? LIMIT 1`, deviceID).Scan(&found)
	switch {
	case err == nil:
		return store.ErrDeviceRemoved
	case errors.Is(err, sql.ErrNoRows):
		return nil
	default:
		return err
	}
}

// assertWorkspaceDeviceNotRemoved gates work addressed by workspace id, which
// is how issues/runs identify their execution target.
func (s *Store) assertWorkspaceDeviceNotRemoved(ctx context.Context, workspaceID string) error {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil
	}
	var deviceID string
	err := s.conn().QueryRowContext(ctx,
		`SELECT COALESCE(json_extract(payload_json, '$.deviceId'), '') FROM workspaces WHERE id = ?`,
		workspaceID).Scan(&deviceID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.assertDeviceNotRemoved(ctx, deviceID)
}

// deviceSessions is the SQL set of the agent sessions of the device bound to
// ?1: those it ran, and those of its workspaces.
const deviceSessions = `SELECT id FROM agent_sessions WHERE device_id = ?1 OR workspace_id IN (` + deviceWorkspaces + `)`

const deviceWorkspaces = `SELECT id FROM workspaces WHERE device_id = ?1`

// deviceBulkRows are the device's largest rows: its sessions' events and its
// chats (whose rows carry their transcripts). They go first, a batch per
// write, so a device with a long history never holds the writer for long.
var deviceBulkRows = []struct {
	table, key string
	owner      ownerKind
	batch      int
}{
	{"agent_session_events", "session_id", ownerSession, 2000},
	{"chats", "workspace_id", ownerWorkspace, 20},
}

// PurgeRemovedDevice deletes everything the removed device owned, leaving
// its tombstone, and returns the rows it changed per table ("table (let go)"
// for rows elsewhere that pointed at it, deviceReferences). Its bulk goes
// first in short batches (deviceBulkRows); the rest goes in one transaction
// that ends with its workspaces, sessions and device row, so a purge cut
// short leaves them and is completed by the next one. Idempotent.
func (s *Store) PurgeRemovedDevice(ctx context.Context, id string) (map[string]int64, error) {
	id = strings.TrimSpace(id)
	removed, err := s.isDeviceRemoved(ctx, id)
	if err != nil {
		return nil, err
	}
	if !removed {
		return nil, fmt.Errorf("purge device %s: %w", id, store.ErrNotFound)
	}
	deleted := map[string]int64{}
	for _, step := range deviceRemovalPlan {
		if step.batch == 0 {
			continue
		}
		for {
			result, err := s.conn().ExecContext(ctx, `DELETE FROM `+step.table+` WHERE rowid IN (
				SELECT rowid FROM `+step.table+` WHERE `+step.where+` LIMIT ?2)`,
				id, step.batch)
			if err != nil {
				return deleted, fmt.Errorf("purge device %s %s: %w", id, step.table, err)
			}
			count, _ := result.RowsAffected()
			deleted[step.table] += count
			if count < int64(step.batch) {
				break
			}
		}
	}
	err = s.withTx(ctx, func(tx *Store) error {
		count := func(table string, result sql.Result) {
			if n, _ := result.RowsAffected(); n > 0 {
				deleted[table] += n
			}
		}
		if err := tx.invalidateRemovedDeviceReferences(ctx, id); err != nil {
			return err
		}
		for _, step := range deviceRemovalPlan {
			if step.batch > 0 {
				continue
			}
			result, err := tx.conn().ExecContext(ctx, step.statement(), id)
			if err != nil {
				return fmt.Errorf("purge device %s %s: %w", id, step.table, err)
			}
			label := step.table
			if step.set != "" {
				label += " (let go)"
			}
			count(label, result)
		}
		return nil
	})
	if err != nil {
		return deleted, err
	}
	return deleted, nil
}

// deviceReference is a row outside the device's own that points at what the
// device owned. It is let go the way the code reads "none": an optional
// pointer is emptied, a row that only makes sense with its target goes.
type deviceReference struct {
	table string
	set   string
	where string
}

// deviceReferences run before the device's rows go, while they can still be
// found, and touch only rows the purge keeps. Each predicate binds the device
// id to ?1.
var deviceReferences = []deviceReference{
	// A child session on another device stands on its own once its parent
	// is gone, as one started without a parent does.
	{"agent_sessions", `parent_session_id = '', payload_json = json_remove(payload_json, '$.parentSessionId')`,
		`parent_session_id IN (` + deviceSessions + `) AND device_id <> ?1 AND workspace_id NOT IN (` + deviceWorkspaces + `)`},
	// No record means the person sent the input (SessionInputSender).
	{"session_input_senders", "", `sender_session_id IN (` + deviceSessions + `) AND session_id NOT IN (` + deviceSessions + `)`},
	{"session_inbox", "", `sender_session_id IN (` + deviceSessions + `) AND session_id NOT IN (` + deviceSessions + `)`},
	{"chat_queue_items", `sent_session_id = ''`, `sent_session_id IN (` + deviceSessions + `) AND workspace_id NOT IN (` + deviceWorkspaces + `)`},
	{"chat_titles", `generation_session_id = ''`, `generation_session_id IN (` + deviceSessions + `) AND workspace_id NOT IN (` + deviceWorkspaces + `)`},
	{"feishu_chat_threads", `latest_session_id = ''`, `latest_session_id IN (` + deviceSessions + `) AND workspace_id NOT IN (` + deviceWorkspaces + `)`},
	// A digest whose summary session is gone is due again.
	{"workspace_digests", `summary_session_id = ''`, `summary_session_id IN (` + deviceSessions + `) AND workspace_id NOT IN (` + deviceWorkspaces + `)`},
	{"pa_items", `source_session_id = ''`, `source_session_id IN (` + deviceSessions + `)`},
	{"pa_memory", `source_session_id = ''`, `source_session_id IN (` + deviceSessions + `)`},
	// A task followed up for a conversation that is gone has no one to
	// report to.
	{"pa_tasks", "", `conversation_session_id IN (` + deviceSessions + `)`},
	// Leases its sessions hold on other devices' resources end with them.
	{"resource_leases", "", `holder_device_id = ?1 OR holder_session_id IN (` + deviceSessions + `)`},
	// A tunnel in another workspace that reached a service on the device.
	{"service_tunnels", "", `json_extract(payload_json, '$.deviceId') = ?1
		OR json_extract(payload_json, '$.targetWorkspaceId') IN (` + deviceWorkspaces + `)`},
	// A repository is fetched by another device, or by the server.
	{"skill_repositories", `fetch_device_id = ''`, `fetch_device_id = ?1`},
}

// deviceRows is one table's rows of a device: key is the SQL expression for
// the id of the device a row belongs to.
type deviceRows struct {
	table string
	key   string
}

// deviceOwnedRows is what the device owns by its own id, deleted after
// everything its workspaces and sessions own (workspaceOwnedRows, by
// ownerKind.ofDevice). A new table keyed by a device belongs here or in
// unownedDeviceColumns (tests).
var deviceOwnedRows = []deviceRows{
	{"agents", "device_id"},
	{"agent_profiles", "device_id"},
	{"agent_session_native_ids", "device_id"},
	{"agent_sessions", "device_id"},
	{"native_account_dispatches", "device_id"},
	{"native_account_holds", "device_id"},
	{"native_archive_targets", "device_id"},
	{"feishu_gateway_grants", "device_id"},
	{"device_connector_bindings", "device_id"},
	{"device_connector_states", "device_id"},
	{"device_profiles", "device_id"},
	{"profile_checks", "device_id"},
	{"profile_promotions", "device_id"},
	{"provider_health", "json_extract(payload_json, '$.deviceId')"},
	// Its copies of profile credentials (httpapi.agentProfileSecretID:
	// "agent-profile:<device>:<profile>"); server profiles' have no device.
	{"secret_records", `CASE WHEN id GLOB 'agent-profile:*:*' THEN substr(id, 15, instr(substr(id, 15), ':') - 1) END`},
	{"device_skills", "device_id"},
	{"device_skill_scans", "device_id"},
	{"device_skill_roots", "device_id"},
	{"skill_sources", "device_id"},
	{"device_tools", "device_id"},
	{"device_display_names", "device_id"},
	{"device_labels", "device_id"},
	{"device_file_access", "device_id"},
	{"device_outside_files", "device_id"},
	{"device_presence", "device_id"},
	{"device_account_shares", "device_id"},
	{"device_account_shares", "shared_device_id"},
	{"device_pairing_tokens", "used_by_device_id"},
	{"resource_waits", "device_id"},
	{"resource_operations", "source_id"},
	{"resource_leases", "source_id"},
	{"resource_fences", "source_id"},
	{"resource_instances", "source_id"},
	{"resource_source_settings", "source_id"},
	{"resource_sources", "id"},
	// Deleting session work records its removal (session_work_deleted
	// trigger) for the device, which will never read it.
	{"session_work", "device_id"},
	{"session_work_removed", "device_id"},
	{"session_work_coverage", "device_id"},
	{"deleted_workspaces", "device_id"},
	{"workspaces", "device_id"},
	{"device_identities", "device_id"},
	{"devices", "id"},
}

// deviceRemovalPlan is every row the purge acts on, in execution order:
// batched bulk rows first, then references outside the device, its
// workspaces' rows, and finally the device's own rows. Both the purge and
// DeviceRemovalPreview iterate this list. A new device-owned table goes in
// deviceOwnedRows; a new workspace-owned one goes in workspaceOwnedRows.
var deviceRemovalPlan = buildDeviceRemovalPlan()

type devicePurgeStep struct {
	table string
	where string
	// set updates a row the purge keeps; empty means the row is deleted.
	set   string
	batch int
}

func buildDeviceRemovalPlan() []devicePurgeStep {
	plan := make([]devicePurgeStep, 0, len(deviceBulkRows)+len(deviceReferences)+len(workspaceOwnedRows)+len(deviceOwnedRows))
	for _, bulk := range deviceBulkRows {
		plan = append(plan, devicePurgeStep{
			table: bulk.table,
			where: bulk.key + ` IN (` + bulk.owner.ofDevice() + `)`,
			batch: bulk.batch,
		})
	}
	for _, reference := range deviceReferences {
		plan = append(plan, devicePurgeStep{
			table: reference.table,
			where: reference.where,
			set:   reference.set,
		})
	}
	for _, rows := range workspaceOwnedRows {
		plan = append(plan, devicePurgeStep{
			table: rows.table,
			where: rows.key + ` IN (` + rows.owner.ofDevice() + `)`,
		})
	}
	for _, rows := range deviceOwnedRows {
		plan = append(plan, devicePurgeStep{
			table: rows.table,
			where: rows.key + ` = ?1`,
		})
	}
	return plan
}

func (step devicePurgeStep) statement() string {
	if step.set == "" {
		return `DELETE FROM ` + step.table + ` WHERE ` + step.where
	}
	return `UPDATE ` + step.table + ` SET ` + step.set + ` WHERE ` + step.where
}

var _ store.DeviceRemovalStore = (*Store)(nil)

// PurgeRemovedDevices purges every removed device that still owns rows: one
// just removed, one whose purge was cut short, or one removed before removal
// deleted its data.
func (s *Store) PurgeRemovedDevices(ctx context.Context) error {
	ids, err := s.removedDeviceIDs(ctx, `SELECT device_id FROM removed_devices AS r
		WHERE EXISTS (SELECT 1 FROM devices WHERE id = r.device_id)
			OR EXISTS (SELECT 1 FROM workspaces WHERE device_id = r.device_id)
			OR EXISTS (SELECT 1 FROM agent_sessions WHERE device_id = r.device_id)`)
	if err != nil {
		return err
	}
	for _, id := range ids {
		deleted, err := s.PurgeRemovedDevice(ctx, id)
		if err != nil {
			return err
		}
		log.Printf("purged removed device %s: %s", id, formatDeletedRows(deleted))
	}
	return nil
}

func (s *Store) removedDeviceIDs(ctx context.Context, query string) ([]string, error) {
	var ids []string
	err := scanRows(ctx, s.conn(), query, func(rows *sql.Rows) error {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
		return nil
	})
	return ids, err
}

// formatDeletedRows lists the rows deleted per table, by table name.
func formatDeletedRows(deleted map[string]int64) string {
	tables := make([]string, 0, len(deleted))
	for table := range deleted {
		if deleted[table] > 0 {
			tables = append(tables, table)
		}
	}
	if len(tables) == 0 {
		return "nothing left"
	}
	sort.Strings(tables)
	counts := make([]string, len(tables))
	for index, table := range tables {
		counts[index] = fmt.Sprintf("%s=%d", table, deleted[table])
	}
	return strings.Join(counts, " ")
}
