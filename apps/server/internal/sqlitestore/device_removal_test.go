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

// TestSoftRemoveDevicePreservesHistoryAndRefusesWork proves the store gate
// directly, with no hub/websocket involvement: after removal the device and
// its history are still readable, the device projects as "removed", and every
// work-creation path returns ErrDeviceRemoved.
func TestSoftRemoveDevicePreservesHistoryAndRefusesWork(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerDeviceRemovalDaemon(t, db, "dev_removed", "ws_removed")

	issue := confirmedIssueOnDevice(t, db, "ws_removed")
	if _, err := db.ClaimNextIssue(ctx, "dev_removed", "ws_removed"); err != nil {
		t.Fatalf("claim before removal: %v", err)
	}
	run := store.Run{
		ID:           "run_removed",
		IssueID:      issue.ID,
		WorkspaceID:  "ws_removed",
		Status:       "running",
		Runtime:      "mock",
		StartedLabel: "just now",
	}
	if _, err := db.StartIssueRun(ctx, issue.ID, run); err != nil {
		t.Fatalf("start run: %v", err)
	}

	// Active run blocks removal; tasks are never stopped by the operation.
	if _, err := db.SoftRemoveDevice(ctx, "dev_removed"); !errors.Is(err, store.ErrDeviceBusy) {
		t.Fatalf("expected ErrDeviceBusy with running run, got %v", err)
	}
	if _, err := db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{
		RunID: run.ID,
		Artifact: store.AcceptanceArtifact{
			ID: "art_removed", IssueID: issue.ID, Kind: "text", Title: "a", Summary: "s",
		},
	}); err != nil {
		t.Fatalf("complete issue: %v", err)
	}

	device, err := db.SoftRemoveDevice(ctx, "dev_removed")
	if err != nil {
		t.Fatalf("soft remove: %v", err)
	}
	if device.Status != "removed" || device.LastSeenLabel != removedDeviceLabel {
		t.Fatalf("removed projection mismatch: %#v", device)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_removed"); err != nil {
		t.Fatalf("idempotent re-remove should succeed: %v", err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing device: expected ErrNotFound, got %v", err)
	}

	// History rows survive.
	devices, err := db.ListDevices(ctx)
	if err != nil {
		t.Fatalf("list devices: %v", err)
	}
	var listed store.DeviceProjection
	for _, candidate := range devices {
		if candidate.ID == "dev_removed" {
			listed = candidate
		}
	}
	if listed.ID == "" || listed.Status != "removed" {
		t.Fatalf("removed device should still list as removed, got %#v", devices)
	}
	if ws, err := db.GetWorkspace(ctx, "ws_removed"); err != nil || ws.ID != "ws_removed" {
		t.Fatalf("workspace history must survive: %#v err=%v", ws, err)
	}
	if issues, err := db.ListIssues(ctx, "ws_removed"); err != nil || len(issues) != 1 {
		t.Fatalf("issue history must survive, got %#v err=%v", issues, err)
	}
	if runs, err := db.ListRuns(ctx, "ws_removed"); err != nil || len(runs) != 1 {
		t.Fatalf("run history must survive, got %#v err=%v", runs, err)
	}

	// Registration and every dispatch/creation path is refused in the store.
	err = db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device: store.DeviceProjection{ID: "dev_removed", Label: "Ghost", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{
			ID: "ws_removed", Name: "Ghost", LocalPath: t.TempDir(), Baseline: "main", ContextSummary: "",
		},
	})
	if !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("re-register after removal: expected ErrDeviceRemoved, got %v", err)
	}
	if devices, err := db.ListDevices(ctx); err != nil {
		t.Fatalf("list devices: %v", err)
	} else {
		for _, candidate := range devices {
			if candidate.ID == "dev_removed" && candidate.Label == "Ghost" {
				t.Fatalf("rejected registration must not upsert the device back")
			}
		}
	}
	if _, err := db.ClaimNextIssue(ctx, "dev_removed", "ws_removed"); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("claim after removal: expected ErrDeviceRemoved, got %v", err)
	}
}

// TestSoftRemoveDeviceSessionsGate covers queued/running sessions and the
// session creation/start gates.
func TestSoftRemoveDeviceSessionsGate(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerAgentSessionTestDaemon(t, db, "ws_sess", "agent_sess")

	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_sess",
		AgentID:     "agent_sess",
		Provider:    "codex",
		Prompt:      "queued work",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_ws_sess"); !errors.Is(err, store.ErrDeviceBusy) {
		t.Fatalf("queued session should block removal, got %v", err)
	}
	if _, err := db.CancelAgentSession(ctx, session.ID, "canceled for test"); err != nil {
		t.Fatalf("cancel session: %v", err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_ws_sess"); err != nil {
		t.Fatalf("remove after session canceled: %v", err)
	}
	if _, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_sess",
		AgentID:     "agent_sess",
		Provider:    "codex",
		Prompt:      "after removal",
	}); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("session creation after removal must be refused")
	}
}

// TestSoftRemoveDeviceStartSessionGate: a session whose device was removed
// can never flip to running, even if it was queued before the devices became
// idle — the gate runs before terminal handling in StartAgentSession.
func TestSoftRemoveDeviceStartSessionGate(t *testing.T) {
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
	if _, err := db.CancelAgentSession(ctx, session.ID, "canceled for test"); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_ws_start"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if _, err := db.StartAgentSession(ctx, session.ID); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("starting a session on a removed device must be refused, got %v", err)
	}
}

// TestRemovedDeviceIssueCannotRequeue exercises the recover-claim / request
// changes paths that would otherwise re-dispatch to the device.
func TestRemovedDeviceIssueCannotRequeue(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registerDeviceRemovalDaemon(t, db, "dev_requeue", "ws_requeue")
	issue := confirmedIssueOnDevice(t, db, "ws_requeue")
	if _, err := db.ClaimNextIssue(ctx, "dev_requeue", "ws_requeue"); err != nil {
		t.Fatalf("claim: %v", err)
	}
	run := store.Run{
		ID: "run_requeue", IssueID: issue.ID, WorkspaceID: "ws_requeue",
		Status: "running", Runtime: "mock", StartedLabel: "just now",
	}
	if _, err := db.StartIssueRun(ctx, issue.ID, run); err != nil {
		t.Fatalf("start run: %v", err)
	}
	// Fail the run so the issue is blocked; the failed run is terminal, leaving
	// the issue eligible for "request changes" re-queue.
	if _, err := db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{
		RunID: run.ID, Error: "boom",
		Artifact: store.AcceptanceArtifact{
			ID: "art_requeue", IssueID: issue.ID, Kind: "text", Title: "a", Summary: "s",
		},
	}); err != nil {
		t.Fatalf("fail issue: %v", err)
	}
	if _, err := db.SoftRemoveDevice(ctx, "dev_requeue"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if _, err := db.UpdateIssueStatus(ctx, issue.ID, "pending"); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("recover-claim requeue must be refused, got %v", err)
	}
	if _, err := db.RequestIssueChanges(ctx, issue.ID, "please retry", ""); !errors.Is(err, store.ErrDeviceRemoved) {
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
		if _, err := db.ClaimNextIssue(ctx, "dev_race", "ws_race"); err == nil {
			run := store.Run{
				ID: "run_race", IssueID: issue.ID, WorkspaceID: "ws_race",
				Status: "running", Runtime: "mock", StartedLabel: "now",
			}
			if _, err := db.StartIssueRun(ctx, issue.ID, run); err == nil {
				_, _ = db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{
					RunID: run.ID,
					Artifact: store.AcceptanceArtifact{
						ID: "art_race", IssueID: issue.ID, Kind: "text", Title: "a", Summary: "s",
					},
				})
			}
		}
		for range 50 {
			if _, err := db.ClaimNextIssue(ctx, "dev_race", "ws_race"); err == nil {
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
			_, err := db.SoftRemoveDevice(ctx, "dev_race")
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
	if _, err := db.ClaimNextIssue(ctx, "dev_race", "ws_race"); !errors.Is(err, store.ErrDeviceRemoved) {
		t.Fatalf("post-race claim must be refused, got %v", err)
	}
}
