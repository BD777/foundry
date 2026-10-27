package sqlitestore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestArchiveNativeGenerationsIgnoreStaleResult(t *testing.T) {
	ctx := context.Background()
	db, v := archiveFixture(t)
	input := store.ArchiveChatsInput{WorkspaceID: v.WorkspaceID, ChatIDs: []string{v.ID}}
	if _, e := db.ArchiveChats(ctx, input, false); e != nil {
		t.Fatal(e)
	}
	first, _ := db.NativeArchiveTargets(ctx, v.DeviceID)
	if len(first) != 1 || first[0].Generation != 1 || first[0].State != "pending" {
		t.Fatal(first)
	}
	// Offline archive -> restore collapses to current active intent.
	if _, e := db.ArchiveChats(ctx, input, true); e != nil {
		t.Fatal(e)
	}
	old := first[0]
	old.State = "archived"
	if e := db.RecordNativeArchiveResult(ctx, old); e != nil {
		t.Fatal(e)
	}
	current, _ := db.NativeArchiveTargets(ctx, v.DeviceID)
	if len(current) != 1 || current[0].Generation != 2 || current[0].State != "pending" || current[0].Desired != "active" {
		t.Fatal(current)
	}
	applied := current[0]
	applied.State = "active"
	if e := db.RecordNativeArchiveResult(ctx, applied); e != nil {
		t.Fatal(e)
	}
	current, _ = db.NativeArchiveTargets(ctx, v.DeviceID)
	if current[0].State != "active" || current[0].AppliedAt == "" {
		t.Fatal(current)
	}
	if e := db.RetryNativeArchive(ctx, v.WorkspaceID, v.ID); e != nil {
		t.Fatal(e)
	}
	current, _ = db.NativeArchiveTargets(ctx, v.DeviceID)
	if current[0].Generation != 3 || current[0].State != "pending" {
		t.Fatal(current)
	}
}

func TestArchiveObservationDeletedFolderOwnerDoesNotAbortDeviceSync(t *testing.T) {
	ctx := context.Background()
	db, owner := archiveFixture(t)
	layout, err := db.GetChatLayout(ctx, owner.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	layout.Groups = []store.ChatLayoutGroup{{ID: "deleted", Name: "Deleted"}}
	layout.Positions = []store.ChatPlacement{{ChatID: owner.ID, GroupID: "deleted"}}
	layout = saveLayout(t, db, owner.WorkspaceID, layout)
	if _, err = db.DeleteChatGroup(ctx, store.DeleteChatGroupInput{WorkspaceID: owner.WorkspaceID, GroupID: "deleted", ExpectedRevision: &layout.Revision}); err != nil {
		t.Fatal(err)
	}
	if _, err = db.GetAgentSessionSummary(ctx, owner.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("owner not hidden: %v", err)
	}
	// A late native binding was not yet known when the folder was deleted.
	if claimed, err := db.claimNativeSession(ctx, owner.ID, sessionRuntime(owner), "late_native", "", false); err != nil || !claimed {
		t.Fatalf("late binding: %v %v", claimed, err)
	}
	chats := []store.ChatThread{
		{ID: "late_projection", WorkspaceID: owner.WorkspaceID, Provider: owner.Provider, NativeSessionID: "late_native", Archived: true},
		{ID: "unrelated", WorkspaceID: owner.WorkspaceID, Title: "unrelated"},
	}
	if err = db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: owner.WorkspaceID, Chats: chats}); err != nil {
		t.Fatalf("chat sync aborted: %v", err)
	}
	if _, err = db.GetChat(ctx, "unrelated"); err != nil {
		t.Fatalf("later chat was not synced: %v", err)
	}
	workspace, err := db.GetWorkspace(ctx, owner.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.RegisterDaemon(ctx, store.DaemonRegistration{Device: store.DeviceProjection{ID: owner.DeviceID, Label: "Updated device", Status: "connected"}, Workspace: workspace, Chats: chats, Agents: []store.AgentProjection{{ID: "new_agent", WorkspaceID: owner.WorkspaceID, DeviceID: owner.DeviceID, Provider: "codex", Status: "healthy"}}}); err != nil {
		t.Fatalf("registration aborted: %v", err)
	}
	var count int
	if err = db.conn().QueryRowContext(ctx, `SELECT count(*) FROM agents WHERE id='new_agent'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("unrelated inventory rolled back: count=%d err=%v", count, err)
	}
	if _, err = db.GetAgentSessionSummary(ctx, owner.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("hidden owner resurrected: %v", err)
	}
	if err = db.conn().QueryRowContext(ctx, `SELECT count(*) FROM native_archive_targets WHERE native_id='late_native'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("hidden owner got archive target: count=%d err=%v", count, err)
	}
}

func TestArchiveObservationCorruptMetadataLogsAndContinuesSync(t *testing.T) {
	for _, owned := range []bool{false, true} {
		t.Run(fmt.Sprint("owned=", owned), func(t *testing.T) {
			ctx := context.Background()
			db, owner := archiveFixture(t)
			id := "unowned_native"
			if owned {
				id = owner.NativeSessionID
			}
			if _, err := db.conn().ExecContext(ctx, `INSERT INTO native_archive_targets(provider,native_id,device_id,session_id,workspace_id,payload_json,generation) VALUES(?,?,?,?,?,'invalid-json',1)`, owner.Provider, id, owner.DeviceID, owner.ID, owner.WorkspaceID); err != nil {
				t.Fatal(err)
			}
			var logged bytes.Buffer
			prior := log.Writer()
			log.SetOutput(&logged)
			t.Cleanup(func() { log.SetOutput(prior) })
			if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: owner.WorkspaceID, Chats: []store.ChatThread{{ID: "broken_observation", WorkspaceID: owner.WorkspaceID, Provider: owner.Provider, NativeSessionID: id, Archived: true}, {ID: "later_chat", WorkspaceID: owner.WorkspaceID, Title: "later"}}}); err != nil {
				t.Fatalf("sync aborted: %v", err)
			}
			if !strings.Contains(logged.String(), "native archive observation failed") {
				t.Fatalf("failure was not logged: %q", logged.String())
			}
			if _, err := db.GetChat(ctx, "later_chat"); err != nil {
				t.Fatalf("later chat not synced: %v", err)
			}
		})
	}
}
