package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"reflect"
	"runtime"
	"strings"
	"time"
)

// migrate brings the schema and the stored rows up to date. It runs at
// every start, so every step is idempotent; the steps run in this order.
// The server does not answer until it returns, so a step that scans whole
// tables on every start belongs in s.once (a one-time data migration) or in
// RunMaintenance (recurring cleanup that runs beside requests), not here.
func (s *Store) migrate(ctx context.Context) error {
	if err := s.setupAppliedMigrations(ctx); err != nil {
		return err
	}
	steps := []func(context.Context) error{
		s.createCoreSchema,
		// Before any later step saves an event.
		s.migrateSessionStateKeys,
		// After the state keys, which find the timer snapshots.
		s.once("backfillSessionSchedules", s.backfillSessionSchedules),
		s.migrateChatQueue,
		s.addChatTitleGenerationSessionColumn,
		s.once("backfillAnswerRevisions", s.backfillAnswerRevisions),
		s.addWorkspaceIDColumns,
		s.addAgentSessionLineageColumns,
		s.backfillAgentSessionThreadIDs,
		s.indexAgentSessionThreads,
		s.setupProfiles,
		s.addProfileContextWindowsColumn,
		s.setupSkillCatalog,
		s.setupWorkspaceDraftSkills,
		s.migrateSessionUsageBackfills,
		s.migrateNativeSessions,
		s.setupFeishu,
		s.setupAccounts,
		s.setupDeviceCredentials,
		s.setupOwnership,
		s.setupExternalAccounts,
		s.setupFeishuGateway,
		// Before the prune and dropping removed workspaces, which walk their
		// workspace-owned rows.
		s.setupDeviceConnectors,
		s.setupPersonalAgents,
		s.setupPersonalAgentMaintenance,
		s.setupPersonalAgentContextPatch,
		s.setupNativeAccountHolds,
		s.setupSessionWork,
		s.setupSessionWorkChanges,
		s.setupServiceTunnels,
		s.dropRemovedWorkspaces,
		s.setupResources,
		s.setupResourceLeases,
		// Before the prune, which walks its rows.
		s.setupSessionInputSenders,
		s.setupSessionInbox,
		s.setupPendingItems,
		s.backfillWorkspaceScopedRecords,
		s.once("pruneAgentSessionInlineEvents", s.pruneAgentSessionInlineEvents),
		// Before the orphan prune (RunMaintenance), so an issue number only
		// orphaned rows still mention is not handed out again.
		s.raiseIssueSequence,
		s.setupProfilePromotions,
		s.setupProfileCodexTransports,
		s.setupWorkspaceLifecycle,
		s.setupWorkspaceDigests,
		s.once("redactWorkspaceDigests", s.redactWorkspaceDigests),
		s.setupDevicePlacement,
		s.setupDeviceFiles,
		s.setupDeviceAccountSharing,
		s.setupPersonalAgentList,
		s.setupPersonalAgentInbox,
		s.setupPersonalAgentRuntime,
		s.setupPersonalAgentRunControls,
		s.setupPersonalAgentOperations,
		s.setupKnowledge,
		s.setupKnowledgeEntries,
		s.setupKnowledgeLegacyTransfer,
		s.setupKnowledgePublications,
		s.setupKnowledgeMigrations,
		s.setupKnowledgeReplicaCleanup,
		s.setupAgentDefaults,
	}
	for _, step := range steps {
		started := time.Now()
		if err := step(ctx); err != nil {
			return err
		}
		if elapsed := time.Since(started); elapsed >= slowMigrationThreshold {
			// A one-time step logs itself, under its name.
			if name := runtime.FuncForPC(reflect.ValueOf(step).Pointer()).Name(); !strings.Contains(name, ".once.") {
				logSlowMigration(name, elapsed)
			}
		}
	}
	return nil
}

// slowMigrationThreshold is when a step that delays every start is worth a
// log line.
const slowMigrationThreshold = 500 * time.Millisecond

// logSlowMigration names a step by its method ("(*Store).setupX-fm" is
// setupX); a one-time step is named by s.once.
func logSlowMigration(name string, elapsed time.Duration) {
	name = strings.TrimSuffix(name[strings.LastIndex(name, ".")+1:], "-fm")
	log.Printf("slow migration step: %s took %s", name, elapsed.Round(time.Millisecond))
}

// setupAppliedMigrations creates the record of the one-time migrations
// this database has completed (s.once).
func (s *Store) setupAppliedMigrations(ctx context.Context) error {
	if _, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS applied_migrations (
		name TEXT PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`); err != nil {
		return fmt.Errorf("migrate sqlite applied migrations: %w", err)
	}
	return nil
}

// once runs a one-time data migration: a backfill or repair of rows an
// earlier server wrote, which the current write paths no longer produce.
// Such a step scans whole tables, so after it completes once it is recorded
// in applied_migrations by name and skipped at later starts. A step that
// fails is not recorded and runs again; one that completed but was not yet
// recorded (a crash in between) runs again too, which is why it must stay
// idempotent. To run a changed step on databases that already applied it,
// give it a new name (name/v2).
func (s *Store) once(name string, step func(context.Context) error) func(context.Context) error {
	return func(ctx context.Context) (err error) {
		started := time.Now()
		defer func() {
			if elapsed := time.Since(started); err == nil && elapsed >= slowMigrationThreshold {
				logSlowMigration(name, elapsed)
			}
		}()
		var applied int
		err = s.conn().QueryRowContext(ctx, `SELECT 1 FROM applied_migrations WHERE name = ?`, name).Scan(&applied)
		if err == nil {
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("read applied migration %s: %w", name, err)
		}
		if err := step(ctx); err != nil {
			return err
		}
		if _, err := s.conn().ExecContext(ctx, `INSERT OR IGNORE INTO applied_migrations (name, applied_at) VALUES (?, ?)`,
			name, formatTime(time.Now().UTC())); err != nil {
			return fmt.Errorf("record applied migration %s: %w", name, err)
		}
		return nil
	}
}

func (s *Store) createCoreSchema(ctx context.Context) error {
	statements := coreSchema()
	statements = append(statements, chatQueueSchema()...)
	statements = append(statements, indexStatements()...)
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite: %w", err)
		}
	}
	return nil
}

func (s *Store) addChatTitleGenerationSessionColumn(ctx context.Context) error {
	return s.ensureColumn(ctx, "chat_titles", "generation_session_id", `ALTER TABLE chat_titles ADD COLUMN generation_session_id TEXT NOT NULL DEFAULT ''`)
}

func (s *Store) backfillAnswerRevisions(ctx context.Context) error {
	_, err := s.conn().ExecContext(ctx, `UPDATE agent_sessions SET payload_json = json_set(payload_json, '$.answerRevision', id || ':' || COALESCE(json_extract(payload_json, '$.completedAt'), '')) WHERE json_extract(payload_json, '$.status') = 'completed' AND COALESCE(json_extract(payload_json, '$.response'), '') <> '' AND json_extract(payload_json, '$.answerRevision') IS NULL`)
	return err
}

func (s *Store) addWorkspaceIDColumns(ctx context.Context) error {
	if err := s.ensureColumn(ctx, "assets", "workspace_id", `ALTER TABLE assets ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "issues", "workspace_id", `ALTER TABLE issues ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	return s.ensureColumn(ctx, "runs", "workspace_id", `ALTER TABLE runs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`)
}

func (s *Store) addAgentSessionLineageColumns(ctx context.Context) error {
	if err := s.ensureColumn(ctx, "agent_sessions", "thread_id", `ALTER TABLE agent_sessions ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "agent_sessions", "parent_session_id", `ALTER TABLE agent_sessions ADD COLUMN parent_session_id TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if _, err := s.conn().ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_agent_sessions_parent ON agent_sessions (parent_session_id)`); err != nil {
		return fmt.Errorf("index agent session lineage: %w", err)
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

func (s *Store) indexAgentSessionThreads(ctx context.Context) error {
	if _, err := s.conn().ExecContext(ctx, `DROP INDEX IF EXISTS idx_agent_sessions_workspace_thread_created`); err != nil {
		return fmt.Errorf("remove superseded agent session thread index: %w", err)
	}
	if _, err := s.conn().ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace_thread_created_id ON agent_sessions (workspace_id, thread_id, created_at ASC, id ASC)`); err != nil {
		return fmt.Errorf("index agent session threads: %w", err)
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
