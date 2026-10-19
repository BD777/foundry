package sqlitestore

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func workFixture(t *testing.T) (*Store, store.SessionWork) {
	t.Helper()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	w, err := s.SaveSessionWork(context.Background(), store.SessionWork{ID: "work_old", SessionID: "session", ThreadID: "thread", WorkspaceID: "workspace", DeviceID: "device", Kind: "schedule", Source: "claude", SourceID: "9b17c9d2", Management: "managed", DesiredState: "enabled", AllowedActions: []string{"pause", "resume", "stop", "remove", "run"}, Observation: store.WorkObservation{Status: "idle"}})
	if err != nil {
		t.Fatal(err)
	}
	return s, w
}
func TestWorkStopBarrierSurvivesLateSnapshotAndNewItems(t *testing.T) {
	s, w := workFixture(t)
	ctx := context.Background()
	op, err := s.ControlSessionWork(ctx, "thread", "session", store.WorkControlInput{Action: "stop_all", IdempotencyKey: "stop"})
	if err != nil || len(op.Items) != 1 {
		t.Fatalf("stop=%+v %v", op, err)
	}
	w.DesiredState = "enabled"
	saved, err := s.SaveSessionWork(ctx, w)
	if err != nil || saved.DesiredState != "stopped" {
		t.Fatalf("late snapshot revived work: %+v %v", saved, err)
	}
	w.ID = "work_new"
	saved, err = s.SaveSessionWork(ctx, w)
	if err != nil || saved.DesiredState != "stopped" {
		t.Fatalf("late child escaped barrier: %+v %v", saved, err)
	}
	if _, _, err = s.ClaimWorkRun(ctx, "work_old", 1, time.Now().UTC().Format(time.RFC3339Nano)); err == nil {
		t.Fatal("a stopped generation started")
	}
	list, _ := s.ListSessionWork(ctx, "thread", "")
	if !list.Barrier || list.Operations[0].State != "pending" {
		t.Fatalf("unconfirmed stop looks verified: %+v", list)
	}
}
func TestWorkControlIdempotencyRevisionAndObservation(t *testing.T) {
	s, w := workFixture(t)
	ctx := context.Background()
	input := store.WorkControlInput{ID: w.ID, Action: "pause", ExpectedRevision: w.Revision, IdempotencyKey: "pause"}
	op, err := s.ControlSessionWork(ctx, "thread", "session", input)
	if err != nil {
		t.Fatal(err)
	}
	copy, err := s.ControlSessionWork(ctx, "thread", "session", input)
	if err != nil || copy.ID != op.ID {
		t.Fatalf("retry duplicated operation: %+v %v", copy, err)
	}
	input.Action = "resume"
	if _, err = s.ControlSessionWork(ctx, "thread", "session", input); err == nil {
		t.Fatal("reused key accepted another mutation")
	}
	input.IdempotencyKey = "stale"
	if _, err = s.ControlSessionWork(ctx, "thread", "session", input); err == nil {
		t.Fatal("stale revision accepted")
	}
	if err = s.ObserveSessionWork(ctx, w.ID, store.WorkObservation{Status: "stopped", At: "2026-10-17T00:40:00Z", ConfirmedRevision: op.Items[0].Revision}); err != nil {
		t.Fatal(err)
	}
	_ = s.ObserveSessionWork(ctx, w.ID, store.WorkObservation{Status: "running", At: "2026-10-17T00:41:00Z", ConfirmedRevision: 1})
	list, _ := s.ListSessionWork(ctx, "thread", "")
	if list.Items[0].Observation.Status != "stopped" || list.Operations[0].State != "verified" {
		t.Fatalf("old observation won: %+v", list)
	}
}
func TestWorkRunClaimOnceAndManualRunPreservesPause(t *testing.T) {
	s, w := workFixture(t)
	ctx := context.Background()
	op, err := s.ControlSessionWork(ctx, "thread", "session", store.WorkControlInput{ID: w.ID, Action: "pause", ExpectedRevision: 1, IdempotencyKey: "pause"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.ControlSessionWork(ctx, "thread", "session", store.WorkControlInput{ID: w.ID, Action: "run", ExpectedRevision: op.Items[0].Revision, IdempotencyKey: "run"})
	if err != nil {
		t.Fatal(err)
	}
	list, _ := s.ListSessionWork(ctx, "thread", "")
	current := list.Items[0]
	if current.DesiredState != "paused" || current.Spec.ManualRunAt == "" {
		t.Fatalf("manual run changed pause: %+v", current)
	}
	run, claimed, err := s.ClaimWorkRun(ctx, w.ID, current.Generation, current.Spec.ManualRunAt)
	if err != nil || !claimed {
		t.Fatalf("manual claim=%v %v", claimed, err)
	}
	_, claimed, err = s.ClaimWorkRun(ctx, w.ID, current.Generation, current.Spec.ManualRunAt)
	if err == nil && claimed {
		t.Fatal("claimed the same execution twice")
	}
	list, _ = s.ListSessionWork(ctx, "thread", "")
	if list.Items[0].Spec.ManualRunAt != current.Spec.ManualRunAt {
		t.Fatal("claim discarded authorization for its in-flight manual execution")
	}
	run.Status, run.EndedAt = "completed", time.Now().UTC().Format(time.RFC3339Nano)
	if err = s.FinishWorkRun(ctx, run); err != nil {
		t.Fatal(err)
	}
	list, _ = s.ListSessionWork(ctx, "thread", "")
	if list.Items[0].DesiredState != "paused" || list.Items[0].Spec.ManualRunAt != "" {
		t.Fatal("ended manual execution did not retire its single-run authorization while preserving pause")
	}
}

func TestWorkDirectScopeDoesNotControlChildWork(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	registerAgentSessionTestDaemon(t, s, "ws_work", "agent_work")
	root, err := s.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_work", AgentID: "agent_work", Provider: "codex", Prompt: "root"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := s.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_work", AgentID: "agent_work", Provider: "codex", Prompt: "child", ParentSessionID: root.ID})
	if err != nil {
		t.Fatal(err)
	}
	w := store.SessionWork{ID: "nested", SessionID: child.ID, ThreadID: child.ID, DeviceID: child.DeviceID, Kind: "schedule", Management: "managed", DesiredState: "enabled", AllowedActions: []string{"stop"}}
	if _, err = s.SaveSessionWork(ctx, w); err != nil {
		t.Fatal(err)
	}
	observed := w
	observed.ID = "unassigned"
	observed.Management = "observed"
	observed.AllowedActions = []string{"adopt"}
	if _, err = s.SaveSessionWork(ctx, observed); err != nil {
		t.Fatal(err)
	}
	op, err := s.ControlSessionWork(ctx, root.ID, root.ID, store.WorkControlInput{Action: "stop_all", IdempotencyKey: "stop"})
	if err != nil || len(op.Items) != 0 || op.Unmanaged != 0 {
		t.Fatalf("op=%+v %v", op, err)
	}
	late := w
	late.ID = "late_nested"
	late, err = s.SaveSessionWork(ctx, late)
	if err != nil || late.DesiredState != "enabled" {
		t.Fatalf("child work was affected by parent barrier: %+v %v", late, err)
	}
	list, err := s.ListSessionWork(ctx, child.ID, "")
	if err != nil || list.Barrier {
		t.Fatalf("parent barrier leaked into child %+v %v", list, err)
	}
	for _, item := range list.Items {
		if item.ID == observed.ID && item.DesiredState != "enabled" {
			t.Fatal("bulk control adopted unrelated source")
		}
	}
}

func TestWorkObservationUsesInstantsNotLexicalFractions(t *testing.T) {
	s, w := workFixture(t)
	ctx := context.Background()
	if err := s.ObserveSessionWork(ctx, w.ID, store.WorkObservation{Status: "running", At: "2026-10-17T01:00:00.1Z", ConfirmedRevision: 1}); err != nil {
		t.Fatal(err)
	}
	if err := s.ObserveSessionWork(ctx, w.ID, store.WorkObservation{Status: "idle", At: "2026-10-17T01:00:00Z", ConfirmedRevision: 1}); err != nil {
		t.Fatal(err)
	}
	list, _ := s.ListSessionWork(ctx, "thread", "")
	if list.Items[0].Observation.Status != "running" {
		t.Fatal("older whole-second timestamp replaced newer fractional timestamp")
	}
}

func TestWorkNewObservationErrorDoesNotLookVerified(t *testing.T) {
	s, w := workFixture(t)
	ctx := context.Background()
	op, err := s.ControlSessionWork(ctx, "thread", "session", store.WorkControlInput{ID: w.ID, Action: "pause", ExpectedRevision: 1, IdempotencyKey: "pause"})
	if err != nil {
		t.Fatal(err)
	}
	revision := op.Items[0].Revision
	_ = s.ObserveSessionWork(ctx, w.ID, store.WorkObservation{Status: "stopped", At: "2026-10-17T01:00:00Z", ConfirmedRevision: revision})
	_ = s.ObserveSessionWork(ctx, w.ID, store.WorkObservation{Status: "unknown", At: "2026-10-17T01:00:01Z", ConfirmedRevision: revision, Error: "source changed; could not reconcile"})
	list, err := s.ListSessionWork(ctx, "thread", "")
	if err != nil || list.Operations[0].State != "failed" || list.Items[0].Observation.Error == "" {
		t.Fatalf("fresh failure hidden: %+v %v", list, err)
	}
}

func TestWorkEmptyStopWaitsForDeviceSweepAndIncludesLateSources(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	registerAgentSessionTestDaemon(t, s, "ws_sweep", "agent_sweep")
	root, err := s.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_sweep", AgentID: "agent_sweep", Provider: "codex", Prompt: "root"})
	if err != nil {
		t.Fatal(err)
	}
	op, err := s.ControlSessionWork(ctx, root.ID, root.ID, store.WorkControlInput{Action: "stop_all", IdempotencyKey: "empty"})
	if err != nil || op.Sequence <= 0 {
		t.Fatalf("operation %+v %v", op, err)
	}
	check := func(want string) {
		t.Helper()
		list, e := s.ListSessionWork(ctx, root.ID, "")
		if e != nil || len(list.Operations) != 1 || list.Operations[0].State != want {
			t.Fatalf("want %s, got %+v %v", want, list, e)
		}
	}
	check("pending")
	coverage := map[string]string{"hostSchedules": "observed", "processes": "managed_native_and_attributed", "observedAt": "9999-01-01T00:00:00Z", "sweepRevision": "0"}
	if err = s.SaveWorkCoverage(ctx, root.DeviceID, coverage); err != nil {
		t.Fatal(err)
	}
	check("pending")
	coverage["sweepRevision"] = fmt.Sprint(op.Sequence)
	if err = s.SaveWorkCoverage(ctx, root.DeviceID, coverage); err != nil {
		t.Fatal(err)
	}
	check("verified")
	late, err := s.SaveSessionWork(ctx, store.SessionWork{ID: "late_after_empty_sweep", SessionID: root.ID, ThreadID: root.ID, DeviceID: root.DeviceID, Kind: "schedule", Management: "managed", DesiredState: "enabled", AllowedActions: []string{"stop"}, Observation: store.WorkObservation{Status: "unknown"}})
	if err != nil {
		t.Fatal(err)
	}
	check("pending")
	if late.DesiredState != "stopped" {
		t.Fatal("late work escaped stop barrier")
	}
	if err = s.ObserveSessionWork(ctx, late.ID, store.WorkObservation{Status: "stopped", At: time.Now().UTC().Format(time.RFC3339Nano), ConfirmedRevision: late.Revision}); err != nil {
		t.Fatal(err)
	}
	check("verified")
	late.ID = "late_unassigned"
	late.Management = "observed"
	if _, err = s.SaveSessionWork(ctx, late); err != nil {
		t.Fatal(err)
	}
	check("unknown")
}

func TestWorkPauseIncludesAnOlderScheduleDiscoveredAfterTheRequest(t *testing.T) {
	s, w := workFixture(t)
	ctx := context.Background()
	w.Management = "managed"
	w.ID = "late_old"
	w.CreatedAt = "2026-10-10T00:00:00Z"
	if _, err := s.ControlSessionWork(ctx, "thread", "session", store.WorkControlInput{Action: "pause_all", IdempotencyKey: "pause"}); err != nil {
		t.Fatal(err)
	}
	old, err := s.SaveSessionWork(ctx, w)
	if err != nil || old.DesiredState != "paused" {
		t.Fatalf("old timer escaped pause: %+v %v", old, err)
	}
	w.ID = "new_explicit"
	w.CreatedAt = time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano)
	fresh, err := s.SaveSessionWork(ctx, w)
	if err != nil || fresh.DesiredState != "enabled" {
		t.Fatalf("new definition unexpectedly inherited an old pause: %+v %v", fresh, err)
	}
}

func TestWorkNativeTerminalHistoryIsNotAnUnconfirmedControl(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	history := store.SessionWork{ID: "history", SessionID: "s", ThreadID: "t", Source: "claude", SourceID: "native-task", Kind: "process", Management: "managed", DesiredState: "enabled", AllowedActions: []string{"stop"}, Observation: store.WorkObservation{Status: "completed", At: "2026-10-13T02:00:00Z", EndedAt: "2026-10-13T02:00:00Z"}}
	saved, err := s.SaveSessionWork(ctx, history)
	if err != nil || saved.Observation.ConfirmedRevision != saved.Revision {
		t.Fatalf("terminal history became pending: %+v %v", saved, err)
	}
	// Reproduce a pre-fix imported row whose completion existed before control.
	saved.Observation.ConfirmedRevision = 0
	if err = s.writeWork(ctx, saved); err != nil {
		t.Fatal(err)
	}
	op, err := s.ControlSessionWork(ctx, "t", "s", store.WorkControlInput{ID: saved.ID, Action: "stop", ExpectedRevision: saved.Revision, IdempotencyKey: "legacy-stop"})
	if err != nil {
		t.Fatal(err)
	}
	repaired, err := s.SaveSessionWork(ctx, history)
	if err != nil || repaired.DesiredState != "stopped" || repaired.Observation.ConfirmedRevision != op.Items[0].Revision || repaired.Observation.Status != "completed" {
		t.Fatalf("history repair lost intent or outcome: %+v %v", repaired, err)
	}
	history.Observation.Status = "running"
	history.Observation.EndedAt = ""
	again, err := s.SaveSessionWork(ctx, history)
	if err != nil || again.Observation.Status != "completed" {
		t.Fatalf("stale running snapshot revived history: %+v %v", again, err)
	}
}

func TestWorkHistoryCannotConfirmUnknownSourcesOrNewExecutions(t *testing.T) {
	for _, mode := range []string{"schedule", "missing-end", "device-observed", "new-generation", "error"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			s := newTestStore(t)
			item := store.SessionWork{ID: "task", SessionID: "s", ThreadID: "t", Source: "claude", SourceID: "id", Kind: "process", Management: "managed", DesiredState: "enabled", AllowedActions: []string{"stop", "resume"}, Observation: store.WorkObservation{Status: "running", At: "2026-10-13T01:00:00Z"}}
			if mode == "schedule" {
				item.Kind = "schedule"
			}
			saved, err := s.SaveSessionWork(ctx, item)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "device-observed":
				saved.Observation.ConfirmedRevision = 1
			case "new-generation":
				saved.Generation = 2
			case "error":
				saved.Observation.Error = "Source identity uncertain"
			}
			if err = s.writeWork(ctx, saved); err != nil {
				t.Fatal(err)
			}
			evidence := item
			evidence.Observation.Status = "completed"
			evidence.Observation.EndedAt = "2026-10-13T02:00:00Z"
			if mode == "missing-end" {
				evidence.Observation.EndedAt = ""
			}
			got, err := s.SaveSessionWork(ctx, evidence)
			if err != nil || got.Observation.Status != "running" || got.Generation != saved.Generation {
				t.Fatalf("unsafe history inference: %+v %v", got, err)
			}
		})
	}
}

func TestWorkBulkControlsLeaveFinishedHistoryAndStoppedSchedulesAlone(t *testing.T) {
	ctx := context.Background()
	s, active := workFixture(t)
	history := store.SessionWork{ID: "history", SessionID: "session", ThreadID: "thread", Source: "claude", SourceID: "done", Kind: "agent", Management: "managed", DesiredState: "enabled", AllowedActions: []string{"stop"}, Observation: store.WorkObservation{Status: "completed", At: "2026-10-13T02:00:00Z", EndedAt: "2026-10-13T02:00:00Z"}}
	saved, err := s.SaveSessionWork(ctx, history)
	if err != nil {
		t.Fatal(err)
	}
	stopped := active
	stopped.ID = "stopped"
	stopped.Management = "managed"
	stopped.DesiredState = "stopped"
	stopped.Observation = store.WorkObservation{Status: "stopped", ConfirmedRevision: 1}
	if _, err = s.SaveSessionWork(ctx, stopped); err != nil {
		t.Fatal(err)
	}
	op, err := s.ControlSessionWork(ctx, "thread", "session", store.WorkControlInput{Action: "pause_all", IdempotencyKey: "pause"})
	if err != nil || len(op.Items) != 1 || op.Items[0].ID != active.ID {
		t.Fatalf("pause touched finished/stopped items: %+v %v", op, err)
	}
	op, err = s.ControlSessionWork(ctx, "thread", "session", store.WorkControlInput{Action: "stop_all", IdempotencyKey: "stop"})
	if err != nil || len(op.Items) != 1 || op.Items[0].ID != active.ID {
		t.Fatalf("stop made history pending again: %+v %v", op, err)
	}
	list, err := s.ListSessionWork(ctx, "thread", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range list.Items {
		if item.ID == saved.ID && (item.DesiredState != "enabled" || item.Revision != 1 || item.Observation.ConfirmedRevision != 1) {
			t.Fatalf("historical outcome was changed: %+v", item)
		}
	}
}

func TestWorkExternalProcessRolesAndVerifiedExitSurviveLegacyReports(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	item := store.SessionWork{ID: "runtime", SessionID: "s", ThreadID: "t", Source: "process", SourceID: "9:boot:1", Kind: "process", Management: "managed", DesiredState: "enabled", AllowedActions: []string{"stop", "remove"}, Observation: store.WorkObservation{Status: "running", At: "2026-10-17T01:00:00Z", ConfirmedRevision: 1, ProcessRole: "runtime"}}
	saved, err := s.SaveSessionWork(ctx, item)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ControlSessionWork(ctx, "t", "s", store.WorkControlInput{ID: saved.ID, Action: "stop", ExpectedRevision: 1, IdempotencyKey: "unsafe"}); err == nil {
		t.Fatal("allowed stopping runtime infrastructure")
	}
	legacyStop := store.WorkOperation{Action: "stop", Items: []store.WorkOperationItem{{ID: saved.ID, Revision: saved.Revision}}}
	if workOperationState(legacyStop, []store.SessionWork{saved}, nil) == "verified" {
		t.Fatal("classification acknowledged a legacy stop without proving exit")
	}
	op, err := s.ControlSessionWork(ctx, "t", "s", store.WorkControlInput{Action: "stop_all", IdempotencyKey: "bulk"})
	if err != nil || len(op.Items) != 0 {
		t.Fatalf("bulk targeted runtime: %+v %v", op, err)
	}
	if err = s.ObserveSessionWork(ctx, item.ID, store.WorkObservation{Status: "running", At: "2026-10-17T02:00:00Z", ConfirmedRevision: 1}); err != nil {
		t.Fatal(err)
	}
	list, _ := s.ListSessionWork(ctx, "t", "")
	if list.Items[0].Observation.ProcessRole != "runtime" {
		t.Fatal("legacy snapshot erased runtime classification")
	}
	if err = s.ObserveSessionWork(ctx, item.ID, store.WorkObservation{Status: "completed", At: "2026-10-17T03:00:00Z", EndedAt: "2026-10-17T03:00:00Z", ConfirmedRevision: 1}); err != nil {
		t.Fatal(err)
	}
	if err = s.ObserveSessionWork(ctx, item.ID, store.WorkObservation{Status: "unknown", At: "2026-10-17T04:00:00Z", ConfirmedRevision: 1}); err != nil {
		t.Fatal(err)
	}
	list, _ = s.ListSessionWork(ctx, "t", "")
	if list.Items[0].Observation.Status != "completed" {
		t.Fatal("unknown revived a verified exited identity")
	}
	if _, err = s.ControlSessionWork(ctx, "t", "s", store.WorkControlInput{ID: item.ID, Action: "remove", ExpectedRevision: 1, IdempotencyKey: "archive"}); err != nil {
		t.Fatal(err)
	}
	list, _ = s.ListSessionWork(ctx, "t", "")
	if list.Items[0].Observation.ConfirmedRevision != 2 || list.Items[0].DesiredState != "removed" {
		t.Fatalf("archive lost exit evidence %+v", list.Items[0])
	}
}

func TestWorkUnclassifiedProcessesCannotClaimVerifiedDiscoveryOrReceiveStop(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	item := store.SessionWork{ID: "legacy", SessionID: "s", ThreadID: "t", DeviceID: "d", Source: "process", SourceID: "9:boot:1", Kind: "process", Management: "managed", DesiredState: "enabled", AllowedActions: []string{"stop"}, Observation: store.WorkObservation{Status: "running", ConfirmedRevision: 1}}
	if _, err := s.SaveSessionWork(ctx, item); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListSessionWork(ctx, "t", "")
	if err != nil || list.Coverage["processes"] != "unverified" {
		t.Fatalf("unclassified process became successful discovery: %+v %v", list.Coverage, err)
	}
	if _, err = s.ControlSessionWork(ctx, "t", "s", store.WorkControlInput{ID: item.ID, Action: "stop", ExpectedRevision: 1, IdempotencyKey: "unsafe"}); err == nil {
		t.Fatal("unclassified process received stop")
	}
	if err = s.ObserveSessionWork(ctx, item.ID, store.WorkObservation{Status: "running", At: "2026-10-17T05:00:00Z", ConfirmedRevision: 1, ProcessRole: "background"}); err != nil {
		t.Fatal(err)
	}
	op, err := s.ControlSessionWork(ctx, "t", "s", store.WorkControlInput{Action: "stop_all", IdempotencyKey: "actual-background"})
	if err != nil || len(op.Items) != 1 || op.Items[0].ID != item.ID {
		t.Fatalf("verified background process lost its control: %+v %v", op, err)
	}
}

func TestWorkReadRepairsRetainedNativeHistoryWithoutLatestSnapshot(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	for _, status := range []string{"completed", "stopped", "failed", "running"} {
		item := store.SessionWork{ID: status, SessionID: "s", ThreadID: "t", Source: "claude", SourceID: status, Kind: "process", Management: "managed", DesiredState: "enabled", Revision: 1, Generation: 1, Observation: store.WorkObservation{Status: status, At: "2026-10-17T01:00:00Z", EndedAt: "2026-10-17T01:00:00Z", ConfirmedRevision: 0}}
		if err := s.writeWork(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	for n := 0; n < 2; n++ {
		list, err := s.ListSessionWork(ctx, "t", "")
		if err != nil || len(list.Items) != 4 {
			t.Fatalf("retained history: %+v %v", list, err)
		}
		for _, item := range list.Items {
			want := int64(1)
			if item.ID == "running" {
				want = 0
			}
			if item.Observation.ConfirmedRevision != want || item.Revision != 1 || item.DesiredState != "enabled" || item.Observation.Status != item.ID {
				t.Fatalf("history not repaired idempotently or execution evidence changed: %+v", item)
			}
		}
	}
}

func TestWorkRunIdentityAndTerminalOutcomeSurvivePartialAndLateUpdates(t *testing.T) {
	s, w := workFixture(t)
	ctx := context.Background()
	run, claimed, err := s.ClaimWorkRun(ctx, w.ID, 1, "2026-10-17T01:00:00.000Z")
	if err != nil || !claimed || run.Status != "unknown" {
		t.Fatalf("claim implied delivery: %+v %v", run, err)
	}
	if len(run.InputID) != 36 || run.InputID[14] != '5' || run.InputID != store.WorkRunInputID(w.SessionID, run.ID) {
		t.Fatalf("native input has no stable UUIDv5 identity: %q", run.InputID)
	}
	if run.InputID == store.WorkRunInputID(w.SessionID, run.ID+"-other-generation-or-slot") {
		t.Fatal("distinct run identities share a native input")
	}
	copy, claimed, err := s.ClaimWorkRun(ctx, w.ID, 1, "2026-10-17T09:00:00+08:00")
	if err != nil || claimed || copy.ID != run.ID {
		t.Fatalf("same instant dispatched twice: %+v %v", copy, err)
	}
	if _, claimed, err = s.ClaimWorkRun(ctx, w.ID, 1, "2026-10-17T02:00:00Z"); err == nil || claimed {
		t.Fatal("unconfirmed claim allowed an overlapping execution")
	}
	run.ExecutionSessionID, run.Status = "child", "running"
	if err = s.FinishWorkRun(ctx, run); err != nil {
		t.Fatal(err)
	}
	if err = s.FinishWorkRun(ctx, store.WorkRun{ID: run.ID, Status: "completed", EndedAt: "2026-10-17T02:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	if err = s.FinishWorkRun(ctx, run); err != nil {
		t.Fatal(err)
	}
	runs, err := s.ListWorkRuns(ctx, w.ID)
	if err != nil || len(runs) != 1 || runs[0].Status != "completed" || runs[0].ScheduledAt == "" || runs[0].ExecutionSessionID != "child" || runs[0].Generation != 1 {
		t.Fatalf("partial update erased run identity/outcome: %+v %v", runs, err)
	}
}

func TestWorkRecurringDefinitionSurvivesItsRunAndBulkStopStillTargetsIt(t *testing.T) {
	s, w := workFixture(t)
	ctx := context.Background()
	w.Spec.Recurring = true
	w.Observation = store.WorkObservation{Status: "completed", ConfirmedRevision: 1, EndedAt: "2026-10-17T01:00:00Z"}
	if err := s.writeWork(ctx, w); err != nil {
		t.Fatal(err)
	}
	op, err := s.ControlSessionWork(ctx, "thread", "session", store.WorkControlInput{Action: "stop_all", IdempotencyKey: "between-runs"})
	if err != nil || len(op.Items) != 1 {
		t.Fatalf("recurring definition skipped: %+v %v", op, err)
	}
	if _, claimed, err := s.ClaimWorkRun(ctx, w.ID, 1, "2026-10-17T02:00:00Z"); err == nil || claimed {
		t.Fatal("periodic run escaped stop")
	}
}

func TestWorkAcknowledgementAloneCannotConfirmRunningProcessStopped(t *testing.T) {
	item := store.SessionWork{ID: "p", Kind: "process", Source: "foundry", Revision: 2, Observation: store.WorkObservation{Status: "running", ConfirmedRevision: 2}}
	for _, action := range []string{"stop", "remove", "pause"} {
		op := store.WorkOperation{Action: action, Items: []store.WorkOperationItem{{ID: item.ID, Revision: 2}}}
		if workOperationState(op, []store.SessionWork{item}, nil) == "verified" {
			t.Fatalf("%s trusted ACK over actual running state", action)
		}
	}
}

func TestWorkSharedServiceReferencesNeverDuplicateOrImplicitlyStopExecution(t *testing.T) {
	ctx := context.Background()
	s, w := workFixture(t)
	w.Kind = "process"
	w.Source = "foundry"
	w.ID = "service"
	w.SourceID = "service-definition"
	w.Observation = store.WorkObservation{Status: "running", At: "2026-10-19T00:00:00Z", ConfirmedRevision: 1}
	saved, err := s.SaveSessionWork(ctx, w)
	if err != nil {
		t.Fatal(err)
	}
	link := store.WorkControlInput{ID: saved.ID, Action: "link", RelatedSessionID: "consumer", ExpectedRevision: saved.Revision, IdempotencyKey: "link-service"}
	op, err := s.ControlSessionWork(ctx, "thread", "session", link)
	if err != nil {
		t.Fatal(err)
	}
	if len(op.Items) != 1 {
		t.Fatalf("missing receipt %+v", op)
	}
	retry, err := s.ControlSessionWork(ctx, "thread", "session", link)
	if err != nil || retry.ID != op.ID {
		t.Fatalf("link retry %+v %v", retry, err)
	}
	linked, err := s.ListSessionWork(ctx, "consumer", "")
	if err != nil || len(linked.Items) != 1 {
		t.Fatalf("shared entry missing %+v %v", linked, err)
	}
	service := linked.Items[0]
	if service.ID != saved.ID || service.SessionID != saved.SessionID || service.Generation != saved.Generation || service.Revision != saved.Revision || len(service.RelatedSessionIDs) != 1 {
		t.Fatalf("link changed execution identity: %+v", service)
	}
	for _, scope := range []string{"thread", "consumer"} {
		bulk, err := s.ControlSessionWork(ctx, scope, scope, store.WorkControlInput{Action: "stop_all", IdempotencyKey: "bulk"})
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range bulk.Items {
			if item.ID == saved.ID {
				t.Fatal("conversation bulk action included shared service")
			}
		}
	}
	unlink := store.WorkControlInput{ID: saved.ID, Action: "unlink", RelatedSessionID: "consumer", ExpectedReferenceRevision: 1, ExpectedRevision: saved.Revision, IdempotencyKey: "unlink-service"}
	if _, err = s.ControlSessionWork(ctx, "consumer", "consumer", unlink); err != nil {
		t.Fatal(err)
	}
	linked, _ = s.ListSessionWork(ctx, "consumer", "")
	if len(linked.Items) != 0 {
		t.Fatal("unlinked reference remained visible")
	}
	owner, _ := s.ListSessionWork(ctx, "thread", "")
	for _, item := range owner.Items {
		if item.ID == saved.ID && (item.DesiredState != "enabled" || item.Generation != saved.Generation || item.Observation.Status != "running") {
			t.Fatalf("unlink stopped/restarted execution: %+v", item)
		}
	}
}

func TestNativeScheduleCannotBeClaimedByFoundryExecutor(t *testing.T) {
	s, w := workFixture(t)
	ctx := context.Background()
	w.ID = "native-schedule"
	w.Source = "claude"
	w.Management = "observed"
	w.Native = &store.NativeWorkInfo{Runtime: "claude", Version: "2.1.295"}
	w.AllowedActions = []string{}
	saved, err := s.SaveSessionWork(ctx, w)
	if err != nil {
		t.Fatal(err)
	}
	if _, claimed, err := s.ClaimWorkRun(ctx, saved.ID, saved.Generation, "2026-10-19T00:00:00Z"); err == nil || claimed {
		t.Fatalf("native definition was claimed by second executor: %v %v", claimed, err)
	}
}

func TestNewerNativeTerminalEventRepairsAcknowledgedRunningInventory(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	w := store.SessionWork{ID: "native-event", SessionID: "s", ThreadID: "s", Source: "codex", SourceID: "native-child", Kind: "agent", Native: &store.NativeWorkInfo{Runtime: "codex", Version: "0.163.0"}, DesiredState: "enabled", Observation: store.WorkObservation{Status: "running", At: "2026-10-19T00:00:00Z", ConfirmedRevision: 1}}
	saved, err := s.SaveSessionWork(ctx, w)
	if err != nil {
		t.Fatal(err)
	}
	w.Observation = store.WorkObservation{Status: "completed", At: "2026-10-19T00:01:00Z", EndedAt: "2026-10-19T00:01:00Z"}
	repaired, err := s.SaveSessionWork(ctx, w)
	if err != nil || repaired.Observation.Status != "completed" || repaired.Observation.ConfirmedRevision != saved.Revision {
		t.Fatalf("newer terminal evidence lost %+v %v", repaired, err)
	}
}
