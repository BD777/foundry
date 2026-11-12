package sqlitestore

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A pre-DEV-191 personal_agents row becomes its person's default assistant
// with every field as it was, its records are backfilled with the new id, and
// migrating again (including over a personal_agents table an older binary
// recreated) changes nothing.
func TestLegacyPersonalAgentBecomesTheDefaultAssistant(t *testing.T) {
	ctx := context.Background()
	path := t.TempDir() + "/foundry.db"
	legacy := openTestStore(t, path)
	pkg, err := legacy.createDefaultPermissionPackage(ctx, "person")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.AddPersonalAgentMemory(ctx, store.PersonalAgentMemoryItem{UserID: "person", Content: "likes tea",
		Origin: store.PersonalAgentMemoryStated, Status: store.PersonalAgentMemoryActive}); err != nil {
		t.Fatal(err)
	}
	execAll(t, legacy, legacyPersonalAgentsSchema,
		`INSERT INTO personal_agents (user_id, workspace_id, home_device_id, state, settings_json, permission_package_id, prompt_version,
			created_at, updated_at, stopped_at, former_workspace_ids, digest_sent_on, connector_opt_out)
			VALUES ('person', 'ws_home', 'dev_home', 'stopped', '{"assistantName":"Mo","timezone":"Asia/Shanghai"}', '`+pkg.ID+`', 'v3',
			'2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', '["ws_before"]', '2026-01-02', '[]')`,
		`INSERT INTO pa_tasks (id, user_id, conversation_session_id, session_id, workspace_id, title, status, created_at, updated_at)
			VALUES ('task_legacy', 'person', 'sess_conv', '', 'ws_work', 'work', 'running', '', '')`,
		`INSERT INTO pa_tasks (id, user_id, conversation_session_id, session_id, workspace_id, title, status, created_at, updated_at)
			VALUES ('task_stranger', 'stranger', 'sess_other', '', 'ws_other', 'work', 'running', '', '')`,
		`INSERT INTO pending_items (id, user_id, workspace_id, source, item_key, state, payload_json, created_at, updated_at, handler)
			VALUES ('pend_assistant', 'person', 'ws_work', 'session', 'k1', 'open', '{}', '', '', 'assistant'),
			('pend_person', 'person', 'ws_work', 'session', 'k2', 'open', '{}', '', '', 'person')`,
	)
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	db := openTestStore(t, path)
	agent, err := db.DefaultAssistant(ctx, "person")
	if err != nil {
		t.Fatal(err)
	}
	want := store.PersonalAgent{
		ID: agent.ID, Name: "Mo", IsDefault: true, UserID: "person", WorkspaceID: "ws_home", HomeDeviceID: "dev_home",
		State:    store.PersonalAgentStopped,
		Settings: store.PersonalAgentSettings{AssistantName: "Mo", Timezone: "Asia/Shanghai"}, PermissionPackageID: pkg.ID,
		PromptVersion: "v3", CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-02T00:00:00Z", StoppedAt: "2026-01-03T00:00:00Z",
		FormerWorkspaceIDs: []string{"ws_before"},
	}
	if !reflect.DeepEqual(agent, want) || len(agent.ID) <= len("asst_") || agent.ID[:5] != "asst_" {
		t.Fatalf("migrated assistant =\n%+v\nwant\n%+v", agent, want)
	}
	if claimed, err := db.ClaimPersonalAgentDigest(ctx, agent.ID, "2026-01-02"); err != nil || claimed {
		t.Fatalf("the legacy digest day was not carried: %v (%v)", claimed, err)
	}
	for query, wanted := range map[string]int{
		`SELECT count(*) FROM sqlite_master WHERE name = 'personal_agents'`:                                    0,
		`SELECT count(*) FROM sqlite_master WHERE name = 'personal_agents_legacy'`:                             1,
		`SELECT count(*) FROM pa_tasks WHERE id = 'task_legacy' AND assistant_id = '` + agent.ID + `'`:         1,
		`SELECT count(*) FROM pa_tasks WHERE id = 'task_stranger' AND assistant_id = ''`:                       1,
		`SELECT count(*) FROM pa_memory WHERE user_id = 'person' AND assistant_id = '` + agent.ID + `'`:        1,
		`SELECT count(*) FROM pending_items WHERE id = 'pend_assistant' AND assistant_id = '` + agent.ID + `'`: 1,
		`SELECT count(*) FROM pending_items WHERE id = 'pend_person' AND assistant_id = ''`:                    1,
	} {
		if got := countRows(t, db, query); got != wanted {
			t.Errorf("%s = %d, want %d", query, got, wanted)
		}
	}
	if tasks, err := db.ListPersonalAgentTasks(ctx, agent.ID, nil); err != nil || len(tasks) != 1 || tasks[0].ID != "task_legacy" {
		t.Fatalf("backfilled tasks = %+v (%v)", tasks, err)
	}

	// An older binary recreates the old table with the same row; migrating
	// again keeps the one assistant, its id and the kept copy.
	execAll(t, db, legacyPersonalAgentsSchema,
		`INSERT INTO personal_agents (user_id, workspace_id, home_device_id, state, settings_json, created_at, updated_at)
			VALUES ('person', 'ws_home', 'dev_home', 'active', '{}', '', '')`)
	if err := db.setupAssistants(ctx); err != nil {
		t.Fatal(err)
	}
	if err := db.setupAssistantRecords(ctx); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = newTestStoreAtPath(t, path)
	agents, err := db.ListAssistants(ctx, "person")
	if err != nil || len(agents) != 1 || !reflect.DeepEqual(agents[0], agent) {
		t.Fatalf("after re-migration = %+v (%v), want %+v", agents, err, agent)
	}
	if got := countRows(t, db, `SELECT count(*) FROM sqlite_master WHERE name IN ('personal_agents', 'personal_agents_legacy')`); got != 1 {
		t.Fatalf("legacy tables = %d", got)
	}
}

// A person's later assistant is not the default and reaches no workspace
// until they add one; deleting it removes its records and package, and the
// default assistant cannot be deleted.
func TestSecondAssistantStartsWithNoWorkspacesAndCanBeDeleted(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	first, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: "person", WorkspaceID: "ws_home", HomeDeviceID: "dev_home"})
	if err != nil || !first.IsDefault {
		t.Fatalf("first = %+v (%v)", first, err)
	}
	second, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: "person", Name: "Research", WorkspaceID: "ws_second", HomeDeviceID: "dev_home"})
	if err != nil || second.IsDefault || second.ID == first.ID || second.PermissionPackageID == first.PermissionPackageID {
		t.Fatalf("second = %+v (%v)", second, err)
	}
	pkg, err := db.GetPermissionPackage(ctx, "person", second.PermissionPackageID)
	if err != nil || pkg.Workspaces.Scope != store.PermissionListScopeListed || len(pkg.Workspaces.Include) != 0 || len(pkg.Workspaces.Exclude) != 0 {
		t.Fatalf("second package = %+v (%v)", pkg.Workspaces, err)
	}
	if pkg.IdentityResources.Scope != store.PermissionListScopeListed || len(pkg.IdentityResources.Allowed) != 0 {
		t.Fatalf("second package identity resources = %+v", pkg.IdentityResources)
	}
	if pkg, err := db.GetPermissionPackage(ctx, "person", first.PermissionPackageID); err != nil || pkg.IdentityResources.Scope != store.PermissionListScopeAll {
		t.Fatalf("default package identity resources = %+v (%v)", pkg.IdentityResources, err)
	}
	if agents, err := db.ListAssistants(ctx, "person"); err != nil || len(agents) != 2 || agents[0].ID != first.ID || agents[1].ID != second.ID {
		t.Fatalf("assistants = %+v (%v)", agents, err)
	}
	if def, err := db.DefaultAssistant(ctx, "person"); err != nil || def.ID != first.ID {
		t.Fatalf("default = %+v (%v)", def, err)
	}

	for _, agent := range []store.PersonalAgent{first, second} {
		if _, err := db.CreatePersonalAgentTask(ctx, store.PersonalAgentTask{UserID: "person", AssistantID: agent.ID, WorkspaceID: "ws_work", Title: "work"}); err != nil {
			t.Fatal(err)
		}
		if _, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentListItem{UserID: "person", AssistantID: agent.ID, Text: "an item"}); err != nil {
			t.Fatal(err)
		}
	}

	if err := db.DeleteAssistant(ctx, first.ID); !errors.Is(err, store.ErrAssistantIsDefault) {
		t.Fatalf("deleted the default: %v", err)
	}
	if err := db.DeleteAssistant(ctx, second.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.GetAssistant(ctx, second.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted assistant: %v", err)
	}
	if _, err := db.GetPermissionPackage(ctx, "person", second.PermissionPackageID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted assistant's package: %v", err)
	}
	if tasks, _ := db.ListPersonalAgentTasks(ctx, second.ID, nil); len(tasks) != 0 {
		t.Fatalf("deleted assistant's tasks = %+v", tasks)
	}
	if items, _ := db.ListPersonalAgentItems(ctx, second.ID, ""); len(items) != 0 {
		t.Fatalf("deleted assistant's items = %+v", items)
	}
	if tasks, _ := db.ListPersonalAgentTasks(ctx, first.ID, nil); len(tasks) != 1 {
		t.Fatalf("the default's tasks = %+v", tasks)
	}
	if items, _ := db.ListPersonalAgentItems(ctx, first.ID, ""); len(items) != 1 {
		t.Fatalf("the default's items = %+v", items)
	}
	// Its workspace is free for a new assistant.
	if _, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: "person", WorkspaceID: "ws_second", HomeDeviceID: "dev_home"}); err != nil {
		t.Fatalf("workspace not released: %v", err)
	}
}

// The direct-chat introduction belongs to an assistant and app, not to the
// person and app. The old key is rebuilt once, preserving its rows, and
// another assistant cannot reserve the same app.
func TestDirectChatIntroductionsArePerAssistantAndMigrateIdempotently(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	first, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{
		UserID: "person", Name: "Personal", WorkspaceID: "ws_first", HomeDeviceID: "dev_home",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{
		UserID: "person", Name: "Research", WorkspaceID: "ws_second", HomeDeviceID: "dev_home",
	})
	if err != nil {
		t.Fatal(err)
	}
	execAll(t, db,
		`DROP TABLE pa_direct_chats`,
		`CREATE TABLE pa_direct_chats (
			user_id TEXT NOT NULL,
			assistant_id TEXT NOT NULL DEFAULT '',
			app_id TEXT NOT NULL,
			introduced_at TEXT NOT NULL,
			PRIMARY KEY (user_id, app_id)
		)`,
		`INSERT INTO pa_direct_chats (user_id, assistant_id, app_id, introduced_at) VALUES
			('person', '`+first.ID+`', 'xapp_first', '2026-11-12T00:00:00Z'),
			('person', '`+second.ID+`', 'xapp_second', '2026-11-12T00:00:00Z')`,
	)
	for attempt := 0; attempt < 2; attempt++ {
		if err := db.setupAssistantRecords(ctx); err != nil {
			t.Fatalf("migration attempt %d: %v", attempt+1, err)
		}
	}
	rows, err := db.conn().QueryContext(ctx, `PRAGMA table_info(pa_direct_chats)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	primary := map[string]int{}
	for rows.Next() {
		var cid, notNull, pk int
		var name, kind string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &kind, &notNull, &defaultValue, &pk); err != nil {
			t.Fatal(err)
		}
		if pk > 0 {
			primary[name] = pk
		}
	}
	if primary["assistant_id"] == 0 || primary["app_id"] == 0 || primary["user_id"] != 0 {
		t.Fatalf("pa_direct_chats primary key = %v", primary)
	}
	for _, test := range []struct {
		assistantID string
		appID       string
		want        int
	}{
		{first.ID, "xapp_first", 1},
		{second.ID, "xapp_second", 1},
	} {
		if got := countRows(t, db, `SELECT count(*) FROM pa_direct_chats WHERE assistant_id = '`+test.assistantID+`' AND app_id = '`+test.appID+`'`); got != test.want {
			t.Fatalf("%s/%s rows = %d", test.assistantID, test.appID, got)
		}
	}
	if claimed, err := db.ClaimPersonalAgentChatIntroduction(ctx, first.ID, "person", "xapp_first"); err != nil || claimed {
		t.Fatalf("the preserved introduction was claimed again: %v %v", claimed, err)
	}

	first.Settings.FeishuAppID = "xapp_shared"
	if _, err := db.SavePersonalAgentSettings(ctx, first.ID, first.Settings); err != nil {
		t.Fatal(err)
	}
	second.Settings.FeishuAppID = "xapp_shared"
	if _, err := db.SavePersonalAgentSettings(ctx, second.ID, second.Settings); err == nil {
		t.Fatal("two assistants reserved one Feishu app")
	} else {
		var inUse *store.PersonalAgentFeishuAppInUse
		if !errors.As(err, &inUse) || inUse.AssistantID != first.ID || !strings.Contains(err.Error(), "Personal") {
			t.Fatalf("conflict = %v", err)
		}
	}
}
