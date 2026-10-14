package sqlitestore

import (
	"context"
	"database/sql"
	"fmt"
)

// migrate brings the schema and the stored rows up to date. It runs at
// every start, so every step is idempotent; the steps run in this order.
func (s *Store) migrate(ctx context.Context) error {
	steps := []func(context.Context) error{
		s.createCoreSchema,
		// Before any later step saves an event.
		s.migrateSessionStateKeys,
		// After the state keys, which find the timer snapshots.
		s.backfillSessionSchedules,
		s.migrateChatQueue,
		s.addChatTitleGenerationSessionColumn,
		s.backfillAnswerRevisions,
		s.addWorkspaceIDColumns,
		s.addAgentSessionLineageColumns,
		s.backfillAgentSessionThreadIDs,
		s.indexAgentSessionThreads,
		s.setupProfiles,
		s.addProfileContextWindowsColumn,
		s.setupSkillCatalog,
		s.migrateSessionUsageBackfills,
		s.migrateNativeSessions,
		s.setupFeishu,
		s.setupAccounts,
		s.setupDeviceCredentials,
		s.setupOwnership,
		s.setupExternalAccounts,
		s.setupFeishuGateway,
		// Before the prune, which walks its bindings.
		s.setupDeviceConnectors,
		s.dropRemovedWorkspaces,
		s.setupResources,
		s.setupResourceLeases,
		s.backfillWorkspaceScopedRecords,
		s.pruneAgentSessionInlineEvents,
		// Before the prune, so an issue number only orphaned rows still mention
		// is not handed out again.
		s.raiseIssueSequence,
		s.pruneOrphanedRows,
		s.setupProfilePromotions,
		s.setupProfileCodexTransports,
	}
	for _, step := range steps {
		if err := step(ctx); err != nil {
			return err
		}
	}
	return nil
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
