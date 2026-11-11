package sqlitestore

import (
	"context"
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
// tables on every start belongs in RunMaintenance (recurring cleanup that
// runs beside requests), not here.
func (s *Store) migrate(ctx context.Context) error {
	steps := []func(context.Context) error{
		s.createCoreSchema,
		s.setupProfiles,
		s.setupModelNotes,
		s.setupExecutionDefaults,
		s.setupModelPools,
		s.setupSessionRetries,
		s.setupSkillCatalog,
		s.setupWorkspaceDraftSkills,
		s.setupSessionEventCompaction,
		s.setupUsageStats,
		s.migrateNativeSessions,
		s.setupFeishu,
		s.setupAccounts,
		s.setupDeviceCredentials,
		s.setupOwnership,
		s.setupExternalAccounts,
		s.setupAppStoreConnect,
		s.dropRetiredOpenLarkInstances,
		s.setupFeishuGateway,
		// Before the prune, which walks their workspace-owned rows.
		s.setupDeviceConnectors,
		s.setupConnectorPackages,
		s.setupEdgeAccess,
		s.setupPersonalAgents,
		s.setupPermissionPackages,
		s.setupPersonalAgentMaintenance,
		s.setupPersonalAgentContextPatch,
		s.setupNativeAccountHolds,
		s.setupSessionWork,
		s.setupSessionWorkChanges,
		s.setupServiceTunnels,
		s.setupResources,
		s.setupResourceLeases,
		s.setupSessionTokenLeases,
		// Before the prune, which walks its rows.
		s.setupSessionInputSenders,
		s.setupSessionInbox,
		s.setupSessionAlerts,
		s.setupPendingItems,
		// Before the orphan prune (RunMaintenance), so an issue number only
		// orphaned rows still mention is not handed out again.
		s.raiseIssueSequence,
		s.setupProfilePromotions,
		s.setupProfileCodexTransports,
		s.setupProfileChecks,
		s.setupWorkspaceDigests,
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
		s.setupWorkspaceMigrations,
	}
	for _, step := range steps {
		started := time.Now()
		if err := step(ctx); err != nil {
			return err
		}
		if elapsed := time.Since(started); elapsed >= slowMigrationThreshold {
			logSlowMigration(runtime.FuncForPC(reflect.ValueOf(step).Pointer()).Name(), elapsed)
		}
	}
	return nil
}

// dropRetiredOpenLarkInstances removes the connector-specific metadata table
// from the first OpenLark slice. The generic extension-instance storage
// replaces it. A non-empty table is a migration blocker, never data to drop
// silently.
func (s *Store) dropRetiredOpenLarkInstances(ctx context.Context) error {
	var present int
	if err := s.conn().QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'openlark_instances'`).Scan(&present); err != nil {
		return fmt.Errorf("find retired openlark_instances: %w", err)
	}
	if present == 0 {
		return nil
	}
	var rows int
	if err := s.conn().QueryRowContext(ctx, `SELECT count(*) FROM openlark_instances`).Scan(&rows); err != nil {
		return fmt.Errorf("count retired openlark_instances: %w", err)
	}
	if rows != 0 {
		return fmt.Errorf("openlark_instances still has %d row(s); migrate them before starting this version", rows)
	}
	for _, statement := range []string{
		`DROP INDEX IF EXISTS idx_openlark_instances_account`,
		`DROP TABLE openlark_instances`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("drop retired openlark_instances: %w", err)
		}
	}
	return nil
}

// slowMigrationThreshold is when a step that delays every start is worth a
// log line.
const slowMigrationThreshold = 500 * time.Millisecond

// logSlowMigration names a step by its method ("(*Store).setupX-fm" is
// setupX).
func logSlowMigration(name string, elapsed time.Duration) {
	name = strings.TrimSuffix(name[strings.LastIndex(name, ".")+1:], "-fm")
	log.Printf("slow migration step: %s took %s", name, elapsed.Round(time.Millisecond))
}

func (s *Store) createCoreSchema(ctx context.Context) error {
	statements := coreSchema()
	statements = append(statements, chatQueueSchema()...)
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite: %w", err)
		}
	}
	if err := s.dropRetiredThreadColumn(ctx); err != nil {
		return err
	}
	for _, statement := range indexStatements() {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite: %w", err)
		}
	}
	return nil
}

// dropRetiredThreadColumn drops agent_sessions.thread_id, which always held
// the session's own id, with its index. One-time: delete it once the server
// has started on every database (2026-11, the owner's).
func (s *Store) dropRetiredThreadColumn(ctx context.Context) error {
	var present int
	if err := s.conn().QueryRowContext(ctx, `SELECT count(*) FROM pragma_table_info('agent_sessions') WHERE name = 'thread_id'`).Scan(&present); err != nil || present == 0 {
		return err
	}
	for _, statement := range []string{
		`DROP INDEX IF EXISTS idx_agent_sessions_workspace_thread_created_id`,
		`ALTER TABLE agent_sessions DROP COLUMN thread_id`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("drop agent_sessions.thread_id: %w", err)
		}
	}
	return nil
}
