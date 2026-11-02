package sqlitestore

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

func registerDeviceRemovalDaemon(t *testing.T, db *Store, deviceID string, workspaceID string) {
	t.Helper()
	if err := db.RegisterDaemon(context.Background(), store.DaemonRegistration{
		Device: store.DeviceProjection{
			ID:            deviceID,
			Label:         "Removal Device " + deviceID,
			Status:        "connected",
			LastSeenLabel: "online",
		},
		Workspace: store.WorkspaceProjection{
			ID:             workspaceID,
			Name:           "Removal Workspace",
			LocalPath:      t.TempDir(),
			Baseline:       "main",
			ContextSummary: "removal",
		},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
}

func confirmedIssueOnDevice(t *testing.T, db *Store, workspaceID string) store.Issue {
	t.Helper()
	issue, err := db.CreateIssue(context.Background(), store.CreateIssueInput{
		WorkspaceID: workspaceID,
		SourceInput: "device removal test issue",
		Runtime:     "mock",
	})
	if err != nil {
		t.Fatalf("create issue: %v", err)
	}
	testfixture.ConfirmContract(t, db, issue.ID)
	return issue
}

// An Issue's execution is one running turn of its device: its session.
func TestARunningExecutionIsOneTurn(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerDeviceWithAgent(t, db, "dev_turns", "ws_turns", "agent_turns")
	issue := confirmedIssueOnDevice(t, db, "ws_turns")
	_, session, err := db.ClaimIssueExecution(ctx, "dev_turns", "ws_turns")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartIssueRun(ctx, issue.ID, store.Run{ID: session.ID, Runtime: "mock"}); err != nil {
		t.Fatal(err)
	}
	var running *store.DeviceTurnsRunningError
	if _, err := db.RemoveDevice(ctx, store.RemoveDeviceInput{ID: "dev_turns", Connected: true}); !errors.As(err, &running) || running.Turns != 1 {
		t.Fatalf("removing the device counted %v", err)
	}
}

func removeDeviceForTest(t *testing.T, db *Store, deviceID string) {
	t.Helper()
	if _, err := db.RemoveDevice(context.Background(), store.RemoveDeviceInput{ID: deviceID}); err != nil {
		t.Fatalf("remove %s: %v", deviceID, err)
	}
}

// An offline device is removable whatever it left running: it will never
// report on it again. Once tombstoned it registers and takes work no more;
// once purged it is listed no more.
func TestRemovedDeviceRefusesRegistrationAndWork(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerDeviceRemovalDaemon(t, db, "dev_removed", "ws_removed")
	issue := confirmedIssueOnDevice(t, db, "ws_removed")
	if err := claimIssueForTest(ctx, db, "dev_removed", "ws_removed"); err != nil {
		t.Fatalf("claim before removal: %v", err)
	}
	if _, err := db.StartIssueRun(ctx, issue.ID, store.Run{ID: "run_removed", Status: "running", Runtime: "mock"}); err != nil {
		t.Fatalf("start run: %v", err)
	}

	device, err := db.RemoveDevice(ctx, store.RemoveDeviceInput{ID: "dev_removed"})
	if err != nil {
		t.Fatalf("remove an offline device with a running run: %v", err)
	}
	if device.Status != "removed" || device.LastSeenLabel != removedDeviceLabel {
		t.Fatalf("removed projection mismatch: %#v", device)
	}
	if _, err := db.RemoveDevice(ctx, store.RemoveDeviceInput{ID: "dev_removed"}); err != nil {
		t.Fatalf("removing again before the purge retries it: %v", err)
	}
	if _, err := db.RemoveDevice(ctx, store.RemoveDeviceInput{ID: "dev_missing"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing device: expected ErrNotFound, got %v", err)
	}
	err = db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_removed", Label: "Ghost", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_removed", Name: "Ghost", LocalPath: t.TempDir(), Baseline: "main"},
	})
	if !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("re-register after removal: expected ErrDeviceRemoved, got %v", err)
	}
	if err := claimIssueForTest(ctx, db, "dev_removed", "ws_removed"); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("claim after removal: expected ErrDeviceRemoved, got %v", err)
	}
	if _, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_removed", AgentID: "agent", Provider: "codex", Prompt: "after removal",
	}); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("session creation after removal: %v", err)
	}

	if _, err := db.PurgeRemovedDevice(ctx, "dev_removed"); err != nil {
		t.Fatal(err)
	}
	devices, err := db.ListDevices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, candidate := range devices {
		if candidate.ID == "dev_removed" {
			t.Fatalf("a purged device is still listed: %#v", candidate)
		}
	}
	if _, err := db.GetWorkspace(ctx, "ws_removed"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("the removed device's workspace is still there: %v", err)
	}
	if _, err := db.PurgeRemovedDevice(ctx, "dev_missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("purging a device that was not removed: %v", err)
	}
}

// A connected device with turns running is removed only once the person
// confirms the turns stop with it; without running turns it goes at once.
func TestRemovingConnectedDeviceAsksBeforeStoppingTurns(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_turns", "agent_turns")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_turns", AgentID: "agent_turns", Provider: "codex", Prompt: "running",
	})
	if err != nil {
		t.Fatal(err)
	}
	connected := store.RemoveDeviceInput{ID: "dev_ws_turns", Connected: true}
	if _, err := db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	_, err = db.RemoveDevice(ctx, connected)
	var running *store.DeviceTurnsRunningError
	if !errors.As(err, &running) || running.Turns != 1 || !errors.Is(err, store.ErrDeviceBusy) {
		t.Fatalf("connected device with a running turn: %v", err)
	}
	if removed, _ := db.DeviceRemoved(ctx, "dev_ws_turns"); removed {
		t.Fatal("a refused removal tombstoned the device")
	}
	confirmed := connected
	confirmed.StopRunningTurns = true
	if _, err := db.RemoveDevice(ctx, confirmed); err != nil {
		t.Fatalf("confirmed removal: %v", err)
	}

	registerAgentSessionTestDaemon(t, db, "ws_idle", "agent_idle")
	if _, err := db.RemoveDevice(ctx, store.RemoveDeviceInput{ID: "dev_ws_idle", Connected: true}); err != nil {
		t.Fatalf("connected device without running turns: %v", err)
	}
}

// What an offline device left unfinished never blocks its removal: enabled
// scheduled work without a confirmed stop, knowledge writes awaiting their
// receipt and live resource leases go with it.
func TestOfflineDeviceWithUnfinishedWorkIsRemovable(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerDeviceRemovalDaemon(t, db, "dev_stuck", "ws_stuck")
	registerDeviceRemovalDaemon(t, db, "dev_other", "ws_other")
	if err := db.ReplaceSourceResources(ctx, store.ResourceSourceStatus{Kind: "device", ID: "dev_other", Online: true},
		[]store.ResourceInstance{{ID: "res_other", Key: "gpu/0", Type: "gpu", Platform: "linux", Name: "GPU", State: store.ResourceAvailable}}); err != nil {
		t.Fatal(err)
	}
	execAll(t, db,
		`INSERT INTO session_work (id, thread_id, session_id, device_id, payload_json)
			VALUES ('work_stuck', 'thread_stuck', 'sess_stuck', 'dev_stuck',
			'{"id":"work_stuck","desiredState":"enabled","observation":{"status":"running","startedAt":"2026-10-01T00:00:00Z"}}')`,
		`INSERT INTO resource_leases (id, resource_id, source_id, generation, holder_session_id, holder_device_id, state, acquired_at)
			VALUES ('lease_stuck', 'res_other', 'dev_other', 1, 'sess_stuck', 'dev_stuck', 'active', '')`,
	)
	removeDeviceForTest(t, db, "dev_stuck")
	if _, err := db.PurgeRemovedDevice(ctx, "dev_stuck"); err != nil {
		t.Fatal(err)
	}
	for table, query := range map[string]string{
		"session work":   `SELECT count(*) FROM session_work WHERE device_id = 'dev_stuck'`,
		"its lease":      `SELECT count(*) FROM resource_leases WHERE id = 'lease_stuck'`,
		"work tombstone": `SELECT count(*) FROM session_work_removed WHERE device_id = 'dev_stuck'`,
	} {
		if got := countRows(t, db, query); got != 0 {
			t.Errorf("%s: %d rows left", table, got)
		}
	}
	if got := countRows(t, db, `SELECT count(*) FROM resource_instances WHERE id = 'res_other'`); got != 1 {
		t.Error("the other device's resource went with the lease")
	}
}

// A session whose device was removed can never flip to running, even if it
// was queued before: the gate runs before terminal handling in
// StartAgentSession.
func TestRemovedDeviceSessionCannotStart(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_start", "agent_start")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_start",
		AgentID:     "agent_start",
		Provider:    "codex",
		Prompt:      "queued",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	removeDeviceForTest(t, db, "dev_ws_start")
	if _, err := db.StartAgentSession(ctx, session.ID); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("starting a session on a removed device must be refused, got %v", err)
	}
}

// TestRemovedDeviceIssueCannotRequeue exercises the request-changes path
// that would otherwise re-dispatch to the device.
func TestRemovedDeviceIssueCannotRequeue(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerDeviceRemovalDaemon(t, db, "dev_requeue", "ws_requeue")
	issue := confirmedIssueOnDevice(t, db, "ws_requeue")
	if err := claimIssueForTest(ctx, db, "dev_requeue", "ws_requeue"); err != nil {
		t.Fatalf("claim: %v", err)
	}
	run := store.Run{ID: "run_requeue", Status: "running", Runtime: "mock"}
	if _, err := db.StartIssueRun(ctx, issue.ID, run); err != nil {
		t.Fatalf("start run: %v", err)
	}
	// Fail the run so the issue is blocked; the failed run is terminal, leaving
	// the issue eligible for "request changes" re-queue.
	if _, err := db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{
		RunID: run.ID, Error: "boom",
	}); err != nil {
		t.Fatalf("fail issue: %v", err)
	}
	removeDeviceForTest(t, db, "dev_requeue")
	if _, err := db.RequestIssueChanges(ctx, issue.ID, "please retry", "", ""); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("request-changes requeue must be refused, got %v", err)
	}
}

// TestRemovalVersusClaimRace hammers claim/register against removal on one
// serialized store. The single-writer serialization must always produce one
// of two consistent outcomes, and after the tombstone commits every later
// dispatch attempt must fail.
func TestRemovalVersusClaimRace(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerDeviceRemovalDaemon(t, db, "dev_race", "ws_race")
	issue := confirmedIssueOnDevice(t, db, "ws_race")

	var wg sync.WaitGroup
	var removalErr error
	var mu sync.Mutex
	claimsAfterRemoval := 0

	wg.Add(2)
	go func() {
		// Worker: claim → start → complete, then keep trying to re-register and
		// claim while the remover races it.
		defer wg.Done()
		if err := claimIssueForTest(ctx, db, "dev_race", "ws_race"); err == nil {
			run := store.Run{ID: "run_race", Status: "running", Runtime: "mock"}
			if _, err := db.StartIssueRun(ctx, issue.ID, run); err == nil {
				_, _ = db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{
					RunID: run.ID,
				})
			}
		}
		for range 50 {
			if err := claimIssueForTest(ctx, db, "dev_race", "ws_race"); err == nil {
				mu.Lock()
				claimsAfterRemoval++
				mu.Unlock()
			}
			_ = db.RegisterDaemon(ctx, store.DaemonRegistration{
				Device:    store.DeviceProjection{ID: "dev_race", Label: "race", Status: "connected", LastSeenLabel: "online"},
				Workspace: store.WorkspaceProjection{ID: "ws_race", Name: "x", LocalPath: t.TempDir(), Baseline: "main"},
			})
		}
	}()
	go func() {
		defer wg.Done()
		for range 50 {
			_, err := db.RemoveDevice(ctx, store.RemoveDeviceInput{ID: "dev_race"})
			if err == nil {
				mu.Lock()
				removalErr = nil
				mu.Unlock()
				return
			}
			mu.Lock()
			removalErr = err
			mu.Unlock()
		}
	}()
	wg.Wait()

	removed, err := db.isDeviceRemoved(ctx, "dev_race")
	if err != nil {
		t.Fatalf("tombstone lookup: %v", err)
	}
	if !removed {
		t.Fatalf("removal should eventually succeed once work is terminal, last err=%v", removalErr)
	}
	if claimsAfterRemoval != 0 {
		t.Fatalf("no claim may succeed after the tombstone commits, got %d", claimsAfterRemoval)
	}
	if err := claimIssueForTest(ctx, db, "dev_race", "ws_race"); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("post-race claim must be refused, got %v", err)
	}
}

// claimIssueForTest claims the next ready Issue for the device as dispatch
// does, without the execution session ClaimIssueExecution creates with it.
func claimIssueForTest(ctx context.Context, db *Store, deviceID, workspaceID string) error {
	return db.withTx(ctx, func(tx *Store) error {
		_, err := tx.claimNextIssue(ctx, deviceID, workspaceID)
		return err
	})
}
