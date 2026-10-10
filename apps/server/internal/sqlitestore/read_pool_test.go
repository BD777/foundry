package sqlitestore

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A read never waits for the writer: while a transaction holds the writer,
// reads answer from the read pool with the last committed state, and the
// transaction itself reads its own writes.
func TestReadsAnswerWhileTheWriterIsHeld(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_reader", "agent_reader")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_reader", AgentID: "agent_reader", Provider: "codex", Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}

	held, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		done <- db.withTx(ctx, func(tx *Store) error {
			if _, err := tx.conn().ExecContext(ctx, `INSERT INTO workspace_display_names (workspace_id, name) VALUES (?, ?)`, "ws_reader", "Renamed"); err != nil {
				return err
			}
			workspace, err := tx.GetWorkspace(ctx, "ws_reader")
			if err != nil || workspace.Name != "Renamed" {
				t.Errorf("transaction read %q, %v; want its own write", workspace.Name, err)
			}
			close(held)
			<-release
			return nil
		})
	}()
	<-held

	read := make(chan string, 1)
	go func() {
		workspace, err := db.GetWorkspace(ctx, "ws_reader")
		if err != nil {
			t.Error(err)
		}
		if _, err := db.GetAgentSessionSummary(ctx, session.ID); err != nil {
			t.Error(err)
		}
		if _, err := db.ListAgentSessionSummaries(ctx, "ws_reader"); err != nil {
			t.Error(err)
		}
		read <- workspace.Name
	}()
	select {
	case name := <-read:
		if name != "Payload Workspace" {
			t.Fatalf("read during the transaction saw %q, want the committed name", name)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a read waited for the writer's transaction")
	}

	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	workspace, err := db.GetWorkspace(ctx, "ws_reader")
	if err != nil || workspace.Name != "Renamed" {
		t.Fatalf("read after commit = %q, %v", workspace.Name, err)
	}
}

// The read pool refuses writes, so a write sent to it by mistake fails
// instead of going around the writer.
func TestReadPoolRefusesWrites(t *testing.T) {
	db := newTestStore(t)
	if db.read == nil || db.reader() != db.read {
		t.Fatal("a file database reads from its read pool")
	}
	_, err := db.read.ExecContext(context.Background(), `INSERT INTO workspace_display_names (workspace_id, name) VALUES ('ws', 'name')`)
	if err == nil || !strings.Contains(err.Error(), "readonly") {
		t.Fatalf("write on the read pool = %v, want a readonly error", err)
	}
}

// An in-memory database is private to its connection, so it reads and
// writes on its one connection.
func TestMemoryStoreReadsOnItsWriter(t *testing.T) {
	db, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if db.read != nil || db.reader() != db.db {
		t.Fatal("an in-memory database has no read pool")
	}
	registerAgentSessionTestDaemon(t, db, "ws_memory", "agent_memory")
	workspaces, err := db.ListWorkspaces(context.Background())
	if err != nil || len(workspaces) != 1 || workspaces[0].ID != "ws_memory" {
		t.Fatalf("workspaces = %+v, %v", workspaces, err)
	}
}

// decodeProbe decodes by querying the database it was read from: with a
// one-connection pool that only works once listJSON has closed its rows.
type decodeProbe struct{}

var decodeProbeDB *sql.DB

func (p *decodeProbe) UnmarshalJSON([]byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var one int
	return decodeProbeDB.QueryRowContext(ctx, `SELECT 1`).Scan(&one)
}

func TestListJSONDecodesAfterReleasingItsConnection(t *testing.T) {
	db, err := sql.Open("sqlite", t.TempDir()+"/probe.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	decodeProbeDB = db
	defer func() { decodeProbeDB = nil }()
	items, err := listJSON[decodeProbe](context.Background(), db, `SELECT '{}' UNION ALL SELECT '{}'`)
	if err != nil || len(items) != 2 {
		t.Fatalf("decoded %d items, %v; decoding held the connection", len(items), err)
	}
}

// The streamed event and every later read agree on when it happened: the
// event's time is the time stored, and the session's last activity.
func TestAppendedEventKeepsTheTimeItCarries(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_event_time", "agent_event_time")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_event_time", AgentID: "agent_event_time", Provider: "codex", Prompt: "time"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	stamped := time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)
	if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{ID: "evt_stamped", SessionID: session.ID, At: stamped, Label: "Response stream", Level: "info"}); err != nil {
		t.Fatal(err)
	}
	if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{ID: "evt_unstamped", SessionID: session.ID, Label: "Response stream", Level: "info"}); err != nil {
		t.Fatal(err)
	}
	events, _, err := db.AgentSessionEventWindow(ctx, session.ID, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	at := map[string]string{}
	for _, event := range events {
		at[event.ID] = event.At
	}
	if at["evt_stamped"] != stamped {
		t.Fatalf("stored at = %q, want the streamed %q", at["evt_stamped"], stamped)
	}
	summary, err := db.GetAgentSessionSummary(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if at["evt_unstamped"] == "" || summary.LastActivityAt != at["evt_unstamped"] {
		t.Fatalf("lastActivityAt = %q, latest event at = %q; want equal", summary.LastActivityAt, at["evt_unstamped"])
	}
}
