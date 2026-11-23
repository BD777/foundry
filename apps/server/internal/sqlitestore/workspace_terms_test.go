package sqlitestore

import (
	"context"
	"reflect"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A workspace's terms are kept per source, replaced with it, found by
// prefix only in the workspaces asked for, totalled per workspace and
// deleted with their source.
func TestWorkspaceTermsAreKeptPerSource(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	save := func(workspaceID, sourceID, at string, terms map[string]int) {
		t.Helper()
		source := store.WorkspaceTermSource{WorkspaceID: workspaceID, SourceID: sourceID, Kind: store.WorkspaceTermChat, Rev: at, Title: sourceID, At: at}
		if err := db.SaveWorkspaceTermSource(ctx, source, terms); err != nil {
			t.Fatal(err)
		}
	}
	save("ws_a", "chat_1", "2026-11-01T00:00:00Z", map[string]int{"sats-tokyo-7": 3, "aws": 1})
	save("ws_a", "chat_2", "2026-11-02T00:00:00Z", map[string]int{"sats-tokyo-1": 1, "aws": 2})
	save("ws_b", "chat_3", "2026-11-03T00:00:00Z", map[string]int{"sats-tokyo-7": 9})
	save("ws_a", "chat_1", "2026-11-04T00:00:00Z", map[string]int{"sats-tokyo-7": 4})

	hits, err := db.FindWorkspaceTerms(ctx, []string{"ws_a"}, "sats-tokyo", 10)
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, hit := range hits {
		got = append(got, hit.Source.SourceID+":"+hit.Term+":"+hit.Source.At)
	}
	if want := []string{"chat_1:sats-tokyo-7:2026-11-04T00:00:00Z", "chat_2:sats-tokyo-1:2026-11-02T00:00:00Z"}; !reflect.DeepEqual(got, want) || hits[0].Count != 4 {
		t.Fatalf("hits = %v (%+v), want %v", got, hits, want)
	}
	totals, err := db.WorkspaceTermTotals(ctx, []string{"ws_a", "ws_b"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	totalOf := map[string]store.WorkspaceTermTotal{}
	for _, total := range totals {
		totalOf[total.WorkspaceID+"/"+total.Term] = total
	}
	if len(totals) != 3 || totalOf["ws_a/sats-tokyo-7"].Count != 4 || totalOf["ws_a/aws"].Count != 2 || totalOf["ws_a/aws"].Sources != 1 || totalOf["ws_b/sats-tokyo-7"].Count != 9 {
		t.Fatalf("totals = %+v", totals)
	}

	if err := db.DeleteWorkspaceTermSources(ctx, "ws_a", []string{"chat_2"}); err != nil {
		t.Fatal(err)
	}
	sources, err := db.WorkspaceTermSources(ctx, "ws_a")
	if err != nil || len(sources) != 1 || sources[0].SourceID != "chat_2" {
		t.Fatalf("sources = %+v, %v", sources, err)
	}
	if hits, err := db.FindWorkspaceTerms(ctx, []string{"ws_a"}, "sats-tokyo-7", 10); err != nil || len(hits) != 0 {
		t.Fatalf("a deleted source's terms: %+v, %v", hits, err)
	}
}

// What a chat's and a session's terms are counted from: the person's and
// the agent's words, not tool calls or reasoning.
func TestChatTermTextsLeaveToolOutputOut(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerTwoRuntimes(t, db, "ws_terms")
	chat := store.ChatThread{ID: "native_claude_t", Provider: "claude", NativeSessionID: "t", Title: "Tokyo", HandoffContext: "from before", UpdatedAt: "2026-11-01T00:00:00Z",
		Transcript: []store.TranscriptMessage{
			{ID: "u1", Kind: "user", Text: "ssh sats-tokyo-7"},
			{ID: "t1", Kind: "tool", Text: "tool output"},
			{ID: "r1", Kind: "reasoning", Text: "thinking"},
			{ID: "c1", Kind: "commentary", Text: "looking"},
			{ID: "a1", Kind: "assistant", Text: "done"},
		}}
	if _, err := db.SyncChatsChanges(ctx, store.SyncChatsInput{WorkspaceID: "ws_terms", Chats: []store.ChatThread{chat}}); err != nil {
		t.Fatal(err)
	}
	texts, err := db.ChatTermTexts(ctx, chat.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"Tokyo", "from before", "ssh sats-tokyo-7", "looking", "done"}; !reflect.DeepEqual(texts, want) {
		t.Fatalf("chat texts = %q, want %q", texts, want)
	}

	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_terms", AgentID: "agent_claude", Provider: "claude", Prompt: "check aws"})
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range []store.AgentSessionEvent{
		{ID: "evt_t1", SessionID: session.ID, At: "2026-11-01T00:00:01Z", Label: "Tool", Level: "info", Message: &store.TranscriptMessage{ID: "t1", Kind: "tool", Text: "tool output"}},
		{ID: "evt_a1", SessionID: session.ID, At: "2026-11-01T00:00:02Z", Label: "Response stream", Level: "info", Message: &store.TranscriptMessage{ID: "a1", Kind: "assistant", Text: "aws is fine"}},
	} {
		if err := db.AppendAgentSessionEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	texts, err = db.ChatTermTexts(ctx, "", session.ID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, text := range texts {
		if text == "tool output" {
			t.Fatalf("session texts hold tool output: %q", texts)
		}
		found = found || text == "aws is fine"
	}
	if !found {
		t.Fatalf("session texts = %q", texts)
	}
}
