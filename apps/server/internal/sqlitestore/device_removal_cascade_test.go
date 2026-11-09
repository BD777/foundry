package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// referenceColumn is a column that names a device, workspace, session, issue
// or run: device_id, workspace_id, ... and holder_device_id, parent_session_id,
// target_workspace_id and the like. A resource source is a device.
var referenceColumn = regexp.MustCompile(`(^|_)(device|workspace|session|issue)_id$|^source_id$`)

// unownedDeviceColumns name a removed device, or what it owned, without
// belonging to it. Everything else naming them is deleted or let go.
var unownedDeviceColumns = map[string]string{
	"removed_devices.device_id":                   "the tombstone",
	"removed_device_credentials.device_id":        "the tombstone",
	"personal_agents.home_device_id":              "the person's assistant; it is moved to another device (MoveHome tolerates a missing home)",
	"knowledge_vaults.device_id":                  "the person's authority pointer and revocation recovery survive the loss of its folder",
	"knowledge_publications.target_workspace_id":  "the person's knowledge record, kept like knowledge_vaults.workspace_id",
	"pa_routing_decisions.corrected_workspace_id": "the person's routing history, for evals",
	"promoted_skills.origin_device_id":            "the server's catalog copy; the origin is provenance and is read with LEFT JOIN",
}

func deviceColumnUnowned(key string) bool {
	return unownedDeviceColumns[key] != "" || unownedOwnerColumns[key] != ""
}

type seedColumn struct {
	name, kind string
	notNull    bool
	hasDefault bool
	primaryKey bool
}

// seedEveryReferencingTable inserts into every table that has a reference
// column one row naming the device, its workspace, session, issue and run
// (owners, by kind), so a table added later is covered without being named
// here.
func seedEveryReferencingTable(t *testing.T, db *Store, owners map[string]string) []string {
	t.Helper()
	ctx := context.Background()
	execAll(t, db, `PRAGMA foreign_keys = OFF`)
	defer execAll(t, db, `PRAGMA foreign_keys = ON`)
	var seeded []string
	for table := range tableColumns(t, db) {
		if strings.HasPrefix(table, "sqlite_") || table == "removed_devices" || table == "removed_device_credentials" {
			continue
		}
		var columns []seedColumn
		if err := scanRows(ctx, db.conn(), `SELECT name, type, "notnull", dflt_value IS NOT NULL, pk FROM pragma_table_info(?)`, func(rows *sql.Rows) error {
			var column seedColumn
			var pk int
			if err := rows.Scan(&column.name, &column.kind, &column.notNull, &column.hasDefault, &pk); err != nil {
				return err
			}
			column.primaryKey = pk > 0
			columns = append(columns, column)
			return nil
		}, table); err != nil {
			t.Fatal(err)
		}
		references := false
		for _, column := range columns {
			references = references || referenceColumn.MatchString(column.name)
		}
		if !references {
			continue
		}
		var names []string
		var values []any
		for _, column := range columns {
			value, ok := seedValue(table, column, owners)
			if !ok {
				continue
			}
			names = append(names, column.name)
			values = append(values, value)
		}
		statement := `INSERT INTO ` + table + ` (` + strings.Join(names, ", ") + `) VALUES (?` + strings.Repeat(`, ?`, len(values)-1) + `)`
		if _, err := db.conn().ExecContext(ctx, statement, values...); err != nil {
			t.Fatalf("seed %s: %v", table, err)
		}
		seeded = append(seeded, table)
	}
	return seeded
}

func seedValue(table string, column seedColumn, owners map[string]string) (any, bool) {
	if match := referenceColumn.FindStringSubmatch(column.name); match != nil {
		if match[2] == "" {
			return owners["device"], true
		}
		return owners[match[2]], true
	}
	if strings.HasSuffix(column.name, "user_id") {
		return "user_seed", true
	}
	if column.hasDefault || (!column.notNull && !column.primaryKey) {
		return nil, false
	}
	kind := strings.ToUpper(column.kind)
	switch {
	case strings.Contains(kind, "INT") && column.primaryKey && column.name == "id":
		return nil, false
	case strings.Contains(kind, "INT"):
		return 1, true
	case strings.Contains(kind, "BLOB"):
		return []byte{0}, true
	case strings.HasSuffix(column.name, "_json"):
		return "{}", true
	case column.name == "role":
		return "member", true
	case column.name == "kind" && table == "feishu_bot_routes":
		return "chat", true
	}
	return fmt.Sprintf("seed_%s_%s", table, column.name), true
}

// rowsReferencing counts, per table.column, the rows of reference columns
// that hold one of values, leaving out the unowned ones.
func rowsReferencing(t *testing.T, db *Store, values map[string]bool) map[string]int {
	t.Helper()
	found := map[string]int{}
	for table, columns := range tableColumns(t, db) {
		for _, column := range columns {
			key := table + "." + column
			if !referenceColumn.MatchString(column) || deviceColumnUnowned(key) {
				continue
			}
			for value := range values {
				if count := countRows(t, db, `SELECT count(*) FROM `+table+` WHERE `+column+` = ?`, value); count > 0 {
					found[key+"="+value] = count
				}
			}
		}
	}
	return found
}

// registerDeviceWithAgent registers the device with a workspace and an agent
// sessions can be started with.
func registerDeviceWithAgent(t *testing.T, db *Store, deviceID, workspaceID, agentID string) {
	t.Helper()
	if err := db.RegisterDaemon(context.Background(), store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: deviceID, Label: "Device " + deviceID, Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: workspaceID, Name: "Workspace " + workspaceID, LocalPath: t.TempDir(), Baseline: "main"},
		Agents: []store.AgentProjection{{
			ID: agentID, WorkspaceID: workspaceID, DeviceID: deviceID, Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register %s: %v", deviceID, err)
	}
}

func TestDeviceRemovalPreviewMatchesPurgeAndDoesNotWrite(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerDeviceWithAgent(t, db, "dev_preview", "ws_preview", "agent_preview")
	issue := confirmedIssueOnDevice(t, db, "ws_preview")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_preview", AgentID: "agent_preview", Provider: "claude", Prompt: "preview",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.MintAgentSessionToken(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	seeded := seedEveryReferencingTable(t, db, map[string]string{
		"device": "dev_preview", "workspace": "ws_preview", "session": session.ID, "issue": issue.ID,
	})
	if len(seeded) < 40 {
		t.Fatalf("seeded only %d tables: %v", len(seeded), seeded)
	}
	if _, err := db.RenameWorkspace(ctx, "ws_preview", "Preview Workspace"); err != nil {
		t.Fatal(err)
	}

	preview, err := db.DeviceRemovalPreview(ctx, "dev_preview")
	if err != nil {
		t.Fatal(err)
	}
	if want := countRows(t, db, `SELECT count(*) FROM workspaces WHERE device_id = 'dev_preview'`); len(preview.Workspaces) != want {
		t.Fatalf("preview workspaces = %+v, want %d", preview.Workspaces, want)
	}
	foundWorkspace := false
	for _, workspace := range preview.Workspaces {
		if workspace.ID == "ws_preview" && workspace.Name == "Preview Workspace" {
			foundWorkspace = true
		}
	}
	if !foundWorkspace {
		t.Fatalf("preview workspaces = %+v", preview.Workspaces)
	}
	if want := countRows(t, db, `SELECT count(*) FROM (`+deviceSessions+`)`, "dev_preview"); preview.Sessions != want {
		t.Fatalf("preview sessions = %d, want %d", preview.Sessions, want)
	}
	if want := countRows(t, db, `SELECT count(*) FROM issues WHERE workspace_id = 'ws_preview'`); preview.Issues != want {
		t.Fatalf("preview issues = %d, want %d", preview.Issues, want)
	}
	if len(preview.Other) == 0 {
		t.Fatal("preview counted no other tables")
	}
	for table, want := range preview.Other {
		if got := countRows(t, db, `SELECT count(*) FROM `+table); got != want {
			t.Errorf("preview %s = %d, current rows = %d", table, want, got)
		}
	}
	again, err := db.DeviceRemovalPreview(ctx, "dev_preview")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(again, preview) {
		t.Fatalf("preview changed between reads:\nfirst  %+v\nsecond %+v", preview, again)
	}
	if removed, err := db.DeviceRemoved(ctx, "dev_preview"); err != nil || removed {
		t.Fatalf("preview changed the device lifecycle: removed=%v err=%v", removed, err)
	}
	if got := countRows(t, db, `SELECT count(*) FROM removed_devices WHERE device_id = 'dev_preview'`); got != 0 {
		t.Fatalf("preview left %d tombstones", got)
	}

	removeDeviceForTest(t, db, "dev_preview")
	if _, err := db.PurgeRemovedDevice(ctx, "dev_preview"); err != nil {
		t.Fatal(err)
	}
	for table, count := range preview.Other {
		if got := countRows(t, db, `SELECT count(*) FROM `+table); got != 0 {
			t.Errorf("after purge %s has %d of the %d previewed rows left", table, got, count)
		}
	}
}

// Removing a device deletes everything that names it, its workspaces,
// sessions, issues or runs, in any table; rows elsewhere that pointed at
// them let go; the other device keeps everything it owns.
func TestRemovedDeviceLeavesNothingBehind(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerDeviceWithAgent(t, db, "dev_gone", "ws_gone", "agent_gone")
	registerDeviceWithAgent(t, db, "dev_kept", "ws_kept", "agent_kept")

	issue := confirmedIssueOnDevice(t, db, "ws_gone")
	if err := claimIssueForTest(ctx, db, "dev_gone", "ws_gone"); err != nil {
		t.Fatal(err)
	}
	run := store.Run{ID: "run_gone", Status: "running", Runtime: "mock"}
	if _, err := db.StartIssueRun(ctx, issue.ID, run); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_gone", AgentID: "agent_gone", Provider: "claude", Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.MintAgentSessionToken(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordRequest(ctx, issue.ID+"/accept", "key_issue", "input", "response"); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordRequest(ctx, "agent-sessions/messages:"+session.ID, "key_session", "input", "response"); err != nil {
		t.Fatal(err)
	}
	if err := db.SetDeviceSkillRoots(ctx, store.SetDeviceSkillRootsInput{DeviceID: "dev_gone", Paths: []string{"/skills"}}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReplaceSourceResources(ctx, store.ResourceSourceStatus{Kind: "device", ID: "dev_gone", Online: true},
		[]store.ResourceInstance{{ID: "res_gone", Key: "gpu/0", Type: "gpu", Platform: "linux", Name: "GPU", State: store.ResourceAvailable}}); err != nil {
		t.Fatal(err)
	}
	seeded := seedEveryReferencingTable(t, db, map[string]string{
		"device": "dev_gone", "workspace": "ws_gone", "session": session.ID, "issue": issue.ID,
	})
	if len(seeded) < 40 {
		t.Fatalf("seeded only %d tables: %v", len(seeded), seeded)
	}
	// What other devices hold that points at it.
	execAll(t, db,
		`INSERT INTO agent_sessions (id, workspace_id, agent_id, device_id, provider, status, parent_session_id, payload_json, created_at, updated_at)
			VALUES ('sess_child', 'ws_kept', 'agent_kept', 'dev_kept', 'codex', 'completed', '`+session.ID+`',
			'{"id":"sess_child","parentSessionId":"`+session.ID+`"}', '', '')`,
		`INSERT INTO session_input_senders (session_id, input_id, sender_session_id, created_at) VALUES ('sess_child', 'input_1', '`+session.ID+`', '')`,
		`INSERT INTO chat_titles (workspace_id, chat_id, title, version, generation_session_id) VALUES ('ws_kept', 'sess_child', 'title', 'v1', '`+session.ID+`')`,
		`INSERT INTO pa_tasks (id, user_id, conversation_session_id, session_id, workspace_id, title, status, created_at, updated_at)
			VALUES ('task_kept', 'user_seed', '`+session.ID+`', 'sess_child', 'ws_kept', 'work', 'running', '', '')`,
		`INSERT INTO service_tunnels (id, workspace_id, revision, payload_json)
			VALUES ('tunnel_to_gone', 'ws_kept', 1, '{"targetWorkspaceId":"ws_gone","deviceId":"dev_gone"}'),
			('tunnel_kept', 'ws_kept', 1, '{"targetWorkspaceId":"ws_kept","deviceId":"dev_kept"}')`,
		`INSERT INTO skill_repositories (id, url, label, ref, subpath, commit_sha, checked_at, created_by, created_at, fetch_device_id)
			VALUES ('repo_gone', 'https://example.test/repo', 'repo', 'main', '', '', '', '', '', 'dev_gone')`,
		`INSERT INTO secret_records (id, aad, ciphertext, wrapped_dek, dek_nonce, ct_nonce, created_at, updated_at)
			VALUES ('agent-profile:dev_gone:codex_local', '', x'00', x'00', x'00', x'00', '', ''),
			('agent-profile:dev_kept:codex_local', '', x'00', x'00', x'00', x'00', '', ''),
			('agent-profile:prof_server', '', x'00', x'00', x'00', x'00', '', '')`,
		`INSERT INTO provider_health (provider, status, auth_mode, secret_stored, payload_json, updated_at)
			VALUES ('codex@dev_gone', 'healthy', '', '', '{"deviceId":"dev_gone"}', '')`,
	)

	if _, err := db.RemoveDevice(ctx, store.RemoveDeviceInput{ID: "dev_gone"}); err != nil {
		t.Fatalf("an offline device with a running run and session is removable: %v", err)
	}
	deleted, err := db.PurgeRemovedDevice(ctx, "dev_gone")
	if err != nil {
		t.Fatal(err)
	}
	if deleted["agent_sessions"] == 0 || deleted["workspaces"] == 0 || deleted["devices"] != 1 {
		t.Fatalf("purge counts = %v", deleted)
	}

	gone := map[string]bool{"dev_gone": true, "ws_gone": true, session.ID: true, issue.ID: true, issue.ShortID: true}
	if left := rowsReferencing(t, db, gone); len(left) > 0 {
		t.Errorf("rows naming the removed device or what it owned: %v", left)
	}
	for query, want := range map[string]int{
		`SELECT count(*) FROM devices WHERE id = 'dev_gone'`:                                                                                                 0,
		`SELECT count(*) FROM workspace_digests WHERE workspace_id = 'ws_gone'`:                                                                              0,
		`SELECT count(*) FROM removed_devices WHERE device_id = 'dev_gone'`:                                                                                  1,
		`SELECT count(*) FROM removed_device_credentials WHERE device_id = 'dev_gone'`:                                                                       1,
		`SELECT count(*) FROM evidence_requests WHERE scope IN ('` + issue.ID + `/accept', 'agent-sessions/messages:` + session.ID + `')`:                    0,
		`SELECT count(*) FROM secret_records WHERE id LIKE 'agent-profile:dev_gone:%'`:                                                                       0,
		`SELECT count(*) FROM secret_records WHERE id IN ('agent-profile:dev_kept:codex_local', 'agent-profile:prof_server')`:                                2,
		`SELECT count(*) FROM provider_health WHERE json_extract(payload_json, '$.deviceId') = 'dev_gone'`:                                                   0,
		`SELECT count(*) FROM service_tunnels`:                                                                                                               1,
		`SELECT count(*) FROM pa_tasks WHERE id = 'task_kept'`:                                                                                               0,
		`SELECT count(*) FROM agent_sessions WHERE id = 'sess_child' AND parent_session_id = '' AND json_extract(payload_json, '$.parentSessionId') IS NULL`: 1,
		`SELECT count(*) FROM chat_titles WHERE chat_id = 'sess_child' AND generation_session_id = ''`:                                                       1,
		`SELECT count(*) FROM skill_repositories WHERE id = 'repo_gone' AND fetch_device_id = ''`:                                                            1,
		`SELECT count(*) FROM workspaces WHERE id = 'ws_kept'`:                                                                                               1,
		`SELECT count(*) FROM devices WHERE id = 'dev_kept'`:                                                                                                 1,
	} {
		if got := countRows(t, db, query); got != want {
			t.Errorf("%s = %d, want %d", query, got, want)
		}
	}
	if removed, err := db.RemovedDeviceCredential(ctx, "seed_device_identities_credential_hash"); err != nil || !removed {
		t.Errorf("the removed device's credential is not recognized: %v %v", removed, err)
	}

	again, err := db.PurgeRemovedDevice(ctx, "dev_gone")
	if err != nil || len(again) > 0 && formatDeletedRows(again) != "nothing left" {
		t.Fatalf("second purge deleted %v (%v)", again, err)
	}
	if _, err := db.RemoveDevice(ctx, store.RemoveDeviceInput{ID: "dev_gone"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("removing a purged device: %v, want ErrNotFound", err)
	}
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_gone", Label: "Ghost", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: "ws_gone", Name: "Ghost", LocalPath: t.TempDir(), Baseline: "main"},
	}); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("a removed device registered again: %v", err)
	}
}
