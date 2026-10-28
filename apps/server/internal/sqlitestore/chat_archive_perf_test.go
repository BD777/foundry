package sqlitestore

import (
	"context"
	"database/sql"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A thread's work list runs several times per archive check and work-panel
// read. Scanning session_work parsed every payload as JSON: ~90 ms per call
// on a 5,600-item database (DEV-060). Each branch must stay an index lookup.
func TestSessionWorkThreadQueryUsesIndexes(t *testing.T) {
	db := newTestStore(t)
	plan := []string{}
	if err := scanRows(context.Background(), db.reader(), `EXPLAIN QUERY PLAN `+sessionWorkThreadSQL, func(rows *sql.Rows) error {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			return err
		}
		plan = append(plan, detail)
		return nil
	}, "thread"); err != nil {
		t.Fatal(err)
	}
	for _, step := range plan {
		if strings.Contains(step, "session_work") && strings.HasPrefix(step, "SCAN") && !strings.Contains(step, "INDEX session_work_related") {
			t.Fatalf("thread work list scans session_work: %q in %q", step, plan)
		}
	}
	if !strings.Contains(strings.Join(plan, "\n"), "session_work_related") {
		t.Fatalf("shared-work branch does not use the partial index: %q", plan)
	}
}

// The archive confirmation is a dry run. It reads one snapshot of the read
// pool, so a long write elsewhere neither delays it nor is delayed by it.
func TestArchiveDryRunDoesNotWaitForTheWriter(t *testing.T) {
	ctx := context.Background()
	db, v := archiveFixture(t)
	held, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Rollback()
	if _, err = held.ExecContext(ctx, `UPDATE agent_sessions SET updated_at=updated_at WHERE id=?`, v.ID); err != nil {
		t.Fatal(err)
	}
	waitCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	result, err := db.ArchiveChats(waitCtx, store.ArchiveChatsInput{WorkspaceID: v.WorkspaceID, ChatIDs: []string{v.ID}, DryRun: true}, false)
	if err != nil || len(result.Archived) != 1 || len(result.Blockers) != 0 {
		t.Fatalf("dry run while the writer is held: %+v %v", result, err)
	}
}

// Lists read archive markers in one batch; each row must carry what a
// single-item read reports.
func TestArchiveListsMatchSingleArchiveInfo(t *testing.T) {
	ctx := context.Background()
	db, v := archiveFixture(t)
	if path := os.Getenv("DEV060_DB"); path != "" {
		db = openTestStore(t, path)
	} else if _, err := db.ArchiveChats(ctx, store.ArchiveChatsInput{WorkspaceID: v.WorkspaceID, ChatIDs: []string{v.ID}, ArchivedByUser: "user"}, false); err != nil {
		t.Fatal(err)
	}
	compared := 0
	for _, mode := range []string{"only", "exclude"} {
		sessions, err := db.ListArchivedSessions(ctx, "", mode)
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range sessions {
			want, err := db.archiveInfo(ctx, s.WorkspaceID, s.ID, s.Provider, s.NativeSessionID)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(want, s.ChatArchive) && !(len(want.NativeArchive) == 0 && len(s.ChatArchive.NativeArchive) == 0 && want.ArchivedAt == s.ChatArchive.ArchivedAt && want.ArchivedByLabel == s.ChatArchive.ArchivedByLabel) {
				t.Fatalf("session %s: list %+v, single %+v", s.ID, s.ChatArchive, want)
			}
			compared++
		}
		chats, err := db.ListArchivedChats(ctx, "", mode)
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range chats {
			want, err := db.archiveInfo(ctx, c.WorkspaceID, c.ID, c.Provider, c.NativeSessionID)
			if err != nil {
				t.Fatal(err)
			}
			if c.Archived != (want.ArchivedAt != "") || want.ArchivedAt != c.ChatArchive.ArchivedAt || len(want.NativeArchive) != len(c.ChatArchive.NativeArchive) {
				t.Fatalf("chat %s: list %+v, single %+v", c.ID, c.ChatArchive, want)
			}
			compared++
		}
	}
	if compared == 0 {
		t.Fatal("nothing compared")
	}
	t.Logf("compared %d rows", compared)
}
