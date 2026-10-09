package sqlitestore

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// registerTwoRuntimes registers a device with a Claude and a Codex agent in
// one workspace.
func registerTwoRuntimes(t *testing.T, db *Store, workspaceID string) {
	t.Helper()
	agent := func(id, provider string) store.AgentProjection {
		return store.AgentProjection{ID: id, WorkspaceID: workspaceID, DeviceID: "dev_" + workspaceID, Provider: provider, Status: "healthy", AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online"}
	}
	if err := db.RegisterDaemon(context.Background(), store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_" + workspaceID, Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: workspaceID, Name: "Workspace", LocalPath: t.TempDir()},
		Agents:    []store.AgentProjection{agent("agent_claude", "claude"), agent("agent_codex", "codex")},
	}); err != nil {
		t.Fatal(err)
	}
}

func ownedNativeIDs(t *testing.T, db *Store, sessionID string) []string {
	t.Helper()
	refs, err := db.AgentSessionNativeSessions(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, ref := range refs {
		ids = append(ids, ref.Provider+":"+ref.NativeSessionID)
	}
	slices.Sort(ids)
	return ids
}

func listedChatIDs(t *testing.T, db *Store, workspaceID string) []string {
	t.Helper()
	chats, err := db.ListChats(context.Background(), workspaceID)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, chat := range chats {
		ids = append(ids, chat.ID)
	}
	return ids
}

func TestEveryNativeSessionASessionRanStaysClaimed(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerTwoRuntimes(t, db, "ws_claim")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_claim", AgentID: "agent_claude", Provider: "claude", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "answer", "native_a"); err != nil {
		t.Fatal(err)
	}
	next, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: "second"})
	if err != nil {
		t.Fatal(err)
	}
	if next.NativeSessionID != "native_a" || next.Input.ImportedContext != "" {
		t.Fatalf("same runtime = %q with context %q; want native_a resumed with nothing missed", next.NativeSessionID, next.Input.ImportedContext)
	}
	// The worker had to start over: the new native session becomes current.
	if updated, err := db.SetAgentSessionNativeSessionID(ctx, session.ID, "native_b"); err != nil || updated.NativeSessionID != "native_b" {
		t.Fatalf("set native = %+v, %v", updated, err)
	}
	if got := ownedNativeIDs(t, db, session.ID); !slices.Equal(got, []string{"claude:native_a", "claude:native_b"}) {
		t.Fatalf("owned = %v", got)
	}
	// The device keeps uploading both records; neither is stored again.
	for range 2 {
		if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_claim", Chats: []store.ChatThread{
			{ID: "native_claude_native_a", Provider: "claude", NativeSessionID: "native_a", Title: "old", UpdatedAt: "2026-10-09T01:00:00Z"},
			{ID: "native_claude_native_b", Provider: "claude", NativeSessionID: "native_b", Title: "new", UpdatedAt: "2026-10-09T02:00:00Z"},
			{ID: "native_claude_other", Provider: "claude", NativeSessionID: "other", Title: "terminal", UpdatedAt: "2026-10-09T03:00:00Z"},
		}}); err != nil {
			t.Fatal(err)
		}
	}
	var stored int
	if err := db.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM chats WHERE native_session_id IN ('native_a', 'native_b')`).Scan(&stored); err != nil || stored != 0 {
		t.Fatalf("claimed rows stored = %d, %v", stored, err)
	}
	if got := listedChatIDs(t, db, "ws_claim"); !slices.Equal(got, []string{"native_claude_other"}) {
		t.Fatalf("listed = %v", got)
	}
	if _, err := db.GetChat(ctx, "native_claude_native_a"); err == nil {
		t.Fatal("a claimed native chat is still readable as a chat")
	}
}

func TestEachRuntimeResumesItsOwnNativeSessionAcrossSwitches(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerTwoRuntimes(t, db, "ws_runtimes")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_runtimes", AgentID: "agent_claude", Provider: "claude", Prompt: "on claude"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "claude answer", "claude_native"); err != nil {
		t.Fatal(err)
	}
	toCodex, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{AgentID: "agent_codex", Provider: "codex", Prompt: "on codex", ImportedContext: "client context is ignored"})
	if err != nil {
		t.Fatal(err)
	}
	if toCodex.NativeSessionID != "" || toCodex.Input.ImportedContext != "User: on claude\n\nAssistant: claude answer" {
		t.Fatalf("to codex = %q, context %q; want a new native session told the conversation", toCodex.NativeSessionID, toCodex.Input.ImportedContext)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "codex answer", "codex_native"); err != nil {
		t.Fatal(err)
	}
	back, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{AgentID: "agent_claude", Provider: "claude", Prompt: "back on claude"})
	if err != nil {
		t.Fatal(err)
	}
	if back.NativeSessionID != "claude_native" || back.Input.ImportedContext != "User: on codex\n\nAssistant: codex answer" {
		t.Fatalf("back = %q, context %q; want claude's own native session told only the turn it missed", back.NativeSessionID, back.Input.ImportedContext)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "claude again", "claude_native"); err != nil {
		t.Fatal(err)
	}
	again, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{AgentID: "agent_codex", Provider: "codex", Prompt: "codex again"})
	if err != nil {
		t.Fatal(err)
	}
	if again.NativeSessionID != "codex_native" || again.Input.ImportedContext != "User: back on claude\n\nAssistant: claude again" {
		t.Fatalf("codex again = %q, context %q", again.NativeSessionID, again.Input.ImportedContext)
	}
	if got := ownedNativeIDs(t, db, session.ID); !slices.Equal(got, []string{"claude:claude_native", "codex:codex_native"}) {
		t.Fatalf("owned = %v; switching runtimes retires nothing", got)
	}
}

func TestEverySessionTypeClaimsItsNativeSession(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerTwoRuntimes(t, db, "ws_types")
	verifier, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_types", AgentID: "agent_claude", Provider: "claude", Prompt: "check", Source: "verification"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, verifier.ID, "ok", "native_verifier"); err != nil {
		t.Fatal(err)
	}
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_types", Chats: []store.ChatThread{
		{ID: "native_claude_native_verifier", Provider: "claude", NativeSessionID: "native_verifier", Title: "check"},
	}}); err != nil {
		t.Fatal(err)
	}
	if got := listedChatIDs(t, db, "ws_types"); len(got) != 0 {
		t.Fatalf("a verifier's native session is listed as a chat: %v", got)
	}
}

func TestNativeChatsOrderByActivityAndLabelsNeverRewriteThem(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerTwoRuntimes(t, db, "ws_order")
	chat := func(id, at, label string) store.ChatThread {
		return store.ChatThread{ID: id, Provider: "claude", NativeSessionID: strings.TrimPrefix(id, "native_claude_"), Title: id, UpdatedAt: at, UpdatedLabel: label}
	}
	sync := func(chats ...store.ChatThread) {
		t.Helper()
		if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_order", Chats: chats}); err != nil {
			t.Fatal(err)
		}
	}
	sync(chat("native_claude_a", "2026-10-09T01:00:00.000Z", "3h"),
		chat("native_claude_c", "2026-10-09T02:00:00.000Z", "2h"),
		chat("native_claude_b", "2026-10-09T02:00:00.000Z", "2h"))
	if got := listedChatIDs(t, db, "ws_order"); !slices.Equal(got, []string{"native_claude_b", "native_claude_c", "native_claude_a"}) {
		t.Fatalf("order = %v; want latest activity first, ties by id", got)
	}
	var before string
	if err := db.conn().QueryRowContext(ctx, `SELECT updated_at FROM chats WHERE id = 'native_claude_a'`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	// Time passed: only the label changed.
	sync(chat("native_claude_a", "2026-10-09T01:00:00.000Z", "4h"))
	var after, payload string
	if err := db.conn().QueryRowContext(ctx, `SELECT updated_at, payload_json FROM chats WHERE id = 'native_claude_a'`).Scan(&after, &payload); err != nil {
		t.Fatal(err)
	}
	if after != before || strings.Contains(payload, `"4h"`) {
		t.Fatalf("a label-only sync rewrote the row: %s -> %s, %s", before, after, payload)
	}
	sync(chat("native_claude_a", "2026-10-09T05:00:00.000Z", ""))
	if got := listedChatIDs(t, db, "ws_order"); !slices.Equal(got, []string{"native_claude_a", "native_claude_b", "native_claude_c"}) {
		t.Fatalf("order = %v; new activity moves a chat up", got)
	}
}

func TestSessionsOrderByConversationActivity(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerTwoRuntimes(t, db, "ws_activity")
	first, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_activity", AgentID: "agent_claude", Provider: "claude", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_activity", AgentID: "agent_claude", Provider: "claude", Prompt: "second"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, second.ID, "done", "native_second"); err != nil {
		t.Fatal(err)
	}
	completedSecond, err := db.GetAgentSessionSummary(ctx, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Bookkeeping writes (a native id, a block, a failure) are not activity.
	if _, err := db.SetAgentSessionNativeSessionID(ctx, first.ID, "native_first"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.FailAgentSession(ctx, first.ID, "worker restarted"); err != nil {
		t.Fatal(err)
	}
	sessions, err := db.ListAgentSessionSummaries(ctx, "ws_activity")
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 || sessions[0].ID != second.ID || sessions[0].ActivityAt != completedSecond.ActivityAt || sessions[0].ActivityAt <= sessions[1].ActivityAt {
		t.Fatalf("order = %s %s; want the answered session first", sessions[0].ID, sessions[1].ID)
	}
}

func TestForkGivesTheChildItsOwnNativeSession(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerTwoRuntimes(t, db, "ws_fork")
	source, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_fork", AgentID: "agent_claude", Provider: "claude", Prompt: "plan it"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, source.ID, "the plan", "native_source"); err != nil {
		t.Fatal(err)
	}
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_fork", AgentID: "agent_claude", Provider: "claude", Prompt: "try another way", ForkSessionID: source.ID})
	if err != nil {
		t.Fatal(err)
	}
	if child.NativeSessionID == "" || child.NativeSessionID == "native_source" || child.ForkNativeSessionID != "native_source" {
		t.Fatalf("child = %q forked from %q; want its own native session copied from the source", child.NativeSessionID, child.ForkNativeSessionID)
	}
	if got := ownedNativeIDs(t, db, child.ID); !slices.Equal(got, []string{"claude:" + child.NativeSessionID}) {
		t.Fatalf("child owns %v from the start", got)
	}
	if got := ownedNativeIDs(t, db, source.ID); !slices.Equal(got, []string{"claude:native_source"}) {
		t.Fatalf("source owns %v", got)
	}
	// A fork whose first turn failed forks again on its next input.
	if _, err := db.FailAgentSession(ctx, child.ID, "worker restarted"); err != nil {
		t.Fatal(err)
	}
	retried, err := db.SendAgentSessionInput(ctx, child.ID, store.SendAgentSessionInput{Prompt: "try again"})
	if err != nil {
		t.Fatal(err)
	}
	if retried.NativeSessionID != child.NativeSessionID || retried.ForkNativeSessionID != "native_source" {
		t.Fatalf("retried fork = %q / %q", retried.NativeSessionID, retried.ForkNativeSessionID)
	}
	answered, err := db.CompleteAgentSession(ctx, child.ID, "another way", child.NativeSessionID)
	if err != nil {
		t.Fatal(err)
	}
	if answered.ForkNativeSessionID != "" || answered.NativeSessionID != child.NativeSessionID {
		t.Fatalf("answered fork = %+v; it resumes its own native session from now on", answered)
	}
	// Naming a native session another session owns is a fork as well.
	named, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_fork", AgentID: "agent_claude", Provider: "claude", Prompt: "same history", NativeSessionID: "native_source"})
	if err != nil {
		t.Fatal(err)
	}
	if named.NativeSessionID == "native_source" || named.ForkNativeSessionID != "native_source" {
		t.Fatalf("named = %q / %q; two sessions never share a native transcript", named.NativeSessionID, named.ForkNativeSessionID)
	}
	// Codex's SDK cannot fork: the child starts from the source's conversation.
	codexSource, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_fork", AgentID: "agent_codex", Provider: "codex", Prompt: "codex plan"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, codexSource.ID, "codex answer", "native_codex"); err != nil {
		t.Fatal(err)
	}
	codexChild, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_fork", AgentID: "agent_codex", Provider: "codex", Prompt: "fork it", ForkSessionID: codexSource.ID})
	if err != nil {
		t.Fatal(err)
	}
	if codexChild.NativeSessionID != "" || codexChild.Input.ImportedContext != "User: codex plan\n\nAssistant: codex answer" {
		t.Fatalf("codex fork = %q, context %q", codexChild.NativeSessionID, codexChild.Input.ImportedContext)
	}
}

func TestContinuingANativeChatAdoptsIt(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerTwoRuntimes(t, db, "ws_adopt")
	terminal := store.ChatThread{ID: "native_claude_term", Provider: "claude", NativeSessionID: "term", Title: "Terminal work", UpdatedAt: "2026-10-09T01:00:00Z",
		Transcript: []store.TranscriptMessage{
			{ID: "u1:0", Kind: "user", Text: "hi", At: "2026-10-09T00:59:00Z"},
			{ID: "a1:0", Kind: "assistant", Text: "hello", At: "2026-10-09T01:00:00Z"},
		}}
	other := store.ChatThread{ID: "native_claude_other", Provider: "claude", NativeSessionID: "other", Title: "Other", UpdatedAt: "2026-10-09T00:00:00Z",
		Transcript: []store.TranscriptMessage{{ID: "u2:0", Kind: "user", Text: "x"}, {ID: "a2:0", Kind: "assistant", Text: "y"}}}
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_adopt", Chats: []store.ChatThread{terminal, other}}); err != nil {
		t.Fatal(err)
	}
	zero := int64(0)
	if _, err := db.SaveChatLayout(ctx, store.SaveChatLayoutInput{WorkspaceID: "ws_adopt", ExpectedRevision: &zero, Layout: store.ChatLayout{
		Groups:    []store.ChatLayoutGroup{{ID: "grp", Name: "Work"}},
		Positions: []store.ChatPlacement{{ChatID: "native_claude_other"}, {ChatID: "native_claude_term", GroupID: "grp"}},
	}}); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_adopt", AgentID: "agent_claude", Provider: "claude", Prompt: "continue", ChatID: terminal.ID})
	if err != nil {
		t.Fatal(err)
	}
	if session.NativeSessionID != "term" || session.Title != "Terminal work" || session.Input.ImportedContext != "" {
		t.Fatalf("adopted = %q %q %q; want the terminal session resumed as this conversation", session.NativeSessionID, session.Title, session.Input.ImportedContext)
	}
	if got := listedChatIDs(t, db, "ws_adopt"); !slices.Equal(got, []string{"native_claude_other"}) {
		t.Fatalf("listed = %v; the adopted chat leaves the list when it is claimed", got)
	}
	if job, err := db.CreateChatTitleJob(ctx, session.ID, store.CreateAgentSessionInput{WorkspaceID: "ws_adopt", AgentID: "agent_claude", Provider: "claude", Prompt: "name it"}, true); err != nil || job.ID != "" {
		t.Fatalf("automatic naming job = %q, %v; an adopted chat keeps its name", job.ID, err)
	}
	detail, err := db.GetAgentSession(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	var transcript []string
	for _, event := range detail.Events {
		if event.Message != nil {
			transcript = append(transcript, event.Message.Kind+":"+event.Message.Text)
		}
	}
	if !slices.Equal(transcript, []string{"user:hi", "assistant:hello", "user:continue"}) {
		t.Fatalf("transcript = %v; want one conversation", transcript)
	}
	layout, err := db.GetChatLayout(ctx, "ws_adopt")
	if err != nil {
		t.Fatal(err)
	}
	if layout.Positions[1].ChatID != session.ID || layout.Positions[1].GroupID != "grp" {
		t.Fatalf("layout = %+v; the session takes the chat's place", layout.Positions)
	}
	// A chat continued on the other runtime: Codex is told the history, and
	// the Claude session stays this conversation's for later.
	codex, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_adopt", AgentID: "agent_codex", Provider: "codex", Prompt: "on codex", ChatID: other.ID})
	if err != nil {
		t.Fatal(err)
	}
	if codex.NativeSessionID != "" || codex.Input.ImportedContext != "User: x\n\nAssistant: y" {
		t.Fatalf("codex adoption = %+v", codex)
	}
	if got := ownedNativeIDs(t, db, codex.ID); !slices.Equal(got, []string{"claude:other"}) {
		t.Fatalf("owned = %v", got)
	}
	if _, err := db.CompleteAgentSession(ctx, codex.ID, "codex answer", "codex_native"); err != nil {
		t.Fatal(err)
	}
	back, err := db.SendAgentSessionInput(ctx, codex.ID, store.SendAgentSessionInput{AgentID: "agent_claude", Provider: "claude", Prompt: "back"})
	if err != nil {
		t.Fatal(err)
	}
	if back.NativeSessionID != "other" || back.Input.ImportedContext != "User: on codex\n\nAssistant: codex answer" {
		t.Fatalf("back = %q, %q", back.NativeSessionID, back.Input.ImportedContext)
	}
	// A chat another session already continues cannot be adopted again.
	if _, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_adopt", AgentID: "agent_claude", Provider: "claude", Prompt: "again", ChatID: terminal.ID}); err == nil {
		t.Fatal("an adopted chat was adopted twice")
	}
}

func TestMigrationLinksStoredTranscriptsToTheirSessions(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerTwoRuntimes(t, db, "ws_migrate")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_migrate", AgentID: "agent_claude", Provider: "claude", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "answer", "native_current"); err != nil {
		t.Fatal(err)
	}
	switched, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_migrate", AgentID: "agent_codex", Provider: "codex", Prompt: "switched"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, switched.ID, "answer", "native_codex"); err != nil {
		t.Fatal(err)
	}
	// The state before this change: no ownership table, a switch recorded
	// in the payload, and native records of reset sessions stored as chats.
	if _, err := db.conn().ExecContext(ctx, `DROP TABLE agent_session_native_ids`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.conn().ExecContext(ctx, `UPDATE agent_sessions SET payload_json = json_set(payload_json, '$.priorNativeSessions', json('[{"provider":"claude","nativeSessionId":"native_prior"}]')) WHERE id = ?`, switched.ID); err != nil {
		t.Fatal(err)
	}
	orphan := store.ChatThread{ID: "native_claude_orphan", WorkspaceID: "ws_migrate", Provider: "claude", NativeSessionID: "orphan", Title: "orphan",
		Transcript: []store.TranscriptMessage{{ID: "terminal:0", Kind: "user", Text: "no marker"}, {ID: session.Input.ID + ":0", Kind: "user", Text: "first"}}}
	stranger := store.ChatThread{ID: "native_claude_stranger", WorkspaceID: "ws_migrate", Provider: "claude", NativeSessionID: "stranger", Title: "stranger",
		Transcript: []store.TranscriptMessage{{ID: "01a11fce-768d-7085-afc7-9dcc13e56fbd:0", Kind: "user", Text: "terminal"}}}
	for _, chat := range []store.ChatThread{orphan, stranger, {ID: "native_claude_native_prior", WorkspaceID: "ws_migrate", Provider: "claude", NativeSessionID: "native_prior"}} {
		if err := db.saveChat(ctx, chat, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.conn().ExecContext(ctx, `INSERT INTO agent_session_usage_backfills (session_id, backfilled_at) VALUES (?, 'then')`, session.ID); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := db.migrateNativeSessions(ctx); err != nil {
			t.Fatal(err)
		}
		if got := ownedNativeIDs(t, db, session.ID); !slices.Equal(got, []string{"claude:native_current", "claude:orphan"}) {
			t.Fatalf("session owns %v", got)
		}
		if got := ownedNativeIDs(t, db, switched.ID); !slices.Equal(got, []string{"claude:native_prior", "codex:native_codex"}) {
			t.Fatalf("switched session owns %v", got)
		}
		if got := listedChatIDs(t, db, "ws_migrate"); !slices.Equal(got, []string{"native_claude_stranger"}) {
			t.Fatalf("listed = %v", got)
		}
	}
	// Running the backfill again on migrated data changes nothing.
	if err := db.withTx(ctx, func(tx *Store) error { return tx.backfillNativeSessions(ctx) }); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := db.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_session_native_ids`).Scan(&rows); err != nil || rows != 4 {
		t.Fatalf("rows = %d, %v", rows, err)
	}
	// The linked session's usage is read again, now from both logs.
	if done, err := db.SessionUsageBackfilled(ctx, session.ID); err != nil || done {
		t.Fatalf("usage still marked read: %v %v", done, err)
	}
	current, err := db.GetAgentSessionSummary(ctx, session.ID)
	if err != nil || current.NativeSessionID != "native_current" {
		t.Fatalf("current = %+v, %v", current, err)
	}
	var raw string
	if err := db.conn().QueryRowContext(ctx, `SELECT payload_json FROM agent_sessions WHERE id = ?`, switched.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["nativeSessionId"] != "native_codex" {
		t.Fatalf("payload = %v", payload)
	}
}

func TestConversationContextRendersAnsweredTurns(t *testing.T) {
	events := []store.AgentSessionEvent{
		{Label: "Native transcript", Message: &store.TranscriptMessage{Kind: "user", Text: "history"}},
		{Label: "Native transcript", Message: &store.TranscriptMessage{Kind: "assistant", Text: "old answer"}},
		{Label: store.SessionInputEventLabel, Message: &store.TranscriptMessage{ID: "in1", Kind: "user", Text: "one"}},
		{Label: "Response stream", Detail: "partial"},
		{Label: "Response stream", Detail: "first answer"},
		{Label: store.SessionInputEventLabel, Message: &store.TranscriptMessage{ID: "in2", Kind: "user", Text: "failed"}},
		{Label: store.SessionInputEventLabel, Message: &store.TranscriptMessage{ID: "in3", Kind: "user", Text: "three"}},
		{Label: "Response stream", Message: &store.TranscriptMessage{Kind: "assistant", Text: "third answer"}},
		{Label: store.SessionInputEventLabel, Message: &store.TranscriptMessage{ID: "in4", Kind: "user", Text: "now"}},
	}
	if got := conversationContext(events, "", "in4", true); got != "User: history\n\nAssistant: old answer\n\nUser: one\n\nAssistant: first answer\n\nUser: three\n\nAssistant: third answer" {
		t.Fatalf("whole = %q", got)
	}
	if got := conversationContext(events, "in1", "in4", false); got != "User: three\n\nAssistant: third answer" {
		t.Fatalf("missed = %q; an unanswered turn tells nothing", got)
	}
	if got := conversationContext(events, "unknown", "in4", false); got != "" {
		t.Fatalf("unknown last input = %q", got)
	}
}

// The migration runs on every start: what a server without the ownership
// table wrote after an earlier run is repaired, and consistent data is left
// untouched.
func TestMigrationRepairsWhatAnOlderServerWroteMeanwhile(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerTwoRuntimes(t, db, "ws_rerun")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_rerun", AgentID: "agent_claude", Provider: "claude", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "answer", "native_one"); err != nil {
		t.Fatal(err)
	}
	// An older server: it reset the native session (recording the old one in
	// priorNativeSessions), rewrote the payload without activityAt and left
	// the column as it was, and synced the claimed chat back with its own
	// column list.
	if _, err := db.conn().ExecContext(ctx, `UPDATE agent_sessions SET payload_json = json_remove(json_set(payload_json,
		'$.nativeSessionId', 'native_two',
		'$.input.id', 'input_two', '$.input.at', '2027-01-01T00:00:00Z',
		'$.priorNativeSessions', json('[{"provider":"claude","nativeSessionId":"native_one"},{"provider":"claude","nativeSessionId":"native_zero"}]')),
		'$.activityAt') WHERE id = ?`, session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.conn().ExecContext(ctx, `INSERT INTO chats (id, title, payload_json, updated_at) VALUES (?, 'old', ?, 'now')`,
		"native_claude_native_one", `{"id":"native_claude_native_one","workspaceId":"ws_rerun","provider":"claude","nativeSessionId":"native_one","title":"old","updatedAt":"2026-10-09T00:00:00Z"}`); err != nil {
		t.Fatal(err)
	}
	if err := db.migrateNativeSessions(ctx); err != nil {
		t.Fatal(err)
	}
	if got := ownedNativeIDs(t, db, session.ID); !slices.Equal(got, []string{"claude:native_one", "claude:native_two", "claude:native_zero"}) {
		t.Fatalf("owned = %v", got)
	}
	row, found, err := db.currentNativeSession(ctx, session.ID, nativeRuntime{provider: "claude", deviceID: "dev_ws_rerun"})
	if err != nil || !found || row.nativeID != "native_two" || row.lastInputID != "input_two" {
		t.Fatalf("current = %+v %v %v", row, found, err)
	}
	if got := listedChatIDs(t, db, "ws_rerun"); len(got) != 0 {
		t.Fatalf("listed = %v", got)
	}
	repaired, err := db.GetAgentSessionSummary(ctx, session.ID)
	if err != nil || repaired.ActivityAt != "2027-01-01T00:00:00.000000000Z" {
		t.Fatalf("activity = %q, %v", repaired.ActivityAt, err)
	}
	// Run again on consistent data: nothing is written.
	var before, after int64
	if err := db.conn().QueryRowContext(ctx, `SELECT total_changes()`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := db.migrateNativeSessions(ctx); err != nil {
		t.Fatal(err)
	}
	if err := db.conn().QueryRowContext(ctx, `SELECT total_changes()`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("a second run wrote %d rows", after-before)
	}
}

func TestNativeFilesWithoutTurnsAreNotChats(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerTwoRuntimes(t, db, "ws_stub")
	real := store.ChatThread{ID: "native_claude_real", Provider: "claude", NativeSessionID: "real", UpdatedAt: "2026-10-09T01:00:00Z",
		RecentMessages: []store.ChatRecapMessage{{Role: "user", Text: "hi"}}}
	// A summary carries no transcript yet: kept until its full upload.
	stub := store.ChatThread{ID: "native_claude_stub", Provider: "claude", NativeSessionID: "stub", UpdatedAt: "2026-10-09T02:00:00Z"}
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_stub", Chats: []store.ChatThread{real, stub}}); err != nil {
		t.Fatal(err)
	}
	if got := listedChatIDs(t, db, "ws_stub"); len(got) != 2 {
		t.Fatalf("listed = %v; summaries are kept until their transcript arrives", got)
	}
	// Restart cleanup: a stored chat with neither recap nor turns goes.
	if err := db.migrateNativeSessions(ctx); err != nil {
		t.Fatal(err)
	}
	if got := listedChatIDs(t, db, "ws_stub"); !slices.Equal(got, []string{"native_claude_real"}) {
		t.Fatalf("listed = %v; the stub goes at startup", got)
	}
	// Its full upload, transcript and all, says the same.
	stub.Transcript = []store.TranscriptMessage{}
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_stub", Chats: []store.ChatThread{stub}}); err != nil {
		t.Fatal(err)
	}
	if got := listedChatIDs(t, db, "ws_stub"); !slices.Equal(got, []string{"native_claude_real"}) {
		t.Fatalf("listed = %v; a full upload without turns is not a chat", got)
	}
}
