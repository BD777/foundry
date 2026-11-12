package httpapi

import (
	"context"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/knowledge"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const packageRefusal = "the assistant's permissions do not include this workspace"

// An assistant whose permission package lists no workspace may still run
// the memory review of the person's shared layer (which it recalls anyway)
// in that layer's workspace; every other role there is refused by the
// package, and so is a memory review in another person's shared layer.
func TestMemoryReviewRunsInThePersonsLayerOutsideThePackage(t *testing.T) {
	f := newAssistantFixture(t)
	ctx, db := context.Background(), f.server.store
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_alice", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_work_pa", Name: "ws_work_pa", LocalPath: "/tmp/ws_work_pa"},
		Agents: []store.AgentProjection{{
			ID: "agent_ws_work_pa", WorkspaceID: "ws_work_pa", DeviceID: "dev_alice", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	work, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: f.aliceID, Name: "Work", WorkspaceID: "ws_work_pa", HomeDeviceID: "dev_alice"})
	if err != nil || work.IsDefault {
		t.Fatalf("new assistant = %+v (%v)", work, err)
	}
	pkg, err := db.GetPermissionPackage(ctx, f.aliceID, work.PermissionPackageID)
	if err != nil || pkg.Workspaces.Scope != store.PermissionListScopeListed || len(pkg.Workspaces.Include) != 0 {
		t.Fatalf("new assistant's workspaces = %+v (%v)", pkg.Workspaces, err)
	}
	refused := func(err error) bool { return err != nil && strings.Contains(err.Error(), packageRefusal) }

	// Before ws_alice holds the person's layer, the package refuses even
	// the memory review there.
	if _, err := f.server.runs.Resolve(ctx, work, "memory", "ws_alice"); !refused(err) {
		t.Fatalf("memory review outside the package without a person's layer: %v", err)
	}
	if _, err := db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: knowledge.MemoryLayerID(f.aliceID, ""), UserID: f.aliceID, Kind: "memory", WorkspaceID: "ws_alice", DeviceID: "dev_alice", RootPath: "knowledge"}); err != nil {
		t.Fatal(err)
	}
	vault, err := db.GetKnowledgeVault(ctx, f.aliceID, knowledge.MemoryLayerID(f.aliceID, ""))
	if err != nil || vault.Scope != store.MemoryScopePerson {
		t.Fatalf("person's layer = %+v (%v)", vault, err)
	}

	// (a) The memory review is allowed in the person's layer's workspace.
	if _, err := f.server.runs.Resolve(ctx, work, "memory", "ws_alice"); refused(err) {
		t.Fatalf("memory review of the person's layer refused by the package: %v", err)
	}
	// (b) Every other role there is still refused by the package.
	for _, role := range []string{"executor", "governance", "digest"} {
		if _, err := f.server.runs.Resolve(ctx, work, role, "ws_alice"); !refused(err) {
			t.Errorf("%s in the person's layer's workspace: %v (want the package refusal)", role, err)
		}
	}
	if _, err := f.server.runs.ResolveExecutor(ctx, work, "ws_alice", "default"); !refused(err) {
		t.Errorf("helper in the person's layer's workspace: %v (want the package refusal)", err)
	}
	if _, err := f.server.runs.Resolve(ctx, work, "coordinator", "ws_alice"); err == nil {
		t.Error("the coordinator ran outside its own workspace")
	}

	// (c) Another person's shared layer is not this person's: refused even
	// where alice may otherwise run upkeep (she owns ws_bob here).
	if err := db.SetWorkspaceMember(ctx, "ws_bob", f.aliceID, store.WorkspaceRoleOwner, f.bobID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: knowledge.MemoryLayerID(f.bobID, ""), UserID: f.bobID, Kind: "memory", WorkspaceID: "ws_bob", DeviceID: "dev_bob", RootPath: "knowledge"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.runs.Resolve(ctx, work, "memory", "ws_bob"); !refused(err) {
		t.Fatalf("memory review in another person's layer: %v (want the package refusal)", err)
	}
}
