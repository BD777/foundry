package sqlitestore

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// isDeviceOrPathColumn is a column that names a device or a path on one.
func isDeviceOrPathColumn(column string) bool {
	return column == "device_id" || strings.HasSuffix(column, "_device_id") || column == "local_path" || strings.Contains(column, "path")
}

// Every column that names a device or a path is either moved when a
// workspace moves to another device or kept, with a reason: a new one
// cannot be forgotten by the move.
func TestEveryDeviceOrPathColumnIsClassifiedForMigration(t *testing.T) {
	db := newTestStore(t)
	rewritten := map[string]bool{}
	for _, column := range workspaceMigrationRewrites {
		rewritten[column.table+"."+column.column] = true
	}
	tables := tableColumns(t, db)
	for table, columns := range tables {
		for _, column := range columns {
			key := table + "." + column
			if !isDeviceOrPathColumn(column) {
				continue
			}
			if !rewritten[key] && workspaceMigrationKeptColumns[key] == "" {
				t.Errorf("%s names a device or a path: list it in workspaceMigrationRewrites or workspaceMigrationKeptColumns", key)
			}
		}
	}
	// The lists name real columns.
	for _, column := range workspaceMigrationRewrites {
		if !hasColumn(tables, column.table, column.column) {
			t.Errorf("workspaceMigrationRewrites names %s.%s, which does not exist", column.table, column.column)
		}
	}
	for key := range workspaceMigrationKeptColumns {
		table, column, _ := strings.Cut(key, ".")
		if !hasColumn(tables, table, column) {
			t.Errorf("workspaceMigrationKeptColumns names %s, which does not exist", key)
		}
	}
}

func hasColumn(tables map[string][]string, table, column string) bool {
	for _, name := range tables[table] {
		if name == column {
			return true
		}
	}
	return false
}

func newMigrationRecord(id string) store.WorkspaceMigrationRecord {
	return store.WorkspaceMigrationRecord{WorkspaceMigration: store.WorkspaceMigration{
		ID: id, WorkspaceID: "ws_home", SourceDeviceID: "dev_home", SourceDeviceLabel: "linux-dev", SourcePath: "/home/me/Foundry",
		TargetDeviceID: "dev_mac", TargetDeviceLabel: "mac", TargetPath: "/Users/me/Foundry",
	}}
}

func registerMigrationDevices(t *testing.T, db *Store) {
	t.Helper()
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, homeRegistration("dev_home", "linux-dev")); err != nil {
		t.Fatal(err)
	}
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_mac", Label: "mac", Status: "connected"}}); err != nil {
		t.Fatal(err)
	}
}

func advanceMigration(t *testing.T, db *Store, record store.WorkspaceMigrationRecord, states ...string) store.WorkspaceMigrationRecord {
	t.Helper()
	for _, state := range states {
		record.State = state
		saved, err := db.SaveWorkspaceMigration(context.Background(), record)
		if err != nil {
			t.Fatalf("to %s: %v", state, err)
		}
		record = saved
	}
	return record
}

func TestWorkspaceMigrationTransitions(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerMigrationDevices(t, db)
	record, err := db.CreateWorkspaceMigration(ctx, newMigrationRecord("wsmove_a"))
	if err != nil {
		t.Fatal(err)
	}
	if record.State != store.WorkspaceMigrationPreflight || record.Revision != 1 || record.SourcePurge.State != "none" {
		t.Fatalf("created = %+v", record)
	}
	if _, err := db.CreateWorkspaceMigration(ctx, newMigrationRecord("wsmove_b")); !errors.Is(err, store.ErrWorkspaceMigrationActive) {
		t.Fatalf("second move: %v", err)
	}
	workspace, err := db.GetWorkspace(ctx, "ws_home")
	if err != nil || workspace.Migration == nil || workspace.Migration.ID != "wsmove_a" || workspace.Migration.State != "preflight" ||
		workspace.Migration.TargetDeviceLabel != "mac" {
		t.Fatalf("projection = %+v %v", workspace.Migration, err)
	}

	skip := record
	skip.State = store.WorkspaceMigrationActivating
	if _, err := db.SaveWorkspaceMigration(ctx, skip); err == nil {
		t.Fatal("preflight went straight to activating")
	}
	stale := record
	record = advanceMigration(t, db, record, store.WorkspaceMigrationPreflight)
	stale.Step = "late"
	if _, err := db.SaveWorkspaceMigration(ctx, stale); !errors.Is(err, store.ErrWorkspaceMigrationRevision) {
		t.Fatalf("stale save: %v", err)
	}

	// The freeze refuses to start over running work.
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_home", AgentID: "agent_home", Provider: "claude", Prompt: "busy"})
	if err != nil {
		t.Fatal(err)
	}
	blockers, err := db.WorkspaceMigrationBlockers(ctx, "ws_home")
	if err != nil || len(blockers) != 1 || blockers[0].Kind != "session" || blockers[0].ID != session.ID {
		t.Fatalf("blockers = %+v %v", blockers, err)
	}
	busy := record
	busy.State = store.WorkspaceMigrationCopying
	if _, err := db.SaveWorkspaceMigration(ctx, busy); !errors.Is(err, store.ErrWorkspaceBusy) {
		t.Fatalf("freeze over a running session: %v", err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "done", "native_1"); err != nil {
		t.Fatal(err)
	}
	record = advanceMigration(t, db, record, store.WorkspaceMigrationCopying, store.WorkspaceMigrationVerifying, store.WorkspaceMigrationCopying)

	// Lease renewal keeps the revision; a cancel moves it.
	renewed, err := db.RenewWorkspaceMigrationLease(ctx, record.ID, "2999-01-01T00:00:00Z")
	if err != nil || renewed.Revision != record.Revision || renewed.LeaseUntil != "2999-01-01T00:00:00Z" {
		t.Fatalf("renewed = %+v %v", renewed, err)
	}
	if due, err := db.DueWorkspaceMigrations(ctx, "2026-11-06T00:00:00Z"); err != nil || len(due) != 0 {
		t.Fatalf("leased job due: %+v %v", due, err)
	}
	canceled, err := db.RequestWorkspaceMigrationCancel(ctx, "ws_home", record.ID)
	if err != nil || !canceled.CancelRequested || canceled.LeaseUntil != "" {
		t.Fatalf("cancel = %+v %v", canceled, err)
	}
	if _, err := db.SaveWorkspaceMigration(ctx, record); !errors.Is(err, store.ErrWorkspaceMigrationRevision) {
		t.Fatalf("save after cancel: %v", err)
	}
	if due, err := db.DueWorkspaceMigrations(ctx, "2026-11-06T00:00:00Z"); err != nil || len(due) != 1 {
		t.Fatalf("canceled job not due: %+v %v", due, err)
	}
	record = advanceMigration(t, db, canceled, store.WorkspaceMigrationCanceled)
	ended := record
	ended.State = store.WorkspaceMigrationCopying
	if _, err := db.SaveWorkspaceMigration(ctx, ended); err == nil {
		t.Fatal("a canceled move went on")
	}
	if workspace, _ := db.GetWorkspace(ctx, "ws_home"); workspace.Migration != nil {
		t.Fatalf("canceled move still on the workspace: %+v", workspace.Migration)
	}

	// After the switch the move cannot be canceled.
	next, err := db.CreateWorkspaceMigration(ctx, newMigrationRecord("wsmove_c"))
	if err != nil {
		t.Fatal(err)
	}
	next = advanceMigration(t, db, next, store.WorkspaceMigrationCopying, store.WorkspaceMigrationVerifying, store.WorkspaceMigrationActivating)
	if _, err := db.RequestWorkspaceMigrationCancel(ctx, "ws_home", next.ID); !errors.Is(err, store.ErrWorkspaceMigrationNotCancelable) {
		t.Fatalf("cancel while activating: %v", err)
	}
	retire := next
	retire.State = store.WorkspaceMigrationRetiring
	if _, err := db.SaveWorkspaceMigration(ctx, retire); err == nil {
		t.Fatal("activating left without the activation")
	}
	current, err := db.CurrentWorkspaceMigration(ctx, "ws_home")
	if err != nil || current.ID != "wsmove_c" {
		t.Fatalf("current = %+v %v", current, err)
	}
}

// Activation moves every row of the workspace that names the source device
// or its folders to the target, in one transaction, and leaves other
// workspaces alone.
func TestActivateWorkspaceMigrationRewritesTheWorkspaceRows(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerMigrationDevices(t, db)
	registerOtherWorkspace(t, db)
	if _, err := db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: "memory", UserID: "person", Kind: "memory", WorkspaceID: "ws_home", DeviceID: "dev_home", RootPath: "knowledge"}); err != nil {
		t.Fatal(err)
	}
	execAll(t, db,
		`UPDATE knowledge_vaults SET state = 'active' WHERE id = 'memory'`,
		`INSERT INTO agent_profiles (id, device_id, runtime, status, payload_json, updated_at) VALUES ('src_profile', 'dev_home', 'claude', 'ready', '{"label":"Home Claude"}', '')`,
		`INSERT INTO agent_sessions (id, workspace_id, agent_id, device_id, provider, status, payload_json, created_at, updated_at)
			VALUES ('sess_a', 'ws_home', 'agent_dev_home_ws_home_claude', 'dev_home', 'claude', 'completed',
			'{"id":"sess_a","deviceId":"dev_home","agentId":"agent_dev_home_ws_home_claude","profileId":"src_profile","prompt":"see /home/me/Foundry/a.png","input":{"attachments":[{"path":"/home/me/Foundry/a.png"},{"path":"/tmp/elsewhere.png"}]}}', '', ''),
			('sess_other', 'ws_other', 'agent_dev_home_ws_other_claude', 'dev_home', 'claude', 'completed', '{"deviceId":"dev_home"}', '', '')`,
		`INSERT INTO agent_session_native_ids (provider, native_id, session_id, device_id, attached_at) VALUES ('claude', 'nat_a', 'sess_a', 'dev_home', ''), ('claude', 'nat_o', 'sess_other', 'dev_home', '')`,
		`INSERT INTO native_archive_targets (provider, native_id, device_id, session_id, workspace_id, payload_json, generation)
			VALUES ('claude', 'nat_a', 'dev_home', 'sess_a', 'ws_home', '{"workspacePath":"/home/me/Foundry"}', 1)`,
		`INSERT INTO native_account_dispatches (session_id, input_id, device_id, runtime, account_label) VALUES ('sess_a', 'in_a', 'dev_home', 'claude', 'me')`,
		`INSERT INTO session_work (id, thread_id, session_id, device_id, payload_json)
			VALUES ('work_a', 'sess_a', 'sess_a', 'dev_home', '{"spec":{"cwd":"/home/me/Foundry/sub"},"scope":{"workspacePath":"/home/me/Foundry"}}')`,
		`INSERT INTO chat_queue_items (id, workspace_id, chat_id, position, text, attachments_json, created_at, updated_at)
			VALUES ('queued_a', 'ws_home', 'native_claude_home', 1, 'later', '[{"path":"/home/me/Foundry/x.txt"}]', '', '')`,
		`INSERT INTO session_inbox (session_id, input_id, sender_session_id, prompt, attachments_json, requested_delivery, delivery, state, text_hash, created_at, updated_at)
			VALUES ('sess_a', 'in_b', '', 'hi', '[{"path":"/home/me/Foundry/y.txt"}]', 'boundary', 'boundary', 'held', 'h', '', '')`,
		`INSERT INTO issues (id, workspace_id, short_id, title, status, priority, runtime, payload_json, created_at, updated_at)
			VALUES ('iss_mig', 'ws_home', 'ISS-MIG', 'done', 'accepted', 'medium', 'claude', '{"runs":[{"executionCwd":"/home/me/.foundry/workspaces/ws_home/environments/e1"}]}', '', '')`,
		`INSERT INTO evidence_records (id, workspace_id, issue_id, kind, sequence, payload_json)
			VALUES ('mat_a', 'ws_home', 'iss_mig', 'material', 1, '{"material":{"storageDeviceId":"dev_home"}}')`,
		`INSERT INTO pending_items (id, user_id, workspace_id, source, item_key, state, payload_json, created_at, updated_at)
			VALUES ('pend_a', 'person', 'ws_home', 'session', 'k', 'open', '{"deviceId":"dev_home","path":"/home/me/Foundry/f.md"}', '', '')`,
		`INSERT INTO assistants (id, owner_user_id, is_default, home_workspace_id, home_device_id, state, settings_json, created_at, updated_at)
			VALUES ('asst_person', 'person', 1, 'ws_home', 'dev_home', 'active', '{}', '', '')`,
		`INSERT INTO workspace_draft_skills (workspace_id, execution_root_id, payload_json) VALUES ('ws_home', 'root', '{"path":"/home/me/.cache/skill"}')`,
		`INSERT INTO agent_defaults (workspace_id, scope, profile_id, updated_at) VALUES ('ws_home', 'chat', 'src_profile', '')`,
		`INSERT INTO device_connector_bindings (workspace_id, kind, device_id, granted_by, created_at) VALUES ('ws_home', 'browser', 'dev_home', 'person', '')`,
	)
	notCarried, err := db.WorkspaceMigrationNotCarried(ctx, "ws_home", "dev_home", "dev_mac")
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]string{}
	for _, item := range notCarried {
		kinds[item.Kind] = item.Label
	}
	if kinds["profile"] != "Home Claude" || kinds["connector_binding"] != "browser" {
		t.Fatalf("not carried = %+v", notCarried)
	}

	record, err := db.CreateWorkspaceMigration(ctx, newMigrationRecord("wsmove_a"))
	if err != nil {
		t.Fatal(err)
	}
	record = advanceMigration(t, db, record, store.WorkspaceMigrationCopying, store.WorkspaceMigrationVerifying, store.WorkspaceMigrationActivating)
	moved, err := db.ActivateWorkspaceMigration(ctx, record, store.WorkspaceMigrationActivation{
		TargetPath: "/Users/me/Foundry", ExecutionRoot: "/Users/me/.foundry/workspaces/ws_home",
		PreviousExecutionRoot: "/home/me/.foundry/workspaces/ws_home", TargetDeviceLabel: "mac",
	})
	if err != nil {
		t.Fatal(err)
	}
	if moved.State != store.WorkspaceMigrationRetiring {
		t.Fatalf("after activation = %s", moved.State)
	}
	// Again (a restart after the switch): refused, nothing moves twice.
	if _, err := db.ActivateWorkspaceMigration(ctx, record, store.WorkspaceMigrationActivation{TargetPath: "/Users/me/Foundry"}); !errors.Is(err, store.ErrWorkspaceMigrationRevision) {
		t.Fatalf("second activation: %v", err)
	}

	workspace, err := db.GetWorkspace(ctx, "ws_home")
	if err != nil || workspace.DeviceID != "dev_mac" || workspace.LocalPath != "/Users/me/Foundry" || workspace.DeviceLabel != "mac" {
		t.Fatalf("workspace = %+v %v", workspace, err)
	}
	for query, want := range map[string]string{
		`SELECT device_id || ' ' || local_path FROM workspaces WHERE id = 'ws_home'`:                                                                          "dev_mac /Users/me/Foundry",
		`SELECT device_id || ' ' || agent_id FROM agent_sessions WHERE id = 'sess_a'`:                                                                         "dev_mac agent_dev_mac_ws_home_claude",
		`SELECT json_extract(payload_json, '$.deviceId') FROM agent_sessions WHERE id = 'sess_a'`:                                                             "dev_mac",
		`SELECT json_extract(payload_json, '$.agentId') FROM agent_sessions WHERE id = 'sess_a'`:                                                              "agent_dev_mac_ws_home_claude",
		`SELECT json_extract(payload_json, '$.input.attachments[0].path') FROM agent_sessions WHERE id = 'sess_a'`:                                            "/Users/me/Foundry/a.png",
		`SELECT json_extract(payload_json, '$.input.attachments[1].path') FROM agent_sessions WHERE id = 'sess_a'`:                                            "/tmp/elsewhere.png",
		`SELECT json_extract(payload_json, '$.prompt') FROM agent_sessions WHERE id = 'sess_a'`:                                                               "see /home/me/Foundry/a.png",
		`SELECT COALESCE(json_extract(payload_json, '$.profileId'), 'none') FROM agent_sessions WHERE id = 'sess_a'`:                                          "none",
		`SELECT device_id FROM agent_sessions WHERE id = 'sess_other'`:                                                                                        "dev_home",
		`SELECT device_id FROM agent_session_native_ids WHERE native_id = 'nat_a'`:                                                                            "dev_mac",
		`SELECT device_id FROM agent_session_native_ids WHERE native_id = 'nat_o'`:                                                                            "dev_home",
		`SELECT device_id || ' ' || json_extract(payload_json, '$.workspacePath') FROM native_archive_targets`:                                                "dev_mac /Users/me/Foundry",
		`SELECT device_id FROM native_account_dispatches WHERE session_id = 'sess_a'`:                                                                         "dev_mac",
		`SELECT device_id || ' ' || json_extract(payload_json, '$.spec.cwd') || ' ' || json_extract(payload_json, '$.scope.workspacePath') FROM session_work`: "dev_mac /Users/me/Foundry/sub /Users/me/Foundry",
		`SELECT json_extract(attachments_json, '$[0].path') FROM chat_queue_items WHERE id = 'queued_a'`:                                                      "/Users/me/Foundry/x.txt",
		`SELECT json_extract(attachments_json, '$[0].path') FROM session_inbox WHERE input_id = 'in_b'`:                                                       "/Users/me/Foundry/y.txt",
		`SELECT json_extract(payload_json, '$.runs[0].executionCwd') FROM issues WHERE id = 'iss_mig'`:                                                        "/Users/me/.foundry/workspaces/ws_home/environments/e1",
		`SELECT json_extract(payload_json, '$.material.storageDeviceId') FROM evidence_records WHERE id = 'mat_a'`:                                            "dev_mac",
		`SELECT device_id FROM knowledge_vaults WHERE id = 'memory'`:                                                                                          "dev_mac",
		`SELECT json_extract(payload_json, '$.deviceId') || ' ' || json_extract(payload_json, '$.path') FROM pending_items WHERE id = 'pend_a'`:               "dev_mac /Users/me/Foundry/f.md",
		`SELECT home_device_id FROM assistants WHERE id = 'asst_person'`:                                                                                      "dev_mac",
		`SELECT CAST(count(*) AS TEXT) FROM workspace_draft_skills WHERE workspace_id = 'ws_home'`:                                                            "0",
		`SELECT CAST(count(*) AS TEXT) FROM agents WHERE workspace_id = 'ws_home'`:                                                                            "0",
		`SELECT profile_id FROM agent_defaults WHERE workspace_id = 'ws_home'`:                                                                                "",
		`SELECT device_id FROM device_connector_bindings WHERE workspace_id = 'ws_home'`:                                                                      "dev_home",
	} {
		var got string
		if err := db.conn().QueryRowContext(ctx, query).Scan(&got); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
		if got != want {
			t.Errorf("%s = %q, want %q", query, got, want)
		}
	}

	// The source reporting the workspace again is not a claim: it keeps its
	// own news, the workspace stays on the target.
	changes, err := db.RegisterDaemonChanges(ctx, homeRegistration("dev_home", "linux-dev"))
	if err != nil {
		t.Fatalf("source hello after the move: %v", err)
	}
	if changes.MovedWorkspace != "ws_home" {
		t.Fatalf("changes = %+v", changes)
	}
	if workspace, _ := db.GetWorkspace(ctx, "ws_home"); workspace.DeviceID != "dev_mac" {
		t.Fatalf("the source took the workspace back: %+v", workspace)
	}
	// The target registers it.
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_mac", Label: "mac", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: "ws_home", Name: "Foundry", LocalPath: "/Users/me/Foundry"},
	}); err != nil {
		t.Fatalf("target registration: %v", err)
	}
	moved.State = store.WorkspaceMigrationComplete
	if _, err := db.SaveWorkspaceMigration(ctx, moved); err != nil {
		t.Fatal(err)
	}
	if workspace, _ := db.GetWorkspace(ctx, "ws_home"); workspace.Migration == nil || workspace.Migration.State != "complete" {
		t.Fatalf("complete, unpurged move not on the workspace: %+v", workspace.Migration)
	}
}

// The workspace shows the move under way, else the latest complete one not
// purged, else its latest move when that failed; never a canceled one.
func TestWorkspaceMigrationSummarySelection(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerMigrationDevices(t, db)
	summary := func() *store.WorkspaceMigrationSummary {
		t.Helper()
		workspace, err := db.GetWorkspace(ctx, "ws_home")
		if err != nil {
			t.Fatal(err)
		}
		return workspace.Migration
	}
	start := func(id string) store.WorkspaceMigrationRecord {
		t.Helper()
		record, err := db.CreateWorkspaceMigration(ctx, newMigrationRecord(id))
		if err != nil {
			t.Fatal(err)
		}
		return record
	}
	// Canceled: nothing shown.
	advanceMigration(t, db, start("wsmove_1"), store.WorkspaceMigrationCanceled)
	if got := summary(); got != nil {
		t.Fatalf("canceled shown: %+v", got)
	}
	// Failed and latest: shown, with both labels.
	advanceMigration(t, db, start("wsmove_2"), store.WorkspaceMigrationFailed)
	if got := summary(); got == nil || got.ID != "wsmove_2" || got.State != "failed" || got.SourceDeviceLabel != "linux-dev" || got.TargetDeviceLabel != "mac" {
		t.Fatalf("failed latest = %+v", got)
	}
	// A later canceled move hides the earlier failure.
	advanceMigration(t, db, start("wsmove_3"), store.WorkspaceMigrationCanceled)
	if got := summary(); got != nil {
		t.Fatalf("failure behind a canceled move shown: %+v", got)
	}
	// Complete beats a later failure; active beats complete.
	complete := advanceMigration(t, db, start("wsmove_4"), store.WorkspaceMigrationCopying, store.WorkspaceMigrationVerifying, store.WorkspaceMigrationActivating)
	execAll(t, db, `UPDATE workspace_migrations SET state = 'complete', payload_json = json_set(payload_json, '$.state', 'complete') WHERE id = 'wsmove_4'`)
	complete, _ = db.GetWorkspaceMigration(ctx, "ws_home", complete.ID)
	advanceMigration(t, db, start("wsmove_5"), store.WorkspaceMigrationFailed)
	if got := summary(); got == nil || got.ID != "wsmove_4" {
		t.Fatalf("complete vs later failure = %+v", got)
	}
	start("wsmove_6")
	if got := summary(); got == nil || got.ID != "wsmove_6" || got.State != "preflight" {
		t.Fatalf("active vs complete = %+v", got)
	}
	execAll(t, db, `UPDATE workspace_migrations SET state = 'canceled' WHERE id = 'wsmove_6'`)
	// Purged, the complete one goes; the latest move (canceled) is not a failure.
	complete.SourcePurge = store.WorkspaceMigrationSourcePurge{State: "purged"}
	if _, err := db.SaveWorkspaceMigration(ctx, complete); err != nil {
		t.Fatal(err)
	}
	if got := summary(); got != nil {
		t.Fatalf("after purge = %+v", got)
	}
}

func TestMigrationRewriterMovesOnlyWhatIsUnderTheFolders(t *testing.T) {
	r := migrationRewriter{sourceDevice: "dev_a", targetDevice: "dev_b"}
	r.addPrefix("/home/me/p", "/Users/me/p")
	r.addPrefix(`C:\work\p`, "/srv/p")
	for in, want := range map[string]string{
		"/home/me/p":         "/Users/me/p",
		"/home/me/p/a/b":     "/Users/me/p/a/b",
		"/home/me/project":   "/home/me/project",
		"relative/path":      "relative/path",
		`C:\work\p\src\x.go`: "/srv/p/src/x.go",
	} {
		if got := r.movePath(in); got != want {
			t.Errorf("movePath(%q) = %q, want %q", in, got, want)
		}
	}
	if workerSafeID("Dev-Mac.Local") != "dev_mac_local" {
		t.Fatalf("safe id = %q", workerSafeID("Dev-Mac.Local"))
	}
}
