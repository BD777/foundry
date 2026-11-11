package sqlitestore

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestPersonalAgentIsOnePerPersonAndWorkspace(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	if _, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: "user_a", WorkspaceID: "ws_pa", HomeDeviceID: "dev_a"}); err != nil {
		t.Fatal(err)
	}
	for _, again := range []store.PersonalAgent{{UserID: "user_a", WorkspaceID: "ws_other"}, {UserID: "user_b", WorkspaceID: "ws_pa"}} {
		if _, err := db.CreatePersonalAgent(ctx, again); !errors.Is(err, store.ErrPersonalAgentExists) {
			t.Errorf("second assistant %+v: %v", again, err)
		}
	}
	stopped, err := db.SetPersonalAgentState(ctx, "user_a", store.PersonalAgentStopped)
	if err != nil || stopped.State != store.PersonalAgentStopped || stopped.StoppedAt == "" {
		t.Fatalf("stopped = %+v (%v)", stopped, err)
	}
	if agent, err := db.PersonalAgentForWorkspace(ctx, "ws_pa"); err != nil || agent.UserID != "user_a" {
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
		len(pkg.ConnectorAccounts) != 0 || len(pkg.DevicesResources.DirectLeaseAllowed) != 0 ||
		len(pkg.Skills.Include) != 0 || len(pkg.Skills.Exclude) != 0 {
		t.Fatalf("default package = %+v (%v)", pkg, err)
	}
	agent, err := db.SetPersonalAgentConnectorLevels(ctx, "user_a", []store.ConnectorAccountPermission{
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
	agent, err = db.SetPersonalAgentConnectorLevels(ctx, "user_a", nil)
	if err != nil {
		t.Fatal(err)
	}
	pkg, err = db.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil || len(pkg.ConnectorAccounts) != 0 {
		t.Fatalf("cleared = %+v (%v)", pkg.ConnectorAccounts, err)
	}
}

func TestPermissionPackageMigrationCarriesLegacyConnectorOptOut(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	created, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: "user_legacy", WorkspaceID: "ws_legacy", HomeDeviceID: "dev_legacy"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.conn().ExecContext(ctx, `UPDATE personal_agents
		SET permission_package_id = '', connector_opt_out = '["acct_off"]'
		WHERE user_id = ?`, created.UserID); err != nil {
		t.Fatal(err)
	}
	if err := db.setupPermissionPackages(ctx); err != nil {
		t.Fatal(err)
	}
	agent, err := db.GetPersonalAgent(ctx, created.UserID)
	if err != nil || agent.PermissionPackageID == "" || agent.PermissionPackageID == created.PermissionPackageID {
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

// A proposal is answered once, and expires.
func TestPersonalAgentProposalsAreAnsweredOnce(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	past := formatTime(time.Now().Add(-time.Minute))
	future := formatTime(time.Now().Add(time.Hour))
	live, _ := db.CreatePersonalAgentProposal(ctx, store.PersonalAgentProposal{UserID: "user_a", Kind: store.PersonalAgentActionArchive, ExpiresAt: future, Spec: json.RawMessage(`{"workspaceId":"ws_a"}`)})
	stale, _ := db.CreatePersonalAgentProposal(ctx, store.PersonalAgentProposal{UserID: "user_a", Kind: store.PersonalAgentActionArchive, ExpiresAt: past})
	if count, err := db.ExpirePersonalAgentProposals(ctx, "user_a", formatTime(time.Now())); err != nil || count != 1 {
		t.Fatalf("expired %d (%v)", count, err)
	}
	if got, _ := db.GetPersonalAgentProposal(ctx, "user_a", stale.ID); got.Status != store.PersonalAgentProposalExpired {
		t.Fatalf("stale = %+v", got)
	}
	pending := []string{store.PersonalAgentProposalPending}
	if _, err := db.SetPersonalAgentProposalStatus(ctx, "user_b", live.ID, pending, store.PersonalAgentProposalAccepted, store.PersonalAgentViaWeb, ""); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another person answered: %v", err)
	}
	accepted, err := db.SetPersonalAgentProposalStatus(ctx, "user_a", live.ID, pending, store.PersonalAgentProposalAccepted, store.PersonalAgentViaWeb, "")
	if err != nil || accepted.DecidedVia != store.PersonalAgentViaWeb || accepted.DecidedAt == "" || string(accepted.Spec) != `{"workspaceId":"ws_a"}` {
		t.Fatalf("accepted = %+v (%v)", accepted, err)
	}
	if _, err := db.SetPersonalAgentProposalStatus(ctx, "user_a", live.ID, pending, store.PersonalAgentProposalAccepted, store.PersonalAgentViaWeb, ""); !errors.Is(err, store.ErrPersonalAgentProposalSettled) {
		t.Fatalf("answered twice: %v", err)
	}
}

func TestPersonalAgentAuditFindsCreatedProjectsAndBoundAccounts(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	record := func(tool, workspaceID, outcome, args string) {
		if _, err := db.RecordPersonalAgentAction(ctx, store.PersonalAgentActionRecord{UserID: "user_a", Tool: tool, WorkspaceID: workspaceID, Outcome: outcome}, json.RawMessage(args)); err != nil {
			t.Fatal(err)
		}
	}
	record(store.PersonalAgentActionCreateWorkspace, "ws_new", store.PersonalAgentOutcomeApplied, `{}`)
	record("update_workspace", "ws_new", store.PersonalAgentOutcomeApplied, `{"connectors":{"add":["acct_1"]}}`)
	record("update_workspace", "ws_new", store.PersonalAgentOutcomeRefused, `{"connectors":{"add":["acct_2"]}}`)
	if created, _ := db.PersonalAgentCreatedWorkspace(ctx, "user_a", "ws_new"); !created {
		t.Error("the created project is not found")
	}
	if created, _ := db.PersonalAgentCreatedWorkspace(ctx, "user_a", "ws_old"); created {
		t.Error("a project the assistant did not create")
	}
	for account, want := range map[string]bool{"acct_1": true, "acct_2": false} {
		if bound, err := db.PersonalAgentConnectorBoundBefore(ctx, "user_a", "ws_new", account); err != nil || bound != want {
			t.Errorf("%s bound before = %v (%v)", account, bound, err)
		}
	}
	agent := store.PersonalAgent{UserID: "user_a", WorkspaceID: "ws_pa"}
	usage, err := db.PersonalAgentUsage(ctx, agent, store.PersonalAgentWindows{
		HourAgo: formatTime(time.Now().Add(-time.Hour)), DayStart: formatTime(time.Now().Add(-time.Hour)),
		WeekStart: formatTime(time.Now().Add(-time.Hour)), MonthStart: formatTime(time.Now().Add(-time.Hour)),
	})
	if err != nil || usage.WorkspacesToday != 1 || usage.WorkspacesThisWeek != 1 {
		t.Fatalf("usage = %+v (%v)", usage, err)
	}
}
