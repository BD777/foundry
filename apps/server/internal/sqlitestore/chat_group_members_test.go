package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestChatGroupMembersCountAndPageUnarchivedChats(t *testing.T) {
	ctx := context.Background()
	db, first := archiveFixture(t)
	second, e := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: first.WorkspaceID, AgentID: first.AgentID, Provider: "codex", Prompt: "newer", Source: "chat"})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.CompleteAgentSession(ctx, second.ID, "answer", "native_member_second"); e != nil {
		t.Fatal(e)
	}
	archived, _ := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: first.WorkspaceID, AgentID: first.AgentID, Provider: "codex", Prompt: "archived member", Source: "chat"})
	archived, _ = db.CompleteAgentSession(ctx, archived.ID, "answer", "native_member_archived")
	if _, e = db.ArchiveChats(ctx, store.ArchiveChatsInput{WorkspaceID: first.WorkspaceID, ChatIDs: []string{archived.ID}}, false); e != nil {
		t.Fatal(e)
	}
	layout, _ := db.GetChatLayout(ctx, first.WorkspaceID)
	layout.Groups = []store.ChatLayoutGroup{{ID: "folder", Name: "Folder"}}
	layout.Positions = []store.ChatPlacement{
		{ChatID: first.ID, GroupID: "folder"},
		{ChatID: second.ID, GroupID: "folder"},
		{ChatID: archived.ID, GroupID: "folder"},
		{ChatID: "sess_gone_member", GroupID: "folder"},
	}
	saveLayout(t, db, first.WorkspaceID, layout)
	counts, e := db.ChatGroupMemberCounts(ctx, first.WorkspaceID)
	if e != nil || counts["folder"] != 2 {
		t.Fatalf("counts=%+v %v", counts, e)
	}
	page, next, e := db.ListChatGroupMemberSessions(ctx, first.WorkspaceID, "folder", "", 1)
	if e != nil || len(page) != 1 || page[0].ID != second.ID || next == "" {
		t.Fatalf("first page=%+v next=%q %v", page, next, e)
	}
	page, next, e = db.ListChatGroupMemberSessions(ctx, first.WorkspaceID, "folder", next, 1)
	if e != nil || len(page) != 1 || page[0].ID != first.ID || next != "" {
		t.Fatalf("second page=%+v next=%q %v", page, next, e)
	}
}
