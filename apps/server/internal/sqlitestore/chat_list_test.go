package sqlitestore

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// legacyListChatsSQL is ListChats as it was before it read the chat columns
// and the workspace index: the reference its results must equal.
const legacyListChatsSQL = `SELECT json_remove(payload_json, '$.handoffContext', '$.recentMessages', '$.transcript') FROM chats
	WHERE (? = '' OR workspace_id IN (?, ''))
	AND NOT EXISTS (SELECT 1 FROM chat_deletions d
		WHERE d.workspace_id = COALESCE(json_extract(chats.payload_json, '$.workspaceId'), '') AND d.deletion_key IN (
			'id:' || chats.id,
			'native:' || json_extract(chats.payload_json, '$.provider') || ':' || json_extract(chats.payload_json, '$.nativeSessionId')))
	AND NOT ` + nativeClaimedSQL + `
	ORDER BY activity_at DESC, id ASC`

func TestListChatsMatchesTheLegacyQuery(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	turns := []store.ChatRecapMessage{{Role: "user", Text: "hi"}}
	chat := func(id, workspaceID, provider, nativeID, updatedAt string) store.ChatThread {
		return store.ChatThread{ID: id, WorkspaceID: workspaceID, Provider: provider, NativeSessionID: nativeID,
			Title: "title " + id, Preview: "preview", UpdatedAt: updatedAt, RecentMessages: turns,
			HandoffContext: "User: hi", Transcript: []store.TranscriptMessage{{ID: "m", Kind: "user", Text: "hi"}}}
	}
	sync := func(workspaceID string, chats ...store.ChatThread) {
		t.Helper()
		if _, err := db.SyncChatsChanges(ctx, store.SyncChatsInput{WorkspaceID: workspaceID, Chats: chats}); err != nil {
			t.Fatal(err)
		}
	}
	sync("ws_a",
		chat("plain", "ws_a", "", "", "2026-10-01T00:00:00Z"),
		chat("codex_native", "ws_a", "codex", "nat_codex", "2026-10-02T00:00:00Z"),
		chat("claude_native", "ws_a", "claude", "nat_claude", "2026-10-02T00:00:00Z"),
		chat("deleted_by_id", "ws_a", "codex", "nat_del_id", "2026-10-03T00:00:00Z"),
		chat("deleted_by_native", "ws_a", "codex", "nat_del_native", "2026-10-03T00:00:00Z"),
		chat("deleted_elsewhere", "ws_a", "codex", "nat_other_ws", "2026-10-04T00:00:00Z"),
		chat("native_without_provider", "ws_a", "", "nat_lonely", "2026-10-05T00:00:00Z"),
		chat("claimed", "ws_a", "codex", "nat_claimed", "2026-10-06T00:00:00Z"),
		chat("no_time", "ws_a", "codex", "nat_no_time", ""),
	)
	sync("ws_b", chat("other_workspace", "ws_b", "codex", "nat_b", "2026-10-07T00:00:00Z"))
	sync("", chat("unassigned", "", "codex", "nat_unassigned", "2026-10-08T00:00:00Z"))
	for _, statement := range []string{
		`INSERT INTO chat_deletions (workspace_id, deletion_key) VALUES ('ws_a', 'id:deleted_by_id')`,
		`INSERT INTO chat_deletions (workspace_id, deletion_key) VALUES ('ws_a', 'native:codex:nat_del_native')`,
		// A marker of another workspace does not hide this one's chat.
		`INSERT INTO chat_deletions (workspace_id, deletion_key) VALUES ('ws_b', 'native:codex:nat_other_ws')`,
		// No native key exists for a chat without a provider.
		`INSERT INTO chat_deletions (workspace_id, deletion_key) VALUES ('ws_a', 'native::nat_lonely')`,
		`INSERT INTO agent_session_native_ids (provider, native_id, session_id, attached_at) VALUES ('codex', 'nat_claimed', 'sess_owner', '2026-10-06T00:00:00Z')`,
	} {
		if _, err := db.conn().ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}

	for _, workspaceID := range []string{"", "ws_a", "ws_b", "ws_missing"} {
		want, err := listJSON[store.ChatThread](ctx, db.conn(), legacyListChatsSQL, workspaceID, workspaceID)
		if err != nil {
			t.Fatal(err)
		}
		got, err := db.ListChats(ctx, workspaceID)
		if err != nil {
			t.Fatal(err)
		}
		wantJSON, _ := json.Marshal(want)
		gotJSON, _ := json.Marshal(got)
		if string(gotJSON) != string(wantJSON) {
			t.Fatalf("ListChats(%q)\n got %s\nwant %s", workspaceID, gotJSON, wantJSON)
		}
		if workspaceID == "ws_a" && len(got) != 7 {
			t.Fatalf("ws_a lists %d chats, want its 6 visible and the unassigned one: %s", len(got), gotJSON)
		}
	}

	rows, err := db.conn().QueryContext(ctx, `EXPLAIN QUERY PLAN SELECT id FROM chats WHERE workspace_id IN (?, '') AND `+visibleChatSQL+` AND NOT `+nativeClaimedSQL+` ORDER BY activity_at DESC, id ASC`, "ws_a")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	plan := []string{}
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	if !strings.Contains(strings.Join(plan, "\n"), "idx_chats_workspace_activity") {
		t.Fatalf("a workspace's chat list scans the table: %v", plan)
	}
}

func chatUpdatedAt(t *testing.T, db *Store, id string) string {
	t.Helper()
	var updatedAt string
	if err := db.conn().QueryRowContext(context.Background(), `SELECT updated_at FROM chats WHERE id = ?`, id).Scan(&updatedAt); err != nil {
		t.Fatalf("chat %s: %v", id, err)
	}
	return updatedAt
}

// A reconnect reports every chat again; only the changed ones are written,
// and the stored chats end as they did when every one was compared inside
// the transaction.
func TestRegistrationWritesOnlyChangedChats(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	turns := []store.ChatRecapMessage{{Role: "user", Text: "hi"}}
	structured := store.ChatThread{ID: "structured", Provider: "codex", NativeSessionID: "nat_structured", Title: "Structured",
		HandoffContext: "User: hi", AnswerRevision: "r1", RecentMessages: turns,
		Transcript: []store.TranscriptMessage{{ID: "m1", Kind: "user", Text: "hi"}}}
	changing := store.ChatThread{ID: "changing", Provider: "codex", NativeSessionID: "nat_changing", Title: "Before", RecentMessages: turns}
	register := func(chats ...store.ChatThread) {
		t.Helper()
		if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
			Device:    store.DeviceProjection{ID: "dev_sync", Label: "Device", Status: "connected", LastSeenLabel: "online"},
			Workspace: store.WorkspaceProjection{ID: "ws_sync", Name: "Workspace", LocalPath: t.TempDir()},
			Chats:     chats,
		}); err != nil {
			t.Fatal(err)
		}
	}
	register(structured, changing)
	structuredAt, changingAt := chatUpdatedAt(t, db, "structured"), chatUpdatedAt(t, db, "changing")

	// A legacy worker resends the structured chat without its transcript;
	// its history did not change, so the stored detail stays and nothing is
	// written. The other chat changed.
	legacy := structured
	legacy.Transcript = nil
	changing.Title = "After"
	register(legacy, changing)
	if got := chatUpdatedAt(t, db, "structured"); got != structuredAt {
		t.Fatalf("unchanged chat rewritten: updated_at %s -> %s", structuredAt, got)
	}
	if got := chatUpdatedAt(t, db, "changing"); got == changingAt {
		t.Fatal("changed chat not written")
	}
	detail, err := db.GetChat(ctx, "structured")
	if err != nil || len(detail.Transcript) != 1 || detail.WorkspaceID != "ws_sync" {
		t.Fatalf("structured chat = %+v, %v", detail, err)
	}
	changed, err := db.GetChat(ctx, "changing")
	if err != nil || changed.Title != "After" {
		t.Fatalf("changed chat = %+v, %v", changed, err)
	}

	// The history changed: the legacy snapshot replaces the detail.
	legacy.AnswerRevision = "r2"
	register(legacy, changing)
	detail, err = db.GetChat(ctx, "structured")
	if err != nil || len(detail.Transcript) != 0 || detail.AnswerRevision != "r2" {
		t.Fatalf("changed history kept stale detail: %+v, %v", detail, err)
	}
}

// A chat compared unchanged before the transaction is compared again when
// something wrote it in between, and still goes through the deletion and
// ownership checks.
func TestComparedChatIsCheckedAgainInTheTransaction(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	turns := []store.ChatRecapMessage{{Role: "user", Text: "hi"}}
	chat := store.ChatThread{ID: "raced", WorkspaceID: "ws_race", Provider: "codex", NativeSessionID: "nat_raced", Title: "Mine", RecentMessages: turns}
	save := func(value store.ChatThread, known chatComparison) {
		t.Helper()
		if err := db.withTx(ctx, func(tx *Store) error {
			_, _, err := tx.saveComparedChat(ctx, value, time.Now(), known)
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	save(chat, chatComparison{})

	known := db.compareChat(ctx, chat)
	if !known.unchanged || known.updatedAt == "" {
		t.Fatalf("comparison = %+v, want unchanged", known)
	}
	// Another sync writes a different title before this one's transaction.
	other := chat
	other.Title = "Theirs"
	save(other, chatComparison{})
	save(chat, known)
	if stored, err := db.GetChat(ctx, chat.ID); err != nil || stored.Title != "Mine" {
		t.Fatalf("stale comparison skipped a write: %+v, %v", stored, err)
	}

	// Deleted meanwhile: nothing is written and its native alias is kept.
	known = db.compareChat(ctx, chat)
	if _, err := db.conn().ExecContext(ctx, `INSERT INTO chat_deletions (workspace_id, deletion_key) VALUES ('ws_race', 'id:raced')`); err != nil {
		t.Fatal(err)
	}
	save(chat, known)
	var aliases int
	if err := db.conn().QueryRowContext(ctx, `SELECT count(*) FROM chat_deletions WHERE workspace_id = 'ws_race' AND deletion_key = 'native:codex:nat_raced'`).Scan(&aliases); err != nil || aliases != 1 {
		t.Fatalf("native alias markers = %d, %v", aliases, err)
	}

	// Claimed by a session meanwhile: the device's copy leaves the list.
	claimed := store.ChatThread{ID: "claimed", WorkspaceID: "ws_race", Provider: "codex", NativeSessionID: "nat_claimed", Title: "Claimed", RecentMessages: turns}
	save(claimed, chatComparison{})
	known = db.compareChat(ctx, claimed)
	if _, err := db.conn().ExecContext(ctx, `INSERT INTO agent_session_native_ids (provider, native_id, session_id, attached_at) VALUES ('codex', 'nat_claimed', 'sess_owner', 'now')`); err != nil {
		t.Fatal(err)
	}
	save(claimed, known)
	var remaining int
	if err := db.conn().QueryRowContext(ctx, `SELECT count(*) FROM chats WHERE id = 'claimed'`).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("claimed chat rows = %d, %v", remaining, err)
	}
}

// The comparison reads on the read pool, so it runs while the writer is
// held instead of holding it.
func TestChatComparisonDoesNotNeedTheWriter(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	chat := store.ChatThread{ID: "big", WorkspaceID: "ws_big", Provider: "codex", NativeSessionID: "nat_big", Title: "Big",
		RecentMessages: []store.ChatRecapMessage{{Role: "user", Text: "hi"}},
		Transcript:     []store.TranscriptMessage{{ID: "m", Kind: "assistant", Text: strings.Repeat("answer ", 1<<17)}}}
	if _, err := db.SyncChatsChanges(ctx, store.SyncChatsInput{WorkspaceID: "ws_big", Chats: []store.ChatThread{chat}}); err != nil {
		t.Fatal(err)
	}
	held, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		done <- db.withTx(ctx, func(*Store) error {
			close(held)
			<-release
			return nil
		})
	}()
	<-held
	compared := make(chan chatComparison, 1)
	go func() { compared <- db.compareChat(ctx, chat) }()
	select {
	case known := <-compared:
		if !known.unchanged {
			t.Fatalf("comparison = %+v, want unchanged", known)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the comparison waited for the writer")
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// A device report says what it changed in what clients read, and a report
// that changed nothing says so: the server announces only real changes.
func TestDaemonReportsSayWhatTheyChanged(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registration := store.DaemonRegistration{
		Device:         store.DeviceProjection{ID: "dev_changes", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace:      store.WorkspaceProjection{ID: "ws_changes", Name: "Workspace", LocalPath: "/tmp/ws_changes"},
		ProviderHealth: []store.ProviderHealth{{Provider: "codex", Status: "healthy", AuthMode: "local_config", SecretStored: "local"}},
		Assets:         []store.AssetProjection{{ID: "asset_1", Name: "README.md", Kind: "file", Status: "ready"}},
	}
	register := func(want store.DaemonChanges, why string) {
		t.Helper()
		got, err := db.RegisterDaemonChanges(ctx, registration)
		if err != nil {
			t.Fatal(err)
		}
		if got.Global != want.Global || strings.Join(got.Workspaces, ",") != strings.Join(want.Workspaces, ",") {
			t.Fatalf("%s: changes = %+v, want %+v", why, got, want)
		}
	}
	register(store.DaemonChanges{Global: true, Workspaces: []string{"ws_changes"}}, "a new workspace")
	register(store.DaemonChanges{}, "the same report again")
	registration.Device.Status, registration.Device.LastSeenLabel = "disconnected", "offline"
	register(store.DaemonChanges{}, "going offline (device_status_changed carries it)")
	registration.ProviderHealth[0].Status = "unavailable"
	register(store.DaemonChanges{Global: true}, "provider health")
	registration.Device.RuntimeSettings = &store.AgentRuntimeSettings{MaxConcurrentTasks: 2}
	register(store.DaemonChanges{Global: true}, "the device's settings (only its owner sees them)")
	registration.Assets[0].Status = "missing"
	register(store.DaemonChanges{Workspaces: []string{"ws_changes"}}, "an asset")
	registration.Chats = []store.ChatThread{{ID: "chat_registered", Provider: "codex", NativeSessionID: "nat_registered", Title: "Chat",
		RecentMessages: []store.ChatRecapMessage{{Role: "user", Text: "hi"}}}}
	register(store.DaemonChanges{Workspaces: []string{"ws_changes"}}, "a chat in the report")
	register(store.DaemonChanges{}, "the same chat again")

	// A device without a workspace: its own row counts, as no device event
	// reaches anyone without a workspace.
	alone := store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_alone", Label: "Alone", Status: "connected", LastSeenLabel: "online"}}
	for _, step := range []struct {
		status string
		want   bool
	}{{"connected", true}, {"connected", false}, {"disconnected", true}} {
		alone.Device.Status = step.status
		got, err := db.RegisterDaemonChanges(ctx, alone)
		if err != nil {
			t.Fatal(err)
		}
		if got.Global != step.want || len(got.Workspaces) != 0 {
			t.Fatalf("device alone %s: %+v, want global %v", step.status, got, step.want)
		}
	}

	sync := func(chat store.ChatThread, want []string, why string) {
		t.Helper()
		got, err := db.SyncChatsChanges(ctx, store.SyncChatsInput{WorkspaceID: "ws_changes", Chats: []store.ChatThread{chat}})
		if err != nil {
			t.Fatal(err)
		}
		if got.Global || strings.Join(got.Workspaces, ",") != strings.Join(want, ",") {
			t.Fatalf("%s: changes = %+v, want workspaces %v", why, got, want)
		}
	}
	synced := store.ChatThread{ID: "chat_synced", Provider: "codex", NativeSessionID: "nat_synced", Title: "Synced",
		RecentMessages: []store.ChatRecapMessage{{Role: "user", Text: "hi"}}}
	sync(synced, []string{"ws_changes"}, "a new chat")
	sync(synced, nil, "an unchanged chat")
	synced.Title = "Renamed on the device"
	sync(synced, []string{"ws_changes"}, "a changed chat")
	empty := synced
	empty.RecentMessages, empty.Transcript = nil, []store.TranscriptMessage{}
	sync(empty, []string{"ws_changes"}, "a chat without turns leaves the list")
	sync(empty, nil, "an empty chat that is already gone")
}
