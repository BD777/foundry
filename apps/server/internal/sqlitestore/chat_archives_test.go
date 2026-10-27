package sqlitestore

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func archiveFixture(t *testing.T) (*Store, store.AgentSession) {
	t.Helper()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_archive", "agent_archive")
	v, e := db.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{WorkspaceID: "ws_archive", AgentID: "agent_archive", Provider: "codex", Prompt: "archive fixture", Source: "chat"})
	if e != nil {
		t.Fatal(e)
	}
	v, e = db.CompleteAgentSession(context.Background(), v.ID, "answer", "native_archive")
	if e != nil {
		t.Fatal(e)
	}
	return db, v
}
func TestArchiveRoundTripBatchQueueAndWork(t *testing.T) {
	ctx := context.Background()
	db, v := archiveFixture(t)
	queue, e := db.EnqueueChatMessage(ctx, v.WorkspaceID, v.ID, "user", store.EnqueueChatMessageInput{Text: "next"})
	if e != nil {
		t.Fatal(e)
	}
	w, e := db.SaveSessionWork(ctx, store.SessionWork{ID: "archive_timer", SessionID: v.ID, ThreadID: v.ID, WorkspaceID: v.WorkspaceID, DeviceID: v.DeviceID, Kind: "schedule", Source: "foundry", Management: "managed", DesiredState: "enabled", AllowedActions: []string{"pause", "resume"}, Spec: store.WorkSpec{Prompt: "later", At: "2027-01-01T00:00:00Z"}, Observation: store.WorkObservation{Status: "idle"}})
	if e != nil {
		t.Fatal(e)
	}
	input := store.ArchiveChatsInput{WorkspaceID: v.WorkspaceID, ChatIDs: []string{v.ID}, ArchivedByUser: "user"}
	pre := input
	pre.DryRun = true
	preview, e := db.ArchiveChats(ctx, pre, false)
	if e != nil || len(preview.PausedWork) != 1 {
		t.Fatalf("preview=%+v %v", preview, e)
	}
	before, _ := db.GetAgentSessionSummary(ctx, v.ID)
	if before.ArchivedAt != "" {
		t.Fatal("preflight mutated archive")
	}
	result, e := db.ArchiveChats(ctx, input, false)
	if e != nil || result.BatchID == "" {
		t.Fatalf("archive=%+v %v", result, e)
	}
	active, e := db.ListAgentSessionSummaries(ctx, v.WorkspaceID)
	if e != nil || len(active) != 0 {
		t.Fatalf("active=%+v %v", active, e)
	}
	archived, e := db.ListArchivedSessions(ctx, v.WorkspaceID, "only")
	if e != nil || len(archived) != 1 || archived[0].ArchivedByUser != "user" || len(archived[0].NativeArchive) != 1 {
		t.Fatalf("archived=%+v %v", archived, e)
	}
	if detail, e := db.GetAgentSession(ctx, v.ID); e != nil || detail.Response != "answer" || detail.ArchivedAt == "" {
		t.Fatalf("detail=%+v %v", detail, e)
	}
	if _, e = db.SendAgentSessionInput(ctx, v.ID, store.SendAgentSessionInput{Prompt: "blocked"}); !errors.Is(e, store.ErrSessionArchived) {
		t.Fatalf("send=%v", e)
	}
	if _, e = db.EnqueueChatMessage(ctx, v.WorkspaceID, v.ID, "user", store.EnqueueChatMessageInput{Text: "blocked"}); !errors.Is(e, store.ErrSessionArchived) {
		t.Fatalf("enqueue=%v", e)
	}
	if _, _, e = db.ClaimChatQueueItem(ctx, v.WorkspaceID, v.ID, queue.Items[0].ID, true); !errors.Is(e, store.ErrSessionArchived) {
		t.Fatalf("dispatch=%v", e)
	}
	list, e := db.ListSessionWork(ctx, v.ID, "")
	if e != nil || len(list.Items) != 1 || list.Items[0].DesiredState != "paused" || list.Items[0].Revision <= w.Revision {
		t.Fatalf("work=%+v %v", list, e)
	}
	if _, _, e = db.ClaimWorkRun(ctx, w.ID, list.Items[0].Generation, time.Now().UTC().Format(time.RFC3339Nano)); !errors.Is(e, store.ErrSessionArchived) {
		t.Fatalf("work dispatch=%v", e)
	}
	if _, e = db.ArchiveChats(ctx, store.ArchiveChatsInput{WorkspaceID: v.WorkspaceID, BatchID: result.BatchID}, true); e != nil {
		t.Fatal(e)
	}
	active, e = db.ListAgentSessionSummaries(ctx, v.WorkspaceID)
	if e != nil || len(active) != 1 || active[0].ArchivedAt != "" {
		t.Fatalf("restored=%+v %v", active, e)
	}
	list, _ = db.ListSessionWork(ctx, v.ID, "")
	if list.Items[0].DesiredState != "paused" {
		t.Fatal("unarchive restarted work")
	}
	targets, _ := db.NativeArchiveTargets(ctx, v.DeviceID)
	if len(targets) != 1 || targets[0].Desired != "active" || targets[0].Generation != 2 {
		t.Fatalf("targets=%+v", targets)
	}
	if _, e = db.SendAgentSessionInput(ctx, v.ID, store.SendAgentSessionInput{Prompt: "restored"}); e != nil {
		t.Fatal(e)
	}
}
func TestArchiveFolderAtomicBlockersAndMembershipFence(t *testing.T) {
	ctx := context.Background()
	db, v := archiveFixture(t)
	busy, e := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: v.WorkspaceID, AgentID: v.AgentID, Provider: "codex", Prompt: "busy"})
	if e != nil {
		t.Fatal(e)
	}
	layout, _ := db.GetChatLayout(ctx, v.WorkspaceID)
	layout.Groups = []store.ChatLayoutGroup{{ID: "archive_folder", Name: "Original name"}}
	layout.Positions = []store.ChatPlacement{{ChatID: v.ID, GroupID: "archive_folder"}, {ChatID: busy.ID, GroupID: "archive_folder"}}
	layout = saveLayout(t, db, v.WorkspaceID, layout)
	input := store.ArchiveChatsInput{WorkspaceID: v.WorkspaceID, GroupID: "archive_folder"}
	for _, status := range []string{"queued", "running"} {
		if status == "running" {
			if _, e = db.StartAgentSession(ctx, busy.ID); e != nil {
				t.Fatal(e)
			}
		}
		result, e := db.ArchiveChats(ctx, input, false)
		if !errors.Is(e, store.ErrArchiveBlocked) || len(result.Blockers) != 1 || result.Blockers[0].Reason != "Stop it first" || result.Blockers[0].Code != "running" {
			t.Fatalf("%s: %+v %v", status, result, e)
		}
		detail, _ := db.GetAgentSessionSummary(ctx, v.ID)
		if detail.ArchivedAt != "" {
			t.Fatal("partial folder archive")
		}
	}
	if _, e = db.CompleteAgentSession(ctx, busy.ID, "done", "native_busy"); e != nil {
		t.Fatal(e)
	}
	stale := input
	stale.ExpectedChatIDs = []string{v.ID}
	if _, e = db.ArchiveChats(ctx, stale, false); !errors.Is(e, store.ErrChatLayoutConflict) {
		t.Fatalf("stale confirmation=%v", e)
	}
	result, e := db.ArchiveChats(ctx, input, false)
	if e != nil {
		t.Fatal(e)
	}
	archivedLayout, _ := db.GetChatLayout(ctx, v.WorkspaceID)
	if archivedLayout.Groups[0].ArchivedAt == "" || archivedLayout.Groups[0].ArchiveBatchID != result.BatchID || len(archivedLayout.Positions) != 2 {
		t.Fatalf("layout=%+v", archivedLayout)
	}
	if _, e = db.ArchiveChats(ctx, store.ArchiveChatsInput{WorkspaceID: v.WorkspaceID, BatchID: result.BatchID}, true); e != nil {
		t.Fatal(e)
	}
	restored, _ := db.GetChatLayout(ctx, v.WorkspaceID)
	if restored.Groups[0].ArchivedAt != "" || restored.Groups[0].Name != "Original name" || len(restored.Positions) != 2 {
		t.Fatalf("restore=%+v", restored)
	}
}
func TestArchiveIssueAndPersonalAgentRefused(t *testing.T) {
	ctx := context.Background()
	db, v := archiveFixture(t)
	for _, role := range []string{"issue_execution", store.AgentSessionRolePersonalAgent} {
		if _, e := db.conn().ExecContext(ctx, `UPDATE agent_sessions SET payload_json=json_set(payload_json,'$.role',?) WHERE id=?`, role, v.ID); e != nil {
			t.Fatal(e)
		}
		result, e := db.ArchiveChats(ctx, store.ArchiveChatsInput{WorkspaceID: v.WorkspaceID, ChatIDs: []string{v.ID}}, false)
		want := "issue_owned"
		if role == store.AgentSessionRolePersonalAgent {
			want = "personal_agent"
		}
		if !errors.Is(e, store.ErrArchiveBlocked) || len(result.Blockers) != 1 || result.Blockers[0].Code != want {
			t.Fatalf("%s: %+v %v", role, result, e)
		}
	}
}
func TestArchiveNativeAliasesAndExternalMirror(t *testing.T) {
	ctx := context.Background()
	db, v := archiveFixture(t)
	chat := store.ChatThread{ID: "native_unowned", WorkspaceID: v.WorkspaceID, Provider: "codex", NativeSessionID: "unowned", Title: "native"}
	if e := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: v.WorkspaceID, Chats: []store.ChatThread{chat}}); e != nil {
		t.Fatal(e)
	}
	result, e := db.ArchiveChats(ctx, store.ArchiveChatsInput{WorkspaceID: v.WorkspaceID, ChatIDs: []string{chat.ID}}, false)
	if e != nil {
		t.Fatal(e)
	}
	alias := chat
	alias.ID = "native_alias"
	if e = db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: v.WorkspaceID, Chats: []store.ChatThread{alias}}); e != nil {
		t.Fatal(e)
	}
	detail, e := db.GetChat(ctx, alias.ID)
	if e != nil || detail.ArchivedAt == "" {
		t.Fatalf("alias=%+v %v", detail, e)
	}
	if _, e = db.ArchiveChats(ctx, store.ArchiveChatsInput{WorkspaceID: v.WorkspaceID, BatchID: result.BatchID}, true); e != nil {
		t.Fatal(e)
	}
	detail, _ = db.GetChat(ctx, alias.ID)
	if detail.ArchivedAt != "" {
		t.Fatal("alias failed to restore")
	}
	// New unowned native conversations mirror the scanner in both directions.
	external := chat
	external.ID = "native_external"
	external.NativeSessionID = "external"
	external.Archived = true
	if e = db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: v.WorkspaceID, Chats: []store.ChatThread{external}}); e != nil {
		t.Fatal(e)
	}
	detail, _ = db.GetChat(ctx, external.ID)
	if detail.ArchivedAt == "" {
		t.Fatal("external archive not mirrored")
	}
	external.Archived = false
	if e = db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: v.WorkspaceID, Chats: []store.ChatThread{external}}); e != nil {
		t.Fatal(e)
	}
	detail, _ = db.GetChat(ctx, external.ID)
	if detail.ArchivedAt != "" {
		t.Fatal("external restore not mirrored")
	}
}

func TestArchiveLeavesObservedHostSchedulesAlone(t *testing.T) {
	ctx := context.Background()
	db, v := archiveFixture(t)
	item, err := db.SaveSessionWork(ctx, store.SessionWork{ID: "observed_host_cron", SessionID: v.ID, ThreadID: v.ID, WorkspaceID: v.WorkspaceID, DeviceID: v.DeviceID, Kind: "schedule", Source: "crontab", Title: "unrelated system maintenance", Management: "observed", DesiredState: "enabled", AllowedActions: []string{"adopt"}, Observation: store.WorkObservation{Status: "unknown"}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := db.ArchiveChats(ctx, store.ArchiveChatsInput{WorkspaceID: v.WorkspaceID, ChatIDs: []string{v.ID}}, false)
	if err != nil || len(result.Blockers) != 0 || len(result.PausedWork) != 0 {
		t.Fatalf("archive affected observed inventory: %+v %v", result, err)
	}
	work, err := db.ListSessionWork(ctx, v.ID, "")
	if err != nil || len(work.Items) != 1 || work.Items[0].DesiredState != "enabled" || work.Items[0].Revision != item.Revision {
		t.Fatalf("observed schedule changed: %+v %v", work, err)
	}
}

func TestArchiveIgnoresInactiveSessionNativeWorkWithoutTouchingIt(t *testing.T) {
	for _, status := range []string{"completed", "failed", "canceled"} {
		t.Run(status, func(t *testing.T) {
			ctx := context.Background()
			db, owner := archiveFixture(t)
			if _, err := db.conn().ExecContext(ctx, `UPDATE agent_sessions SET status=?,payload_json=json_set(payload_json,'$.status',?) WHERE id=?`, status, status, owner.ID); err != nil {
				t.Fatal(err)
			}
			for _, spec := range []struct{ id, kind, source, discovery, stop string }{
				{"legacy_claude", "agent", "claude", "legacy native agent lifecycle", "unavailable"},
				{"codex_terminal", "process", "codex", "thread/backgroundTerminals/list", "available"},
				{"codex_no_control", "process", "codex", "thread/backgroundTerminals/list", "unavailable"},
			} {
				actions := []string{}
				if spec.stop == "available" {
					actions = []string{"stop"}
				}
				_, err := db.SaveSessionWork(ctx, store.SessionWork{ID: spec.id, SessionID: owner.ID, ThreadID: owner.ID, WorkspaceID: owner.WorkspaceID, DeviceID: owner.DeviceID, Kind: spec.kind, Source: spec.source, Management: "observed", DesiredState: "enabled", Title: spec.id, AllowedActions: actions, Native: &store.NativeWorkInfo{Runtime: spec.source, Version: "unknown", SessionID: "", TaskID: spec.id, Discovery: spec.discovery, Observation: "unknown", Controls: map[string]string{"stop": spec.stop}}, Observation: store.WorkObservation{Status: "unknown", ConfirmedRevision: 1}})
				if err != nil {
					t.Fatal(err)
				}
			}
			before, err := db.ListSessionWork(ctx, owner.ID, "")
			if err != nil {
				t.Fatal(err)
			}
			input := store.ArchiveChatsInput{WorkspaceID: owner.WorkspaceID, ChatIDs: []string{owner.ID}, DryRun: true}
			preview, err := db.ArchiveChats(ctx, input, false)
			if err != nil || len(preview.Blockers) != 0 || len(preview.PausedWork) != 0 {
				t.Fatalf("native observations block preflight: %+v %v", preview, err)
			}
			input.DryRun = false
			result, err := db.ArchiveChats(ctx, input, false)
			if err != nil || len(result.PausedWork) != 0 {
				t.Fatalf("archive affected native work: %+v %v", result, err)
			}
			after, err := db.ListSessionWork(ctx, owner.ID, "")
			if err != nil || !reflect.DeepEqual(before.Items, after.Items) {
				t.Fatalf("native work changed: before=%+v after=%+v err=%v", before.Items, after.Items, err)
			}
		})
	}
}

func TestArchiveParentLeavesIndependentFoundryChildRunning(t *testing.T) {
	ctx := context.Background()
	db, owner := archiveFixture(t)
	child, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: owner.WorkspaceID, AgentID: owner.AgentID, Provider: "codex", Prompt: "child", ParentSessionID: owner.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.SaveSessionWork(ctx, store.SessionWork{ID: "independent_child", SessionID: owner.ID, ThreadID: owner.ID, WorkspaceID: owner.WorkspaceID, DeviceID: owner.DeviceID, Kind: "agent", Source: "foundry", SourceID: child.ID, Management: "managed", DesiredState: "enabled", AllowedActions: []string{"stop"}, Observation: store.WorkObservation{Status: "running"}}); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ArchiveChats(ctx, store.ArchiveChatsInput{WorkspaceID: owner.WorkspaceID, ChatIDs: []string{owner.ID}}, false); err != nil {
		t.Fatal(err)
	}
	actual, err := db.GetAgentSessionSummary(ctx, child.ID)
	if err != nil || actual.Status != "queued" || actual.ArchivedAt != "" {
		t.Fatalf("independent child changed: %+v %v", actual, err)
	}
}

func TestArchiveDryRunDoesNotPersistNativeWorkReadRepair(t *testing.T) {
	ctx := context.Background()
	db, owner := archiveFixture(t)
	w, err := db.SaveSessionWork(ctx, store.SessionWork{ID: "legacy_ended", SessionID: owner.ID, ThreadID: owner.ID, WorkspaceID: owner.WorkspaceID, DeviceID: owner.DeviceID, Kind: "process", Source: "codex", SourceID: "terminal", Management: "observed", DesiredState: "enabled", Observation: store.WorkObservation{Status: "completed", EndedAt: "2026-10-15T00:00:00Z"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.conn().ExecContext(ctx, `UPDATE session_work SET payload_json=json_set(payload_json,'$.observation.confirmedRevision',0) WHERE id=?`, w.ID); err != nil {
		t.Fatal(err)
	}
	var before, after string
	if err = db.conn().QueryRowContext(ctx, `SELECT payload_json FROM session_work WHERE id=?`, w.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	pre, err := db.ArchiveChats(ctx, store.ArchiveChatsInput{WorkspaceID: owner.WorkspaceID, ChatIDs: []string{owner.ID}, DryRun: true}, false)
	if err != nil || len(pre.Blockers) != 0 || len(pre.PausedWork) != 0 {
		t.Fatalf("preflight=%+v err=%v", pre, err)
	}
	if err = db.conn().QueryRowContext(ctx, `SELECT payload_json FROM session_work WHERE id=?`, w.ID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("dry run persisted a native history repair")
	}
	var archives int
	if err = db.conn().QueryRowContext(ctx, `SELECT count(*) FROM chat_archives`).Scan(&archives); err != nil || archives != 0 {
		t.Fatalf("archive mutation: %d %v", archives, err)
	}
}

func TestArchiveWorkBlockerOffersAnExecutableStop(t *testing.T) {
	ctx := context.Background()
	db, owner := archiveFixture(t)
	work, err := db.SaveSessionWork(ctx, store.SessionWork{ID: "independent_service", SessionID: owner.ID, ThreadID: owner.ID, WorkspaceID: owner.WorkspaceID, DeviceID: owner.DeviceID, Kind: "process", Source: "foundry", Management: "managed", DesiredState: "enabled", Title: "Independent service", AllowedActions: []string{"stop"}, Observation: store.WorkObservation{Status: "running", ConfirmedRevision: 1}})
	if err != nil {
		t.Fatal(err)
	}
	input := store.ArchiveChatsInput{WorkspaceID: owner.WorkspaceID, ChatIDs: []string{owner.ID}, DryRun: true}
	pre, err := db.ArchiveChats(ctx, input, false)
	if err != nil || len(pre.Blockers) != 1 {
		t.Fatalf("preflight=%+v err=%v", pre, err)
	}
	b := pre.Blockers[0]
	if b.Code != "work_unpausable" || b.Action != "stop_work" || b.WorkID != work.ID || b.WorkSessionID != owner.ID || b.WorkRevision != work.Revision {
		t.Fatalf("unusable work action: %+v", b)
	}
	op, err := db.ControlSessionWork(ctx, b.WorkSessionID, b.WorkSessionID, store.WorkControlInput{ID: b.WorkID, Action: "stop", ExpectedRevision: b.WorkRevision, ExpectedReferenceRevision: b.WorkReferenceRevision, IdempotencyKey: "archive-dialog-stop"})
	if err != nil || len(op.Items) != 1 {
		t.Fatalf("stop=%+v err=%v", op, err)
	}
	if err = db.ObserveSessionWork(ctx, work.ID, store.WorkObservation{Status: "stopped", ConfirmedRevision: op.Items[0].Revision, At: "2026-10-27T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	list, err := db.ListSessionWork(ctx, owner.ID, "")
	if err != nil || len(list.Operations) != 1 || list.Operations[0].State != "verified" {
		t.Fatalf("stop not verified: %+v %v", list, err)
	}
	pre, err = db.ArchiveChats(ctx, input, false)
	if err != nil || len(pre.Blockers) != 0 {
		t.Fatalf("action did not resolve blocker: %+v %v", pre, err)
	}
}
