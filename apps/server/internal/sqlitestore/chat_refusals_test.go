package sqlitestore

import (
	"context"
	"slices"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A device need not send again what is never kept: a chat a Foundry session
// owns, or one the person deleted. Every other chat is kept, an empty one
// included (it may get turns later).
func TestChatSyncNamesTheChatsNeverKept(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_refuse", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_refuse", Name: "Workspace", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{{ID: "agent_refuse", WorkspaceID: "ws_refuse", DeviceID: "dev_refuse", Provider: "claude",
			Status: "healthy", AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online"}},
	}); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_refuse", AgentID: "agent_refuse", Provider: "claude", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "answer", "native_owned"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.conn().ExecContext(ctx, `INSERT INTO chat_deletions(workspace_id, deletion_key) VALUES ('ws_refuse', 'id:native_claude_gone')`); err != nil {
		t.Fatal(err)
	}
	turns := []store.ChatRecapMessage{{Role: "user", Text: "hi"}}
	changes, err := db.SyncChatsChanges(ctx, store.SyncChatsInput{WorkspaceID: "ws_refuse", Chats: []store.ChatThread{
		{ID: "native_claude_native_owned", Provider: "claude", NativeSessionID: "native_owned", Title: "owned", RecentMessages: turns},
		{ID: "native_claude_gone", Provider: "claude", NativeSessionID: "gone", Title: "deleted", RecentMessages: turns},
		{ID: "native_claude_kept", Provider: "claude", NativeSessionID: "kept", Title: "terminal", RecentMessages: turns},
		{ID: "native_claude_empty", Provider: "claude", NativeSessionID: "empty", Title: "no turns yet"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(changes.RefusedChats, []string{"native_claude_native_owned", "native_claude_gone"}) {
		t.Fatalf("refused = %v", changes.RefusedChats)
	}
	if !slices.Contains(changes.Workspaces, "ws_refuse") {
		t.Fatalf("the kept chat changed no workspace: %+v", changes)
	}
}
