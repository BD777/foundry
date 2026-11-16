package sqlitestore

import (
	"context"
	"errors"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestMaintenanceCoalescesUnsentButPreservesAcceptedReceipt(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	add := func(id, key string) store.PersonalAgentMaintenance {
		t.Helper()
		j, e := db.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{ID: id, UserID: "u", AssistantID: "asst_u", WorkspaceID: "w", Role: "governance", EventKey: key})
		if e != nil {
			t.Fatal(e)
		}
		return j
	}
	a := add("a", "v1")
	replay := add("ignored", "v1")
	if replay.ID != a.ID {
		t.Fatal("same event duplicated")
	}
	b := add("b", "v2")
	a, _ = db.GetPersonalAgentMaintenance(ctx, "asst_u", a.ID)
	if a.Status != "superseded" {
		t.Fatal("unsent event not coalesced")
	}
	b.Status = "starting"
	b.InputID = "native-input"
	b, e := db.SavePersonalAgentMaintenance(ctx, b)
	if e != nil {
		t.Fatal(e)
	}
	c := add("c", "v3")
	b, _ = db.GetPersonalAgentMaintenance(ctx, "asst_u", b.ID)
	if b.Status != "starting" {
		t.Fatal("accepted input replaced")
	}
	c.Status = "starting"
	if _, e = db.SavePersonalAgentMaintenance(ctx, c); e == nil {
		t.Fatal("parallel maintenance bypassed concurrency cap")
	}
	if _, e = db.GetPersonalAgentMaintenance(ctx, "asst_other", b.ID); !errors.Is(e, store.ErrNotFound) {
		t.Fatal("cross assistant read")
	}
	b.Status = "review"
	saved, e := db.SavePersonalAgentMaintenance(ctx, b)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.SavePersonalAgentMaintenance(ctx, b); !errors.Is(e, store.ErrPersonalAgentRevision) {
		t.Fatal("stale result overwrote decision")
	}
	saved.Result = &store.MaintenanceResult{Summary: "healthy"}
	if _, e = db.SavePersonalAgentMaintenance(ctx, saved); e != nil {
		t.Fatal(e)
	}
}

func TestProjectUpkeepSurvivesItsExecutorAndIsReadByWorkspace(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	first, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: "person", WorkspaceID: "ws_home", HomeDeviceID: "dev_home"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: "person", Name: "Research", WorkspaceID: "ws_second", HomeDeviceID: "dev_home"})
	if err != nil {
		t.Fatal(err)
	}
	// A project review whose last executor was not the default assistant.
	review, err := db.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{ID: "project-review", UserID: "person", AssistantID: second.ID, Role: "governance", WorkspaceID: "ws_project", EventKey: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{ID: "memory-review", UserID: "person", AssistantID: second.ID, Role: "memory", WorkspaceID: "ws_second", EventKey: "m1"}); err != nil {
		t.Fatal(err)
	}
	execAll(t, db, `INSERT INTO pa_context_patches (id,user_id,assistant_id,workspace_id,status,revision,payload_json) VALUES ('patch','person','`+second.ID+`','ws_project','applied',1,'{"id":"patch","jobId":"project-review","workspaceId":"ws_project","index":0,"path":"AGENTS.md","status":"applied","revision":1}')`)

	// A project review is read by its workspace, never by an assistant id.
	memory, err := db.ListAssistantMemoryMaintenance(ctx, second.ID)
	if err != nil || len(memory) != 1 || memory[0].ID != "memory-review" {
		t.Fatalf("assistant memory upkeep = %+v (%v)", memory, err)
	}
	listed, err := db.ListWorkspaceMaintenance(ctx, "person", "ws_project")
	if err != nil || len(listed) != 1 || listed[0].ID != review.ID {
		t.Fatalf("workspace upkeep = %+v (%v)", listed, err)
	}
	if _, err := db.GetWorkspaceMaintenance(ctx, "other", "ws_project", review.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another person read the review: %v", err)
	}

	// A later run resolves its executor; ownership does not move.
	if err := db.RebindPersonalAgentMaintenance(ctx, second.ID, review.ID, first.ID); err != nil {
		t.Fatal(err)
	}
	bound, err := db.GetWorkspaceMaintenance(ctx, "person", "ws_project", review.ID)
	if err != nil || bound.AssistantID != first.ID {
		t.Fatalf("rebound review = %+v (%v)", bound, err)
	}
	if err := db.RebindPersonalAgentMaintenance(ctx, first.ID, "memory-review", second.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("rebound a memory review: %v", err)
	}

	// Deleting the last executor keeps the project's review and its file
	// change; the assistant's own memory review goes with it.
	if err := db.DeleteAssistant(ctx, second.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.GetWorkspaceMaintenance(ctx, "person", "ws_project", review.ID); err != nil {
		t.Fatalf("project review removed with its executor: %v", err)
	}
	if got := countRows(t, db, `SELECT count(*) FROM pa_context_patches WHERE id='patch'`); got != 1 {
		t.Fatalf("project file change removed with its executor: %d", got)
	}
	if _, err := db.GetPersonalAgentMaintenance(ctx, second.ID, "memory-review"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("memory review survived its assistant: %v", err)
	}
}

func TestMaintenanceRetryRequiresNativeEndAndCanRefreshUnsentSettings(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	job, err := db.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{ID: "review", UserID: "person", AssistantID: "asst_person", Role: "governance", WorkspaceID: "workspace", EventKey: "context-version"})
	if err != nil {
		t.Fatal(err)
	}
	job.Status, job.InputID, job.SessionID = "failed", "input", "session"
	job, err = db.SavePersonalAgentMaintenance(ctx, job)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.EnsurePersonalAgentRunControl(ctx, store.PersonalAgentRunControl{ID: "control", UserID: job.UserID, AssistantID: job.AssistantID, SessionID: job.SessionID, InputID: job.InputID, DispatchAttempted: true})
	if err != nil {
		t.Fatal(err)
	}
	retry := job
	retry.Status = "pending"
	retry.Attempt++
	retry.InputID = ""
	retry.SessionID = ""
	retry.SnapshotID = ""
	if _, err = db.SavePersonalAgentMaintenance(ctx, retry); !errors.Is(err, store.ErrPersonalAgentInputUnconfirmed) {
		t.Fatalf("retried unknown native outcome: %v", err)
	}
	if err = db.NotePersonalAgentNativeEnd(ctx, job.SessionID, job.InputID, "failed"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.SavePersonalAgentMaintenance(ctx, retry); err != nil {
		t.Fatal(err)
	}
	pending, err := db.EnqueuePersonalAgentMaintenance(ctx, store.PersonalAgentMaintenance{ID: "waiting", UserID: "person", AssistantID: "asst_person", Role: "memory", WorkspaceID: "other", EventKey: "fresh"})
	if err != nil {
		t.Fatal(err)
	}
	pending.Status = "waiting"
	pending, err = db.SavePersonalAgentMaintenance(ctx, pending)
	if err != nil {
		t.Fatal(err)
	}
	pending.Status = "pending"
	pending.Attempt++
	if _, err = db.SavePersonalAgentMaintenance(ctx, pending); err != nil {
		t.Fatal("unsent configuration cannot be refreshed", err)
	}
}
