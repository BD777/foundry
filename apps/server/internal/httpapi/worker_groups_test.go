package httpapi

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (f accountsFixture) workerGroupActor(t *testing.T) Actor {
	t.Helper()
	user, err := f.db.GetUser(context.Background(), f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	return Actor{Kind: ActorAccount, Account: &user}
}

// A group's members come from different providers and runtimes; a new worker
// takes only a member whose provider runs on the workspace's device, then
// the one with the most quota left.
func TestWorkerGroupPicksAMemberItsDeviceCanRunAcrossProviders(t *testing.T) {
	f := newAccountsFixture(t)
	ctx := context.Background()
	actor := f.workerGroupActor(t)
	group, err := f.db.SaveWorkerGroup(ctx, store.StoredWorkerGroup{
		OwnerUserID: f.aliceID, Label: "Mixed",
		Members: []store.WorkerGroupMember{
			{ProviderKind: "api", ProviderID: f.service.ID, Runtime: "claude", Model: "service-model", Effort: "high", TokensPerMinute: 1_000},
			{ProviderKind: "discovered", ProviderID: accountsGateway, Runtime: "codex", Model: "gateway-model", TokensPerMinute: 100},
			{ProviderKind: "subscription", ProviderID: "claude_local", Runtime: "claude", Model: "opus", TokensPerMinute: 1_000_000},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// The model service is not assigned to the device and the login is not
	// signed in there: only the gateway can run.
	choice, err := f.server.selectWorkerGroup(ctx, actor, group.ID, "ws_budget")
	if err != nil || choice.Member.ProviderID != accountsGateway || choice.Member.Runtime != "codex" || choice.Member.Model != "gateway-model" {
		t.Fatalf("before assigning the service: %+v, %v", choice.Member, err)
	}

	if err := f.db.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: "dev_home", ProfileIDs: []string{f.service.ID}}); err != nil {
		t.Fatal(err)
	}
	choice, err = f.server.selectWorkerGroup(ctx, actor, group.ID, "ws_budget")
	if err != nil || choice.Member.ProviderID != f.service.ID || choice.Member.Runtime != "claude" || choice.Member.Effort != "high" {
		t.Fatalf("after assigning the service: %+v, %v", choice.Member, err)
	}
}

func TestWorkerGroupWithNoUsableMemberRefusesAndListsWhy(t *testing.T) {
	f := newAccountsFixture(t)
	ctx := context.Background()
	group, err := f.db.SaveWorkerGroup(ctx, store.StoredWorkerGroup{
		OwnerUserID: f.aliceID, Label: "Offline",
		Members: []store.WorkerGroupMember{
			{ProviderKind: "subscription", ProviderID: "claude_local", Runtime: "claude", Model: "opus"},
			{ProviderKind: "api", ProviderID: f.service.ID, Runtime: "claude", Model: "service-model"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.server.selectWorkerGroup(ctx, f.workerGroupActor(t), group.ID, "ws_budget")
	var refusal *statusError
	if !errors.As(err, &refusal) {
		t.Fatalf("selecting from a group with no usable member: %v", err)
	}
	for _, want := range []string{"no_usable_worker_group_member", "Offline", "opus on claude_local (not signed in)", "service-model on " + f.service.ID + " (not assigned to this device)"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("refusal %q does not say %q", err, want)
		}
	}
}

func TestExecutionDefaultCanBeAWorkerGroup(t *testing.T) {
	f := newAccountsFixture(t)
	ctx := context.Background()
	actor := f.workerGroupActor(t)
	group, err := f.db.SaveWorkerGroup(ctx, store.StoredWorkerGroup{
		OwnerUserID: f.aliceID, Label: "Workers",
		Members: []store.WorkerGroupMember{{ProviderKind: "discovered", ProviderID: accountsGateway, Runtime: "codex", Model: "gateway-model"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	view, err := f.server.saveExecutionDefault(ctx, actor, "", executionDefaultRequest{WorkerGroupID: group.ID})
	if err != nil || view.Effective.WorkerGroupID != group.ID || view.Effective.Group == nil || view.Effective.Group.Label != "Workers" ||
		view.Effective.ProviderID != "" || view.Effective.Model != "" {
		t.Fatalf("group default = %+v, %v", view.Effective, err)
	}
	if _, err := f.server.saveExecutionDefault(ctx, actor, "", executionDefaultRequest{WorkerGroupID: group.ID, ProviderID: accountsGateway, Runtime: "codex", Model: "x"}); err == nil {
		t.Fatal("a default naming both a group and a model was accepted")
	}
	if _, err := f.server.saveExecutionDefault(ctx, actor, "", executionDefaultRequest{WorkerGroupID: "wgroup_missing"}); err == nil {
		t.Fatal("a default naming a missing group was accepted")
	}
}
