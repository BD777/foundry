package sqlitestore

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestPersonalAgentIsOnePerPersonAndWorkspace(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	first, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: "user_a", WorkspaceID: "ws_pa", HomeDeviceID: "dev_a"})
	if err != nil || !first.IsDefault || first.ID == "" {
		t.Fatalf("first assistant = %+v (%v)", first, err)
	}
	// One default per person, one assistant per workspace.
	for _, again := range []store.PersonalAgent{{UserID: "user_a", WorkspaceID: "ws_other", IsDefault: true}, {UserID: "user_b", WorkspaceID: "ws_pa"}} {
		if _, err := db.CreatePersonalAgent(ctx, again); !errors.Is(err, store.ErrPersonalAgentExists) {
			t.Errorf("second assistant %+v: %v", again, err)
		}
	}
	stopped, err := db.SetPersonalAgentState(ctx, first.ID, store.PersonalAgentStopped)
	if err != nil || stopped.State != store.PersonalAgentStopped || stopped.StoppedAt == "" {
		t.Fatalf("stopped = %+v (%v)", stopped, err)
	}
	if agent, err := db.AssistantForWorkspace(ctx, "ws_pa"); err != nil || agent.UserID != "user_a" || agent.ID != first.ID {
		t.Fatalf("by workspace = %+v (%v)", agent, err)
	}
	if _, err := db.GetPersonalAgent(ctx, "user_b"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("no assistant: %v", err)
	}
}

func TestPersonalAgentPermissionPackageDefaultsAndConnectorLevels(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	created, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: "user_a", WorkspaceID: "ws_pa", HomeDeviceID: "dev_a"})
	if err != nil || created.PermissionPackageID == "" {
		t.Fatalf("created = %+v (%v)", created, err)
	}
	pkg, err := db.GetPermissionPackage(ctx, "user_a", created.PermissionPackageID)
	if err != nil || len(pkg.Workspaces.Include) != 0 || len(pkg.Workspaces.Exclude) != 0 ||
		len(pkg.ConnectorAccounts) != 0 || len(pkg.IdentityResources.Allowed) != 0 {
		t.Fatalf("default package = %+v (%v)", pkg, err)
	}
	agent, err := db.SetPersonalAgentConnectorLevels(ctx, created.ID, []store.ConnectorAccountPermission{
		{AccountID: "acct_b", Level: store.ConnectorAccessLevelOff},
		{AccountID: "acct_a", Level: store.ConnectorAccessLevelRead},
	})
	if err != nil {
		t.Fatal(err)
	}
	pkg, err = db.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil || len(pkg.ConnectorAccounts) != 2 ||
		pkg.ConnectorAccounts[0].AccountID != "acct_b" || pkg.ConnectorAccounts[0].Level != store.ConnectorAccessLevelOff ||
		pkg.ConnectorAccounts[1].AccountID != "acct_a" || pkg.ConnectorAccounts[1].Level != store.ConnectorAccessLevelRead {
		t.Fatalf("levels = %+v (%v)", pkg.ConnectorAccounts, err)
	}
	agent, err = db.SetPersonalAgentConnectorLevels(ctx, created.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	pkg, err = db.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil || len(pkg.ConnectorAccounts) != 0 {
		t.Fatalf("cleared = %+v (%v)", pkg.ConnectorAccounts, err)
	}
}

// legacyPersonalAgentsSchema is the personal_agents table before DEV-191.
const legacyPersonalAgentsSchema = `CREATE TABLE personal_agents (
	user_id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL UNIQUE,
	home_device_id TEXT NOT NULL,
	state TEXT NOT NULL,
	settings_json TEXT NOT NULL,
	permission_package_id TEXT NOT NULL DEFAULT '',
	prompt_version TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	stopped_at TEXT NOT NULL DEFAULT '',
	former_workspace_ids TEXT NOT NULL DEFAULT '[]',
	digest_sent_on TEXT NOT NULL DEFAULT '',
	connector_opt_out TEXT NOT NULL DEFAULT '[]'
)`

// reopenWithLegacyPersonalAgent writes a pre-DEV-191 personal_agents table
// (with the given extra statements) into a fresh database and reopens it, so
// every migration runs on it.
func reopenWithLegacyPersonalAgent(t *testing.T, statements ...string) *Store {
	t.Helper()
	path := t.TempDir() + "/foundry.db"
	db := openTestStore(t, path)
	for _, statement := range append([]string{legacyPersonalAgentsSchema}, statements...) {
		if _, err := db.conn().ExecContext(context.Background(), statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return newTestStoreAtPath(t, path)
}

func TestPermissionPackageMigrationCarriesLegacyConnectorOptOut(t *testing.T) {
	ctx := context.Background()
	db := reopenWithLegacyPersonalAgent(t, `INSERT INTO personal_agents (user_id, workspace_id, home_device_id, state, settings_json,
		permission_package_id, created_at, updated_at, connector_opt_out)
		VALUES ('user_legacy', 'ws_legacy', 'dev_legacy', 'active', '{}', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '["acct_off"]')`)
	agent, err := db.DefaultAssistant(ctx, "user_legacy")
	if err != nil || !agent.IsDefault || agent.WorkspaceID != "ws_legacy" || agent.PermissionPackageID == "" {
		t.Fatalf("migrated assistant = %+v (%v)", agent, err)
	}
	pkg, err := db.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil || len(pkg.ConnectorAccounts) != 1 ||
		pkg.ConnectorAccounts[0].AccountID != "acct_off" || pkg.ConnectorAccounts[0].Level != store.ConnectorAccessLevelOff {
		t.Fatalf("migrated package = %+v (%v)", pkg, err)
	}
}

// Forgetting erases the item and everything it replaced; another person's
// items are out of reach.
func TestPersonalAgentMemoryForgetsTheWholeChain(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	first, err := db.AddPersonalAgentMemory(ctx, store.PersonalAgentMemoryItem{UserID: "user_a", Content: "likes tea", Origin: store.PersonalAgentMemoryStated, Status: store.PersonalAgentMemoryActive})
	if err != nil || first.VerifiedAt == "" {
		t.Fatalf("add = %+v (%v)", first, err)
	}
	second, err := db.SupersedePersonalAgentMemory(ctx, "user_a", first.ID, store.PersonalAgentMemoryItem{Content: "likes green tea", Origin: store.PersonalAgentMemoryEdited, Status: store.PersonalAgentMemoryActive})
	if err != nil || second.Supersedes != first.ID {
		t.Fatalf("supersede = %+v (%v)", second, err)
	}
	if _, err := db.SupersedePersonalAgentMemory(ctx, "user_b", second.ID, store.PersonalAgentMemoryItem{Content: "x"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another person superseded: %v", err)
	}
	if err := db.ForgetPersonalAgentMemory(ctx, "user_a", second.ID); err != nil {
		t.Fatal(err)
	}
	items, err := db.ListPersonalAgentMemory(ctx, "user_a")
	if err != nil || len(items) != 2 {
		t.Fatalf("items = %+v (%v)", items, err)
	}
	for _, item := range items {
		if item.Content != "" || item.Status != store.PersonalAgentMemoryForgotten {
			t.Errorf("not forgotten: %+v", item)
		}
	}
	pending, _ := db.AddPersonalAgentMemory(ctx, store.PersonalAgentMemoryItem{UserID: "user_a", Content: "lives in Paris", Origin: store.PersonalAgentMemoryExternal, Status: store.PersonalAgentMemoryPending})
	confirmed, err := db.ConfirmPersonalAgentMemory(ctx, "user_a", pending.ID)
	if err != nil || confirmed.Status != store.PersonalAgentMemoryActive || confirmed.Origin != store.PersonalAgentMemoryEdited {
		t.Fatalf("confirmed = %+v (%v)", confirmed, err)
	}
	if count, err := db.ForgetAllPersonalAgentMemory(ctx, "user_a"); err != nil || count != 1 {
		t.Fatalf("forget all = %d (%v)", count, err)
	}
}

// A proposal is answered once, and expires; another assistant's are out of
// reach.
func TestPersonalAgentProposalsAreAnsweredOnce(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	past := formatTime(time.Now().Add(-time.Minute))
	future := formatTime(time.Now().Add(time.Hour))
	live, _ := db.CreatePersonalAgentProposal(ctx, store.PersonalAgentProposal{UserID: "user_a", AssistantID: "asst_a", Kind: store.PersonalAgentActionArchive, ExpiresAt: future, Spec: json.RawMessage(`{"workspaceId":"ws_a"}`)})
	stale, _ := db.CreatePersonalAgentProposal(ctx, store.PersonalAgentProposal{UserID: "user_a", AssistantID: "asst_a", Kind: store.PersonalAgentActionArchive, ExpiresAt: past})
	if count, err := db.ExpirePersonalAgentProposals(ctx, "asst_a", formatTime(time.Now())); err != nil || count != 1 {
		t.Fatalf("expired %d (%v)", count, err)
	}
	if got, _ := db.GetPersonalAgentProposal(ctx, "asst_a", stale.ID); got.Status != store.PersonalAgentProposalExpired {
		t.Fatalf("stale = %+v", got)
	}
	pending := []string{store.PersonalAgentProposalPending}
	if _, err := db.SetPersonalAgentProposalStatus(ctx, "asst_b", live.ID, pending, store.PersonalAgentProposalAccepted, store.PersonalAgentViaWeb, ""); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another person answered: %v", err)
	}
	accepted, err := db.SetPersonalAgentProposalStatus(ctx, "asst_a", live.ID, pending, store.PersonalAgentProposalAccepted, store.PersonalAgentViaWeb, "")
	if err != nil || accepted.DecidedVia != store.PersonalAgentViaWeb || accepted.DecidedAt == "" || string(accepted.Spec) != `{"workspaceId":"ws_a"}` {
		t.Fatalf("accepted = %+v (%v)", accepted, err)
	}
	if _, err := db.SetPersonalAgentProposalStatus(ctx, "asst_a", live.ID, pending, store.PersonalAgentProposalAccepted, store.PersonalAgentViaWeb, ""); !errors.Is(err, store.ErrPersonalAgentProposalSettled) {
		t.Fatalf("answered twice: %v", err)
	}
}

func TestPersonalAgentAuditFindsCreatedProjectsAndBoundAccounts(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	record := func(tool, workspaceID, outcome, args string) {
		if _, err := db.RecordPersonalAgentAction(ctx, store.PersonalAgentActionRecord{UserID: "user_a", AssistantID: "asst_a", Tool: tool, WorkspaceID: workspaceID, Outcome: outcome}, json.RawMessage(args)); err != nil {
			t.Fatal(err)
		}
	}
	record(store.PersonalAgentActionCreateWorkspace, "ws_new", store.PersonalAgentOutcomeApplied, `{}`)
	record("update_workspace", "ws_new", store.PersonalAgentOutcomeApplied, `{"connectors":{"add":["acct_1"]}}`)
	record("update_workspace", "ws_new", store.PersonalAgentOutcomeRefused, `{"connectors":{"add":["acct_2"]}}`)
	if created, _ := db.PersonalAgentCreatedWorkspace(ctx, "asst_a", "ws_new"); !created {
		t.Error("the created project is not found")
	}
	if created, _ := db.PersonalAgentCreatedWorkspace(ctx, "asst_a", "ws_old"); created {
		t.Error("a project the assistant did not create")
	}
	for account, want := range map[string]bool{"acct_1": true, "acct_2": false} {
		if bound, err := db.PersonalAgentConnectorBoundBefore(ctx, "asst_a", "ws_new", account); err != nil || bound != want {
			t.Errorf("%s bound before = %v (%v)", account, bound, err)
		}
	}
	agent := store.PersonalAgent{ID: "asst_a", UserID: "user_a", WorkspaceID: "ws_pa"}
	usage, err := db.PersonalAgentUsage(ctx, agent, store.PersonalAgentWindows{
		HourAgo: formatTime(time.Now().Add(-time.Hour)), DayStart: formatTime(time.Now().Add(-time.Hour)),
		WeekStart: formatTime(time.Now().Add(-time.Hour)), MonthStart: formatTime(time.Now().Add(-time.Hour)),
	})
	if err != nil || usage.WorkspacesToday != 1 || usage.WorkspacesThisWeek != 1 {
		t.Fatalf("usage = %+v (%v)", usage, err)
	}
}

// DEV-191 P0: a package saved before identity resources keeps its direct
// lease devices as the identity resources known there (scope listed);
// without any, the default assistant keeps every identity resource (scope
// all) and a later assistant lists none. Skills are dropped.
func TestPermissionPackageMigratesDirectLeasesToIdentityResources(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	leasing, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: "user_a", WorkspaceID: "ws_pa", HomeDeviceID: "dev_a"})
	if err != nil {
		t.Fatal(err)
	}
	later, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: "user_a", WorkspaceID: "ws_pa_2", HomeDeviceID: "dev_a"})
	if err != nil {
		t.Fatal(err)
	}
	plain, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: "user_b", WorkspaceID: "ws_pb", HomeDeviceID: "dev_b"})
	if err != nil {
		t.Fatal(err)
	}
	legacy := func(agent store.PersonalAgent, devices string) string {
		return `{"id":"` + agent.PermissionPackageID + `","owner":"` + agent.UserID + `",` +
			`"workspaces":{"include":[],"exclude":["ws_x"]},"connectorAccounts":[],` +
			`"devicesResources":{"directLeaseAllowed":[` + devices + `]},"skills":{"include":["skill_a"],"exclude":[]}}`
	}
	now := paNow()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO resource_sources (id, kind) VALUES ('dev_a', 'device'), ('dev_b', 'device')`, nil},
		{`INSERT INTO resource_instances (id, source_id, key, type, platform, name, state, discovered_at, last_seen_at) VALUES
			('res_browser_a', 'dev_a', 'browser/chrome', 'browser', 'macos', 'Chrome', 'available', ?, ?),
			('res_compute_a', 'dev_a', 'compute', 'compute', 'macos', 'Compute', 'available', ?, ?),
			('res_browser_b', 'dev_b', 'browser/chrome', 'browser', 'macos', 'Chrome', 'available', ?, ?)`, []any{now, now, now, now, now, now}},
		{`UPDATE permission_packages SET payload_json = ? WHERE id = ?`, []any{legacy(leasing, `"dev_a"`), leasing.PermissionPackageID}},
		{`UPDATE permission_packages SET payload_json = ? WHERE id = ?`, []any{legacy(later, ``), later.PermissionPackageID}},
		{`UPDATE permission_packages SET payload_json = ? WHERE id = ?`, []any{legacy(plain, ``), plain.PermissionPackageID}},
	} {
		if _, err := db.conn().ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.setupPermissionPackages(ctx); err != nil {
		t.Fatal(err)
	}
	identity := func(agent store.PermissionPackage) string {
		return agent.IdentityResources.Scope + ":" + strings.Join(agent.IdentityResources.Allowed, ",")
	}
	for _, want := range []struct {
		agent store.PersonalAgent
		want  string
	}{{leasing, "listed:res_browser_a"}, {later, "listed:"}, {plain, "all:"}} {
		pkg, err := db.GetPermissionPackage(ctx, want.agent.UserID, want.agent.PermissionPackageID)
		if err != nil || identity(pkg) != want.want || len(pkg.Workspaces.Exclude) != 1 {
			t.Fatalf("migrated package of %s = %+v (%v), want identity %s", want.agent.ID, pkg, err, want.want)
		}
		var payload string
		if err := db.conn().QueryRowContext(ctx, `SELECT payload_json FROM permission_packages WHERE id = ?`, want.agent.PermissionPackageID).Scan(&payload); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(payload, "devicesResources") || strings.Contains(payload, "skills") {
			t.Fatalf("migrated payload kept the old fields: %s", payload)
		}
	}
	if err := db.setupPermissionPackages(ctx); err != nil {
		t.Fatalf("second run: %v", err)
	}
}

// AssistantForSession runs on every gateway request: its lookup of a
// dispatched step's session uses an index, not a scan of the payloads.
func TestAssistantForSessionUsesIndexes(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	rows, err := db.conn().QueryContext(ctx, `EXPLAIN QUERY PLAN SELECT assistant_id FROM pa_tasks WHERE session_id = ? AND assistant_id <> ''
		UNION ALL SELECT assistant_id FROM pa_operations WHERE json_extract(payload_json, '$.sessionId') = ? AND assistant_id <> ''
		LIMIT 1`, "s", "s")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	joined := strings.Join(plan, "; ")
	if !strings.Contains(joined, "idx_pa_tasks_session") || !strings.Contains(joined, "idx_pa_operations_session") || strings.Contains(joined, "SCAN") {
		t.Fatalf("plan = %s", joined)
	}
}
