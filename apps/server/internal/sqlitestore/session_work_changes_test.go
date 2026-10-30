package sqlitestore

import (
	"context"
	"database/sql"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func changedIDs(list store.SessionWorkList) []string {
	ids := []string{}
	for _, item := range list.Items {
		ids = append(ids, item.ID)
	}
	return ids
}

func TestDeviceWorkChangesNameOnlyWhatChangedAfterTheCursor(t *testing.T) {
	s, w := workFixture(t)
	ctx := context.Background()
	other := w
	other.ID, other.SourceID = "work_other", "other"
	if _, err := s.SaveSessionWork(ctx, other); err != nil {
		t.Fatal(err)
	}
	elsewhere := w
	elsewhere.ID, elsewhere.SourceID, elsewhere.DeviceID = "work_elsewhere", "elsewhere", "device_b"
	if _, err := s.SaveSessionWork(ctx, elsewhere); err != nil {
		t.Fatal(err)
	}
	full, err := s.DeviceSessionWorkChanges(ctx, "device", "", 100)
	if err != nil || !slices.Equal(changedIDs(full), []string{"work_old", "work_other"}) || full.More || full.Cursor == "" {
		t.Fatalf("first read: %v %+v", err, full)
	}
	idle, err := s.DeviceSessionWorkChanges(ctx, "device", full.Cursor, 100)
	if err != nil || len(idle.Items) != 0 || idle.Cursor != full.Cursor {
		t.Fatalf("nothing changed, yet: %v %+v", err, idle)
	}
	// A repeated identical report writes nothing and so changes nothing.
	if _, err = s.SaveSessionWork(ctx, w); err != nil {
		t.Fatal(err)
	}
	if err = s.ObserveSessionWork(ctx, w.ID, store.WorkObservation{Status: "running", At: "2026-10-29T10:00:00Z", ConfirmedRevision: 1}); err != nil {
		t.Fatal(err)
	}
	// Another device's change advances the cursor but is not listed.
	if err = s.ObserveSessionWork(ctx, elsewhere.ID, store.WorkObservation{Status: "running", At: "2026-10-29T10:00:00Z", ConfirmedRevision: 1}); err != nil {
		t.Fatal(err)
	}
	changed, err := s.DeviceSessionWorkChanges(ctx, "device", full.Cursor, 100)
	if err != nil || !slices.Equal(changedIDs(changed), []string{"work_old"}) || changed.Items[0].Observation.Status != "running" {
		t.Fatalf("observation: %v %+v", err, changed)
	}
	if again, _ := s.DeviceSessionWorkChanges(ctx, "device", changed.Cursor, 100); len(again.Items) != 0 {
		t.Fatalf("a read change was listed again: %+v", again)
	}
}

func TestDeviceWorkChangesPageInChangeOrder(t *testing.T) {
	s, w := workFixture(t)
	ctx := context.Background()
	for _, id := range []string{"work_e", "work_d", "work_c", "work_b"} {
		item := w
		item.ID, item.SourceID = id, id
		if _, err := s.SaveSessionWork(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	var seen []string
	cursor, pages := "", 0
	for {
		page, err := s.DeviceSessionWorkChanges(ctx, "device", cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		pages++
		seen = append(seen, changedIDs(page)...)
		cursor = page.Cursor
		if !page.More {
			break
		}
	}
	if pages != 3 || !slices.Equal(seen, []string{"work_old", "work_e", "work_d", "work_c", "work_b"}) {
		t.Fatalf("pages=%d seen=%v", pages, seen)
	}
}

func TestDeviceWorkChangesReportDeletionsAndForeignCursorsReadAll(t *testing.T) {
	s, w := workFixture(t)
	ctx := context.Background()
	full, _ := s.DeviceSessionWorkChanges(ctx, "device", "", 100)
	// The workspace deletion and the orphan prune delete rows by SQL.
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM session_work WHERE id = ?`, w.ID); err != nil {
		t.Fatal(err)
	}
	gone, err := s.DeviceSessionWorkChanges(ctx, "device", full.Cursor, 100)
	if err != nil || len(gone.Items) != 0 || !slices.Equal(gone.RemovedIDs, []string{w.ID}) {
		t.Fatalf("deletion: %v %+v", err, gone)
	}
	if _, err = s.SaveSessionWork(ctx, w); err != nil {
		t.Fatal(err)
	}
	back, _ := s.DeviceSessionWorkChanges(ctx, "device", full.Cursor, 100)
	if !slices.Equal(changedIDs(back), []string{w.ID}) || len(back.RemovedIDs) != 0 {
		t.Fatalf("a recreated item is reported removed: %+v", back)
	}
	epoch, _, _ := strings.Cut(full.Cursor, ".")
	for _, cursor := range []string{"another.1", epoch + ".999999", "garbage"} {
		list, err := s.DeviceSessionWorkChanges(ctx, "device", cursor, 100)
		if err != nil || !slices.Equal(changedIDs(list), []string{w.ID}) {
			t.Fatalf("cursor %q: %v %+v", cursor, err, list)
		}
	}
}

// An older server binary shares the database during a handoff and writes
// work without knowing about the change sequence.
func TestDeviceWorkChangesIncludeWritesThatDoNotKnowTheSequence(t *testing.T) {
	s, w := workFixture(t)
	ctx := context.Background()
	full, _ := s.DeviceSessionWorkChanges(ctx, "device", "", 100)
	for _, statement := range []string{
		`INSERT INTO session_work(id,thread_id,session_id,device_id,payload_json) VALUES('work_legacy','thread','session','device','{"id":"work_legacy","deviceId":"device","observation":{"status":"idle"}}')`,
		`INSERT INTO session_work(id,thread_id,session_id,device_id,payload_json) VALUES('work_old','thread','session','device','{"id":"work_old","deviceId":"device","observation":{"status":"running"}}') ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`,
	} {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	list, err := s.DeviceSessionWorkChanges(ctx, "device", full.Cursor, 100)
	if err != nil || !slices.Equal(changedIDs(list), []string{"work_legacy", w.ID}) {
		t.Fatalf("legacy writes: %v %+v", err, list)
	}
}

func TestDeviceWorkChangesNumberWorkSavedBeforeTheMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "foundry.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE session_work (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, session_id TEXT NOT NULL, device_id TEXT NOT NULL, payload_json TEXT NOT NULL)`,
		`INSERT INTO session_work VALUES('work_a','thread','session','device','{"id":"work_a","deviceId":"device","observation":{"status":"completed"}}')`,
		`INSERT INTO session_work VALUES('work_b','thread','session','device','{"id":"work_b","deviceId":"device","observation":{"status":"idle"}}')`,
	} {
		if _, err = db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	first, err := s.DeviceSessionWorkChanges(ctx, "device", "", 1)
	if err != nil || !slices.Equal(changedIDs(first), []string{"work_a"}) || !first.More {
		t.Fatalf("first page: %v %+v", err, first)
	}
	second, err := s.DeviceSessionWorkChanges(ctx, "device", first.Cursor, 1)
	if err != nil || !slices.Equal(changedIDs(second), []string{"work_b"}) {
		t.Fatalf("second page: %v %+v", err, second)
	}
	if err = s.ObserveSessionWork(ctx, "work_a", store.WorkObservation{Status: "completed", At: "2026-10-29T10:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	third, _ := s.DeviceSessionWorkChanges(ctx, "device", second.Cursor, 1)
	if !slices.Equal(changedIDs(third), []string{"work_a"}) {
		t.Fatalf("a write after the migration was not numbered after it: %+v", third)
	}
}

// A device's re-reported native state is saved; it was decoded over the
// evidence, looked unchanged, and the device reported it again every sweep.
func TestReportedNativeStateIsSavedOnce(t *testing.T) {
	s, _ := workFixture(t)
	ctx := context.Background()
	native := func(stop string) *store.NativeWorkInfo {
		return &store.NativeWorkInfo{Runtime: "codex", Version: "0.163.0", SessionID: "native", TaskID: "10487", Discovery: "thread/backgroundTerminals/list", Observation: "available", Controls: map[string]string{"stop": stop, "pause": "unsupported", "resume": "unsupported"}}
	}
	item := store.SessionWork{ID: "work_terminal", SessionID: "session", ThreadID: "thread", WorkspaceID: "workspace", DeviceID: "device", Kind: "process", Source: "codex", SourceID: "terminal", Management: "observed", DesiredState: "enabled", Native: native("available"), AllowedActions: []string{}, Observation: store.WorkObservation{Status: "unknown", At: "2026-10-30T03:00:00Z"}}
	if _, err := s.SaveSessionWork(ctx, item); err != nil {
		t.Fatal(err)
	}
	item.Native = native("unavailable")
	saved, err := s.SaveSessionWork(ctx, item)
	if err != nil || saved.Native.Controls["stop"] != "unavailable" {
		t.Fatalf("re-reported native state: %+v %v", saved.Native, err)
	}
	list, _ := s.DeviceSessionWorkChanges(ctx, "device", "", 100)
	for _, w := range list.Items {
		if w.ID == item.ID && w.Native.Controls["stop"] != "unavailable" {
			t.Fatalf("stored native state: %+v", w.Native)
		}
	}
	before, _ := s.DeviceSessionWorkChanges(ctx, "device", "", 100)
	if _, err = s.SaveSessionWork(ctx, item); err != nil {
		t.Fatal(err)
	}
	if after, _ := s.DeviceSessionWorkChanges(ctx, "device", before.Cursor, 100); len(after.Items) != 0 {
		t.Fatalf("an identical report was written again: %+v", after.Items)
	}
}

// Only the time of a report changed: nothing is written, so no device
// reads it as a change; the time is refreshed every ten minutes.
func TestObservationThatOnlyMovesItsTimeIsNotWritten(t *testing.T) {
	s, w := workFixture(t)
	ctx := context.Background()
	observe := func(at string) {
		t.Helper()
		if err := s.ObserveSessionWork(ctx, w.ID, store.WorkObservation{Status: "idle", At: at, ConfirmedRevision: 1, NextFireAt: "2027-01-01T00:00:00Z"}); err != nil {
			t.Fatal(err)
		}
	}
	observe("2026-10-30T03:00:00Z")
	start, _ := s.DeviceSessionWorkChanges(ctx, "device", "", 100)
	for _, at := range []string{"2026-10-30T03:00:03Z", "2026-10-30T03:00:06Z", "2026-10-30T03:09:00Z"} {
		observe(at)
	}
	if list, _ := s.DeviceSessionWorkChanges(ctx, "device", start.Cursor, 100); len(list.Items) != 0 {
		t.Fatalf("time-only reports were written: %+v", list.Items)
	}
	observe("2026-10-30T03:10:30Z")
	refreshed, _ := s.DeviceSessionWorkChanges(ctx, "device", start.Cursor, 100)
	if len(refreshed.Items) != 1 || refreshed.Items[0].Observation.At != "2026-10-30T03:10:30Z" {
		t.Fatalf("ten-minute refresh: %+v", refreshed.Items)
	}
	if err := s.ObserveSessionWork(ctx, w.ID, store.WorkObservation{Status: "running", At: "2026-10-30T03:10:33Z", ConfirmedRevision: 1}); err != nil {
		t.Fatal(err)
	}
	if changed, _ := s.DeviceSessionWorkChanges(ctx, "device", refreshed.Cursor, 100); len(changed.Items) != 1 || changed.Items[0].Observation.Status != "running" {
		t.Fatalf("a real change was not written: %+v", changed.Items)
	}
}
