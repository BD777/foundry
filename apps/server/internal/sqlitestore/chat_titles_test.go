package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestChatTitleGenerationIsolationAndManualPrecedence(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_titles", "agent_titles")
	input := store.CreateAgentSessionInput{WorkspaceID: "ws_titles", AgentID: "agent_titles", Provider: "codex", Prompt: "original question"}
	original, err := db.CreateAgentSession(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.CompleteAgentSession(ctx, original.ID, "original answer", "original-native"); err != nil {
		t.Fatal(err)
	}
	input.Prompt = "isolated title prompt"
	input.NativeSessionID = "must not resume"
	input.ThreadID = original.ID
	input.ImportedContext = "must not inherit"
	job, err := db.CreateChatTitleJob(ctx, original.ID, input, true)
	if err != nil {
		t.Fatal(err)
	}
	if job.Source != "naming" || job.NativeSessionID != "" || job.ThreadID != "" || job.ImportedContext != "" || job.AgentID != original.AgentID {
		t.Fatalf("naming not isolated: %+v", job)
	}
	duplicate, err := db.CreateChatTitleJob(ctx, original.ID, input, true)
	if err != nil || duplicate.ID != "" {
		t.Fatalf("automatic naming repeated: %+v %v", duplicate, err)
	}
	same, err := db.CreateChatTitleJob(ctx, original.ID, input, false)
	if err != nil || same.ID != job.ID {
		t.Fatal("in-flight jobs should coalesce")
	}
	_, err = db.RenameChat(ctx, original.ID, store.RenameChatInput{WorkspaceID: input.WorkspaceID, Title: "manual title"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.CompleteAgentSession(ctx, job.ID, `{"title":"stale generated title"}`, "title-native"); err != nil {
		t.Fatal(err)
	}
	titles, err := db.ListChatTitles(ctx, input.WorkspaceID)
	if err != nil || len(titles) != 1 || titles[0].Title != "manual title" {
		t.Fatalf("manual title overwritten: %+v %v", titles, err)
	}
	latest, err := db.GetAgentSession(ctx, original.ID)
	if err != nil || latest.Response != "original answer" || latest.NativeSessionID != "original-native" {
		t.Fatalf("original session polluted: %+v %v", latest, err)
	}
	next, err := db.CreateChatTitleJob(ctx, original.ID, input, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.CompleteAgentSession(ctx, next.ID, `{"title":"new recap"}`, "title-native-2"); err != nil {
		t.Fatal(err)
	}
	titles, _ = db.ListChatTitles(ctx, input.WorkspaceID)
	if titles[0].Title != "new recap" || titles[0].GenerationSessionID != "" {
		t.Fatalf("title not applied: %+v", titles)
	}
	if err = db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: input.WorkspaceID, Chats: []store.ChatThread{{ID: "native_title", WorkspaceID: input.WorkspaceID, Provider: "codex", NativeSessionID: "title-native-2", Title: "utility"}}}); err != nil {
		t.Fatal(err)
	}
	chats, _ := db.ListChats(ctx, input.WorkspaceID)
	for _, chat := range chats {
		if chat.ID == "native_title" {
			t.Fatal("utility session leaked into Chats")
		}
	}
}

func TestNativeChatRenameSurvivesSyncAndScopeChecks(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_titles", "agent_titles")
	chat := store.ChatThread{ID: "native_chat", WorkspaceID: "ws_titles", Provider: "claude", NativeSessionID: "raw-native", Title: "native title"}
	sync := store.SyncChatsInput{WorkspaceID: "ws_titles", Chats: []store.ChatThread{chat}}
	if err := db.SyncChats(ctx, sync); err != nil {
		t.Fatal(err)
	}
	if _, err := db.RenameChat(ctx, chat.ID, store.RenameChatInput{WorkspaceID: "other", Title: "wrong scope"}); err == nil {
		t.Fatal("cross-workspace rename allowed")
	}
	if _, err := db.RenameChat(ctx, chat.ID, store.RenameChatInput{WorkspaceID: "ws_titles", Title: "custom title"}); err != nil {
		t.Fatal(err)
	}
	if err := db.SyncChats(ctx, sync); err != nil {
		t.Fatal(err)
	}
	titles, _ := db.ListChatTitles(ctx, "ws_titles")
	if len(titles) != 1 || titles[0].Title != "custom title" {
		t.Fatalf("sync overwrote custom title: %+v", titles)
	}
}
