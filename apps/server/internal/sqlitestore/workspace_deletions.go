package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// recordWorkspaceDeletion remembers that the person deleted the workspace
// from its device, in the deleting transaction. A worker that still serves
// the folder (it missed the forget, or it reports the folder it was
// installed with on every start) would otherwise bring the workspace back.
func recordWorkspaceDeletion(ctx context.Context, exec dbExecutor, workspace store.WorkspaceProjection, at time.Time) error {
	if workspace.DeviceID == "" {
		return nil
	}
	_, err := exec.ExecContext(ctx, `INSERT INTO deleted_workspaces (workspace_id, device_id, local_path, deleted_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(workspace_id, device_id) DO UPDATE SET
			local_path = excluded.local_path,
			deleted_at = excluded.deleted_at`,
		workspace.ID, workspace.DeviceID, workspace.LocalPath, formatTime(at))
	if err != nil {
		return fmt.Errorf("record workspace deletion: %w", err)
	}
	return nil
}

// WorkspaceDeletedFromDevice reports whether the person deleted the
// workspace from the device and has not added its folder there again.
func (s *Store) WorkspaceDeletedFromDevice(ctx context.Context, workspaceID, deviceID string) (bool, error) {
	if workspaceID == "" || deviceID == "" {
		return false, nil
	}
	var found int
	err := s.conn().QueryRowContext(ctx,
		`SELECT 1 FROM deleted_workspaces WHERE workspace_id = ? AND device_id = ?`, workspaceID, deviceID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read workspace deletion: %w", err)
	}
	return true, nil
}

// ClearWorkspaceDeletion takes back the deletion of the device's workspace
// at folder: the person is adding that folder again. The folder is compared
// as the worker records it (an absolute path, cleaned).
func (s *Store) ClearWorkspaceDeletion(ctx context.Context, deviceID, folder string) error {
	folder = strings.TrimSpace(folder)
	if deviceID == "" || folder == "" {
		return nil
	}
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM deleted_workspaces WHERE device_id = ? AND local_path = ?`,
		deviceID, path.Clean(folder)); err != nil {
		return fmt.Errorf("clear workspace deletion: %w", err)
	}
	return nil
}

// ownerKind is what a row belongs to; the row goes when its owner goes.
type ownerKind int

const (
	ownerWorkspace ownerKind = iota
	ownerIssue
	ownerRun
	ownerSession
	ownerThread
	ownerWork
)

// ofWorkspace is the SQL set of the owner ids that belong to the workspace
// bound to ?1.
func (kind ownerKind) ofWorkspace() string {
	switch kind {
	case ownerIssue:
		return `SELECT id FROM issues WHERE workspace_id = ?1 UNION ALL SELECT short_id FROM issues WHERE workspace_id = ?1`
	case ownerRun:
		return `SELECT id FROM runs WHERE workspace_id = ?1 OR issue_id IN (SELECT id FROM issues WHERE workspace_id = ?1)`
	case ownerSession:
		return `SELECT id FROM agent_sessions WHERE workspace_id = ?1`
	case ownerThread:
		return `SELECT thread_id FROM agent_sessions WHERE workspace_id = ?1`
	case ownerWork:
		return `SELECT id FROM session_work WHERE session_id IN (SELECT id FROM agent_sessions WHERE workspace_id = ?1)`
	default:
		return `SELECT ?1`
	}
}

// existing is the SQL set of the owner ids that exist.
func (kind ownerKind) existing() string {
	switch kind {
	case ownerIssue:
		return `SELECT id FROM issues UNION ALL SELECT short_id FROM issues`
	case ownerRun:
		return `SELECT id FROM runs`
	case ownerSession:
		return `SELECT id FROM agent_sessions`
	case ownerThread:
		return `SELECT thread_id FROM agent_sessions`
	case ownerWork:
		return `SELECT id FROM session_work`
	default:
		return `SELECT id FROM workspaces`
	}
}

// ownedRows is one table's rows of an owner kind. key is the SQL expression
// for a row's owner id: NULL or empty when the row has no owner of that kind.
type ownedRows struct {
	table string
	key   string
	owner ownerKind
}

// Owners named inside a column: idempotency records of issue and session
// requests (evidenceRequest, beginIdempotentRequest) by their scope, and a
// workspace's bundle selections by theirs.
const (
	issueRequestOwner    = `CASE WHEN scope GLOB 'iss_[0-9]*/*' OR scope GLOB 'ISS-[0-9]*/*' THEN substr(scope, 1, instr(scope, '/') - 1) END`
	sessionRequestOwner  = `CASE WHEN scope GLOB 'agent-sessions/messages:*' THEN substr(scope, length('agent-sessions/messages:') + 1) END`
	workspaceBundleOwner = `CASE WHEN scope IN ('workspace', 'workspace-off') THEN owner_id END`
)

// workspaceOwnedRows is everything a workspace owns, directly or through its
// issues, runs and agent sessions, each child before the owner it names.
// DeleteWorkspace deletes in this order; pruneOrphanedRows walks it
// backwards, so an owner it finds orphaned takes its children along. A new
// table keyed by any of these owners belongs here. deleted_workspaces does
// not: it outlives the workspace on purpose.
var workspaceOwnedRows = []ownedRows{
	{"pa_context_patches", "workspace_id", ownerWorkspace},
	{"pa_maintenance", "workspace_id", ownerWorkspace},
	{"run_events", "run_id", ownerRun},
	// Runs follow their work item; controls and barriers follow the native or
	// Foundry thread, whose id need not be an agent_sessions primary key.
	// Device-wide discovery coverage survives deleting any one workspace.
	{"session_work_runs", "work_id", ownerWork},
	{"session_work", "session_id", ownerSession},
	{"session_work_operations", "thread_id", ownerThread},
	{"session_work_scopes", "thread_id", ownerThread},
	{"agent_session_events", "session_id", ownerSession},
	{"agent_session_native_ids", "session_id", ownerSession},
	{"agent_session_usage_backfills", "session_id", ownerSession},
	{"session_input_senders", "session_id", ownerSession},
	{"native_account_dispatches", "session_id", ownerSession},
	{"session_tokens", "session_id", ownerSession},
	{"feishu_gateway_grants", "session_id", ownerSession},
	{"resource_waits", "session_id", ownerSession},
	{"resource_operations", "session_id", ownerSession},
	{"evidence_requests", sessionRequestOwner, ownerSession},
	// The assistant's tasks follow up their session; its proposals answer
	// to the conversation that made them.
	{"pa_tasks", "session_id", ownerSession},
	{"pa_proposals", "session_id", ownerSession},
	{"evidence_records", "issue_id", ownerIssue},
	{"acceptance_artifacts", "issue_id", ownerIssue},
	{"feishu_chat_threads", "issue_id", ownerIssue},
	{"evidence_requests", issueRequestOwner, ownerIssue},
	{"runs", "issue_id", ownerIssue},
	{"runs", "workspace_id", ownerWorkspace},
	{"issues", "workspace_id", ownerWorkspace},
	{"agent_sessions", "workspace_id", ownerWorkspace},
	{"evidence_records", "workspace_id", ownerWorkspace},
	{"feishu_chat_threads", "workspace_id", ownerWorkspace},
	{"feishu_bot_routes", "workspace_id", ownerWorkspace},
	{"chat_queue_items", "workspace_id", ownerWorkspace},
	{"chat_queue_revisions", "workspace_id", ownerWorkspace},
	{"chats", "workspace_id", ownerWorkspace},
	{"chat_titles", "workspace_id", ownerWorkspace},
	{"chat_layouts", "workspace_id", ownerWorkspace},
	{"chat_deletions", "workspace_id", ownerWorkspace},
	{"workspace_display_names", "workspace_id", ownerWorkspace},
	{"workspace_members", "workspace_id", ownerWorkspace},
	{"workspace_skill_bindings", "workspace_id", ownerWorkspace},
	{"workspace_draft_settings", "workspace_id", ownerWorkspace},
	{"workspace_draft_skills", "workspace_id", ownerWorkspace},
	{"workspace_draft_revisions", "workspace_id", ownerWorkspace},
	{"workspace_skill_exclusions", "workspace_id", ownerWorkspace},
	{"skill_bundle_selections", workspaceBundleOwner, ownerWorkspace},
	{"agents", "workspace_id", ownerWorkspace},
	{"workspace_files", "workspace_id", ownerWorkspace},
	{"assets", "workspace_id", ownerWorkspace},
	{"skills", "workspace_id", ownerWorkspace},
	{"external_account_bindings", "workspace_id", ownerWorkspace},
	{"device_connector_bindings", "workspace_id", ownerWorkspace},
	{"feishu_gateway_grants", "workspace_id", ownerWorkspace},
	// Work the assistant follows up in the workspace, and what it proposed
	// to do to it: neither can go on without it.
	{"pa_tasks", "workspace_id", ownerWorkspace},
	{"pa_proposals", "workspace_id", ownerWorkspace},
}

// deleteWorkspaceRows deletes every row the workspace owns, but not the
// workspace row itself.
func deleteWorkspaceRows(ctx context.Context, exec dbExecutor, workspaceID string) error {
	for _, rows := range workspaceOwnedRows {
		if _, err := exec.ExecContext(ctx, `DELETE FROM `+rows.table+
			` WHERE `+rows.key+` IN (`+rows.owner.ofWorkspace()+`)`, workspaceID); err != nil {
			return fmt.Errorf("delete workspace %s: %w", rows.table, err)
		}
	}
	return nil
}

// pruneOrphanedRows deletes owned rows whose owner no longer exists: a
// workspace deletion before it cascaded left them behind. Idempotent.
func (s *Store) pruneOrphanedRows(ctx context.Context) error {
	removed := map[string]int64{}
	err := s.withTx(ctx, func(tx *Store) error {
		for index := len(workspaceOwnedRows) - 1; index >= 0; index-- {
			rows := workspaceOwnedRows[index]
			result, err := tx.conn().ExecContext(ctx, `DELETE FROM `+rows.table+
				` WHERE `+rows.key+` <> '' AND `+rows.key+` NOT IN (`+rows.owner.existing()+`)`)
			if err != nil {
				return fmt.Errorf("prune orphaned %s: %w", rows.table, err)
			}
			if count, _ := result.RowsAffected(); count > 0 {
				removed[rows.table] += count
			}
		}
		return nil
	})
	if err != nil || len(removed) == 0 {
		return err
	}
	tables := make([]string, 0, len(removed))
	for table := range removed {
		tables = append(tables, table)
	}
	sort.Strings(tables)
	counts := make([]string, len(tables))
	for index, table := range tables {
		counts[index] = fmt.Sprintf("%s=%d", table, removed[table])
	}
	log.Printf("removed rows of deleted workspaces, issues, runs and sessions: %s", strings.Join(counts, " "))
	return nil
}
