package sqlitestore

import (
	"bytes"
	"context"
	"database/sql"
	"log"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

// ownerColumns are the columns that name a workspace, issue, run or session.
var ownerColumns = []string{"workspace_id", "issue_id", "run_id", "session_id"}

// unownedOwnerColumns name a workspace without belonging to it.
var unownedOwnerColumns = map[string]string{
	"deleted_workspaces.workspace_id": "the deletion outlives the workspace",
	"user_invites.workspace_id":       "an invite's grant; it lapses once its inviter no longer owns the workspace",
	"workspace_digests.workspace_id":  "a person's digest belongs to their membership, deleted with it (ON DELETE CASCADE)",
	// The person's assistant outlives any one workspace: moving it gives it
	// a new one, and the stop switch, not deleting, turns it off.
	"personal_agents.workspace_id": "the person's assistant; its workspace cannot be deleted",
	// The person's records of what the assistant did and decided: kept for
	// their retention (pa_actions 90 days) and the routing evals, naming
	// workspaces and sessions that may be gone.
	"pa_actions.workspace_id":           "the person's audit trail, kept 90 days",
	"pa_actions.session_id":             "the person's audit trail, kept 90 days",
	"pa_routing_decisions.workspace_id": "the person's routing history, for evals",
	"pa_routing_decisions.session_id":   "the person's routing history, for evals",
}

// tableColumns lists every table with its columns.
func tableColumns(t *testing.T, db *Store) map[string][]string {
	t.Helper()
	ctx := context.Background()
	tables := map[string][]string{}
	var names []string
	if err := scanRows(ctx, db.conn(), `SELECT name FROM sqlite_master WHERE type = 'table'`, func(rows *sql.Rows) error {
		var name string
		if err := rows.Scan(&name); err != nil {
			return err
		}
		names = append(names, name)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if err := scanRows(ctx, db.conn(), `SELECT name FROM pragma_table_info(?)`, func(rows *sql.Rows) error {
			var column string
			if err := rows.Scan(&column); err != nil {
				return err
			}
			tables[name] = append(tables[name], column)
			return nil
		}, name); err != nil {
			t.Fatal(err)
		}
	}
	return tables
}

// rowsNaming counts, per table.column, the rows whose column holds value,
// leaving out the columns that name a workspace without belonging to it.
func rowsNaming(t *testing.T, db *Store, column, value string) map[string]int {
	t.Helper()
	found := map[string]int{}
	for table, columns := range tableColumns(t, db) {
		for _, name := range columns {
			if name != column || unownedOwnerColumns[table+"."+column] != "" {
				continue
			}
			var count int
			if err := db.conn().QueryRowContext(context.Background(),
				`SELECT count(*) FROM `+table+` WHERE `+column+` = ?`, value).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count > 0 {
				found[table+"."+column] = count
			}
		}
	}
	return found
}

func countRows(t *testing.T, db *Store, query string, args ...any) int {
	t.Helper()
	var count int
	if err := db.conn().QueryRowContext(context.Background(), query, args...).Scan(&count); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return count
}

func execAll(t *testing.T, db *Store, statements ...string) {
	t.Helper()
	for _, statement := range statements {
		if _, err := db.conn().ExecContext(context.Background(), statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
}

func registerOtherWorkspace(t *testing.T, db *Store) {
	t.Helper()
	other := homeRegistration("dev_home", "byte-dev")
	other.Workspace = store.WorkspaceProjection{ID: "ws_other", Name: "Other", LocalPath: "/home/me/Other", Baseline: "main"}
	other.Agents, other.Assets, other.Chats = nil, nil, nil
	if err := db.RegisterDaemon(context.Background(), other); err != nil {
		t.Fatal(err)
	}
}

// A table keyed by a workspace, issue, run or session is deleted with its
// workspace and pruned when orphaned: it is listed in workspaceOwnedRows.
func TestEveryTableNamingAnOwnerIsOwned(t *testing.T) {
	db := newTestStore(t)
	owned := map[string]bool{}
	for _, rows := range workspaceOwnedRows {
		owned[rows.table+"."+rows.key] = true
	}
	for table, columns := range tableColumns(t, db) {
		for _, column := range columns {
			for _, ownerColumn := range ownerColumns {
				key := table + "." + column
				if column == ownerColumn && !owned[key] && unownedOwnerColumns[key] == "" {
					t.Errorf("%s names its %s but is not in workspaceOwnedRows", table, strings.TrimSuffix(column, "_id"))
				}
			}
		}
	}
}

// Deleting a workspace deletes every row it owns, directly or through its
// issues, runs and sessions. Before it did, the contract of the deleted
// workspace's issue iss_106 stayed behind, the next issue was numbered 106
// again, and creating it failed on the evidence_records unique key.
func TestDeleteWorkspaceLeavesNothingOfItsIssuesRunsOrSessions(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, homeRegistration("dev_home", "byte-dev")); err != nil {
		t.Fatal(err)
	}
	registerOtherWorkspace(t, db)

	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_home", SourceInput: "first", Runtime: "mock"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, db, issue.ID)
	run := store.Run{ID: "run_home", IssueID: issue.ID, WorkspaceID: "ws_home", Status: "running", Runtime: "mock"}
	if _, err := db.StartIssueRun(ctx, issue.ID, run); err != nil {
		t.Fatal(err)
	}
	if err := db.AppendRunEvent(ctx, store.RunEvent{ID: "evt_home", RunID: run.ID, Label: "event", Level: "info"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{RunID: run.ID,
		Artifact: store.AcceptanceArtifact{ID: "artifact_home", IssueID: issue.ID, Kind: "text", Title: "artifact"}}); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_home", AgentID: "agent_home", Provider: "claude", Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.MintAgentSessionToken(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "done", "native_home"); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordRequest(ctx, issue.ID+"/accept", "key_issue", "input", "response"); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordRequest(ctx, "agent-sessions/messages:"+session.ID, "key_session", "input", "response"); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if err := db.SaveFeishuChatThread(ctx, store.FeishuChatThread{RootMessageID: "om_home", WorkspaceID: "ws_home", ChatID: "oc_home",
		LatestSessionID: session.ID, IssueID: issue.ID, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	member, err := db.CreateUser(ctx, store.NewUser{Username: "bob", PasswordHash: "h", Role: store.RoleMember})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetWorkspaceMember(ctx, "ws_home", member.ID, store.WorkspaceRoleMember, "test"); err != nil {
		t.Fatal(err)
	}
	execAll(t, db,
		`INSERT INTO chat_queue_items (id, workspace_id, chat_id, position, text, created_at, updated_at)
			VALUES ('queued_home', 'ws_home', 'native_claude_home', 1, 'later', '', '')`,
		`INSERT INTO chat_queue_revisions (workspace_id, chat_id, revision) VALUES ('ws_home', 'native_claude_home', 1)`,
		`INSERT INTO workspace_skill_bindings (workspace_id, skill_id, updated_at) VALUES ('ws_home', 'skill_bound', '')`,
		`INSERT INTO workspace_skill_exclusions (workspace_id, skill_id) VALUES ('ws_home', 'skill_excluded')`,
		`INSERT INTO skill_bundle_selections (scope, owner_id, repository_id)
			VALUES ('workspace', 'ws_home', 'repo_on'), ('workspace-off', 'ws_home', 'repo_off')`,
		`INSERT INTO external_provider_apps (id, provider, owner_user_id, visibility, label, client_id, created_at, updated_at)
			VALUES ('xapp_home', 'feishu', '', 'personal', 'Bot', 'cli_home', '', '')`,
		`INSERT INTO feishu_bot_routes (id, app_id, workspace_id, kind, chat_id, created_at, updated_at)
			VALUES ('fbr_pair', 'xapp_home', 'ws_home', 'pairing', '', '', ''), ('fbr_chat', 'xapp_home', 'ws_home', 'chat', 'oc_home', '', '')`,
		`INSERT INTO agent_session_usage_backfills (session_id, backfilled_at) VALUES ('`+session.ID+`', '')`,
		`INSERT INTO pa_tasks (id, user_id, conversation_session_id, session_id, workspace_id, title, status, created_at, updated_at)
			VALUES ('task_home', '`+member.ID+`', 'sess_conversation', '`+session.ID+`', 'ws_home', 'work', 'running', '', '')`,
		`INSERT INTO pa_proposals (id, user_id, session_id, kind, workspace_id, spec_json, summary, status, created_at, expires_at)
			VALUES ('prop_home', '`+member.ID+`', 'sess_conversation', 'archive_workspace', 'ws_home', '{}', 'archive', 'pending', '', '')`,
	)

	if _, err := db.DeleteWorkspace(ctx, "ws_home"); err != nil {
		t.Fatal(err)
	}
	for column, value := range map[string]string{"workspace_id": "ws_home", "issue_id": issue.ID, "run_id": run.ID, "session_id": session.ID} {
		if left := rowsNaming(t, db, column, value); len(left) > 0 {
			t.Errorf("rows with %s %s left after deleting the workspace: %v", column, value, left)
		}
	}
	if left := countRows(t, db, `SELECT count(*) FROM evidence_requests WHERE scope IN (?, ?)`,
		issue.ID+"/accept", "agent-sessions/messages:"+session.ID); left != 0 {
		t.Errorf("%d request records of the deleted issue and session left", left)
	}
	if left := countRows(t, db, `SELECT count(*) FROM skill_bundle_selections WHERE owner_id = 'ws_home'`); left != 0 {
		t.Errorf("%d bundle selections of the deleted workspace left", left)
	}

	next, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_other", SourceInput: "second", Runtime: "mock"})
	if err != nil {
		t.Fatalf("create an issue after deleting the workspace of the last one: %v", err)
	}
	if next.ID == issue.ID {
		t.Fatalf("the new issue reuses the deleted issue's id %s", issue.ID)
	}
}

// Issue numbers are never handed out twice: not after the issue that had
// one was deleted with its workspace, and not after a restart.
func TestIssueNumbersAreNeverHandedOutTwice(t *testing.T) {
	path := t.TempDir() + "/foundry.db"
	db := openTestStore(t, path)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, homeRegistration("dev_home", "byte-dev")); err != nil {
		t.Fatal(err)
	}
	registerOtherWorkspace(t, db)
	create := func(db *Store, want string) {
		t.Helper()
		issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_other", SourceInput: want, Runtime: "mock"})
		if err != nil {
			t.Fatal(err)
		}
		if issue.ID != want || issue.ShortID != "ISS-"+strings.TrimPrefix(want, "iss_") {
			t.Fatalf("issue = %s %s, want %s", issue.ID, issue.ShortID, want)
		}
	}

	first, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_home", SourceInput: "first", Runtime: "mock"})
	if err != nil || first.ID != "iss_106" {
		t.Fatalf("first issue = %s %v, want iss_106", first.ID, err)
	}
	if _, err := db.DeleteWorkspace(ctx, "ws_home"); err != nil {
		t.Fatal(err)
	}
	create(db, "iss_107")
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	reopened := openTestStore(t, path)
	defer reopened.Close()
	create(reopened, "iss_108")
	// A number already taken by an issue stored another way (the demo seed
	// stores fixed ids) is skipped as well.
	execAll(t, reopened, `INSERT INTO issues (id, workspace_id, short_id, title, status, priority, runtime, payload_json, created_at, updated_at)
		VALUES ('iss_200', 'ws_other', 'ISS-200', 'stored', 'pending', 'medium', 'mock', '{}', '', '')`)
	create(reopened, "iss_201")
}

// Opening a database prunes the rows that workspace deletions left behind
// before they cascaded, logs how many, and hands out no issue number those
// rows still name. Rows that belong to nothing stay.
func TestOpenPrunesRowsOfDeletedWorkspacesIssuesRunsAndSessions(t *testing.T) {
	path := t.TempDir() + "/foundry.db"
	db := openTestStore(t, path)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, homeRegistration("dev_home", "byte-dev")); err != nil {
		t.Fatal(err)
	}
	live, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_home", SourceInput: "live", Runtime: "mock"})
	if err != nil {
		t.Fatal(err)
	}
	member, err := db.CreateUser(ctx, store.NewUser{Username: "bob", PasswordHash: "h", Role: store.RoleMember})
	if err != nil {
		t.Fatal(err)
	}
	execAll(t, db,
		// What deleting ws_gone, with issue iss_120 and session sess_gone,
		// left behind.
		`INSERT INTO evidence_records (id, workspace_id, issue_id, kind, sequence, payload_json)
			VALUES ('ctr_gone', 'ws_gone', 'iss_120', 'contract', 1, '{}')`,
		`INSERT INTO evidence_requests (scope, request_id, request_digest, response_json)
			VALUES ('iss_120/accept', 'key', 'sha', '{}'), ('agent-sessions/messages:sess_gone', 'key', 'sha', '{}')`,
		`INSERT INTO session_tokens (token_hash, session_id, created_at, last_used_at, expires_at)
			VALUES ('hash_gone', 'sess_gone', '', '', '')`,
		`INSERT INTO workspace_members (workspace_id, user_id, role, added_by, created_at)
			VALUES ('ws_gone', '`+member.ID+`', 'owner', 'device', '')`,
		`INSERT INTO chat_queue_items (id, workspace_id, chat_id, position, text, created_at, updated_at)
			VALUES ('queued_gone', 'ws_gone', 'chat_gone', 1, 'later', '', '')`,
		`INSERT INTO run_events (id, run_id, level, payload_json, created_at) VALUES ('evt_gone', 'run_gone', 'info', '{}', '')`,
		// An issue whose workspace is gone, with its contract and a run.
		`INSERT INTO issues (id, workspace_id, short_id, title, status, priority, runtime, payload_json, created_at, updated_at)
			VALUES ('iss_121', 'ws_gone', 'ISS-121', 'gone', 'pending', 'medium', 'mock', '{}', '', '')`,
		`INSERT INTO evidence_records (id, workspace_id, issue_id, kind, sequence, payload_json)
			VALUES ('ctr_gone_121', 'ws_gone', 'iss_121', 'contract', 1, '{}')`,
		`INSERT INTO runs (id, issue_id, workspace_id, status, runtime, payload_json, updated_at)
			VALUES ('run_gone_121', 'iss_121', 'ws_gone', 'completed', 'mock', '{}', '')`,
		`INSERT INTO run_events (id, run_id, level, payload_json, created_at) VALUES ('evt_gone_121', 'run_gone_121', 'info', '{}', '')`,
		// Rows of no workspace, issue or session.
		`INSERT INTO chats (id, title, payload_json, updated_at) VALUES ('chat_shared', 'shared', '{}', '')`,
		`INSERT INTO evidence_requests (scope, request_id, request_digest, response_json)
			VALUES ('issues/create', 'key', 'sha', '{}'), ('agent-sessions/create', 'key', 'sha', '{}')`,
		`INSERT INTO skill_bundle_selections (scope, owner_id, repository_id) VALUES ('user', '`+member.ID+`', 'repo_user')`,
	)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	var logged bytes.Buffer
	log.SetOutput(&logged)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	reopened := openTestStore(t, path)
	defer reopened.Close()

	want := "chat_queue_items=1 evidence_records=2 evidence_requests=2 issues=1 run_events=2 runs=1 session_tokens=1 workspace_members=1"
	if !strings.Contains(logged.String(), want) {
		t.Fatalf("log = %q, want counts %q", logged.String(), want)
	}
	for column, value := range map[string]string{"workspace_id": "ws_gone", "issue_id": "iss_120", "session_id": "sess_gone", "run_id": "run_gone"} {
		if left := rowsNaming(t, reopened, column, value); len(left) > 0 {
			t.Errorf("orphaned rows with %s %s left: %v", column, value, left)
		}
	}
	if left := countRows(t, reopened, `SELECT count(*) FROM evidence_requests WHERE scope IN ('iss_120/accept', 'agent-sessions/messages:sess_gone')`); left != 0 {
		t.Errorf("%d orphaned request records left", left)
	}
	if kept := countRows(t, reopened, `SELECT count(*) FROM evidence_records WHERE issue_id = ?`, live.ID); kept != 1 {
		t.Errorf("live issue has %d evidence records, want its contract", kept)
	}
	for query, want := range map[string]int{
		`SELECT count(*) FROM chats WHERE id = 'chat_shared'`:                                              1,
		`SELECT count(*) FROM evidence_requests WHERE scope IN ('issues/create', 'agent-sessions/create')`: 2,
		`SELECT count(*) FROM skill_bundle_selections WHERE scope = 'user'`:                                1,
	} {
		if got := countRows(t, reopened, query); got != want {
			t.Errorf("%s = %d, want %d", query, got, want)
		}
	}

	next, err := reopened.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_home", SourceInput: "next", Runtime: "mock"})
	if err != nil || next.ID != "iss_122" {
		t.Fatalf("next issue = %s %v, want iss_122 past the numbers only orphaned rows named", next.ID, err)
	}

	// Pruning again finds nothing.
	logged.Reset()
	if err := reopened.pruneOrphanedRows(ctx); err != nil {
		t.Fatal(err)
	}
	if logged.Len() != 0 {
		t.Fatalf("second prune logged %q", logged.String())
	}
}
