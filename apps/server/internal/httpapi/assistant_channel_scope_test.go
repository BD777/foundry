package httpapi

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// DEV-281: an assistant's home reads the workspaces of its own message
// channels whatever its package narrows, and nothing else the package leaves out.
func TestAssistantHomeReadsItsOwnChannelWorkspaces(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := mustAgent(t, f)
	f.editPackage(t, func(pkg *store.PermissionPackage) {
		pkg.Workspaces = store.PermissionListRule{Scope: store.PermissionListScopeListed, Include: []string{}}
	})
	if err := f.server.store.SetWorkspaceKind(ctx, "ws_pa", store.WorkspaceKindPersonalAgent); err != nil {
		t.Fatal(err)
	}
	if err := f.server.store.SetWorkspaceMember(ctx, "ws_alice", f.aliceID, store.WorkspaceRoleMember, f.aliceID); err != nil {
		t.Fatal(err)
	}
	channel := store.MessageChannelRecord{UserID: f.aliceID, MessageChannel: store.MessageChannel{
		ID: "mch_scope", AssistantID: agent.ID, Name: "scope", SessionKey: "conversation", WorkspaceID: "ws_alice",
		Source: store.MessageChannelSource{Kind: "openlark", AccountID: "xacc_scope"}, CreatedAt: "2026-11-17T00:00:00Z", UpdatedAt: "2026-11-17T00:00:00Z",
	}}
	if err := f.server.store.(store.MessageChannelStore).SaveMessageChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	conversation, err := f.server.store.GetAgentSessionRecord(ctx, f.conversation.ID)
	if err != nil {
		t.Fatal(err)
	}
	access, err := permission.Resolve(ctx, f.server.store, conversation)
	if err != nil {
		t.Fatal(err)
	}
	if !access.Home || access.Agent.ID == "" {
		t.Fatalf("the conversation is not the assistant's home: home=%v agent=%q", access.Home, access.Agent.ID)
	}
	listed, err := f.server.store.(store.MessageChannelStore).ListMessageChannels(ctx, f.aliceID, agent.ID)
	if err != nil || len(listed) != 1 {
		t.Fatalf("the assistant's channels: %d, %v", len(listed), err)
	}
	home := Actor{Kind: ActorAgent, Identity: store.SessionTokenIdentity{SessionID: f.conversation.ID, WorkspaceID: "ws_pa"}}
	scope, err := f.server.agentScope(ctx, home)
	if err != nil {
		t.Fatal(err)
	}
	if !scope.can("ws_alice", store.WorkspaceRoleViewer) {
		t.Fatalf("the home does not read its own channel's workspace: %#v", scope.roles)
	}
	if scope.can("ws_bob", store.WorkspaceRoleViewer) {
		t.Fatalf("the home reads a workspace its package leaves out: %#v", scope.roles)
	}
}
