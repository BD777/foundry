package sqlitestore

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A session whose timers were reported before the server kept schedules
// gets the schedule of its newest snapshot, each timer first seen when a
// snapshot first listed it; one whose newest snapshot lists none
// (CronDelete) keeps none. Its device is sent the timers with their
// prompts, without expired, deleted or moved-on ones.
func TestSessionSchedulesAreBackfilledAndSentToTheirDevice(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_t", "agent_t")
	claudeSession := func(prompt string) store.AgentSession {
		t.Helper()
		session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_t", AgentID: "agent_t", Provider: "codex", Prompt: prompt})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.conn().ExecContext(ctx, `UPDATE agent_sessions SET provider = 'claude', payload_json = json_set(payload_json, '$.provider', 'claude') WHERE id = ?`, session.ID); err != nil {
			t.Fatal(err)
		}
		return session
	}
	snapshot := func(sessionID, id, at string, tasks ...store.AgentScheduledTask) {
		t.Helper()
		if tasks == nil {
			tasks = []store.AgentScheduledTask{}
		}
		if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
			ID: id, SessionID: sessionID, At: at, Label: "Scheduled tasks updated", Level: "info",
			Metadata: &store.AgentSessionEventMetadata{TimerSnapshot: &tasks},
		}); err != nil {
			t.Fatal(err)
		}
	}
	inspect := store.AgentScheduledTask{ID: "9b17c9d2", Kind: "cron", Schedule: "28,58 * * * *", Recurring: true, Prompt: "巡检"}
	remind := store.AgentScheduledTask{ID: "a1b2c3d4", Kind: "cron", Schedule: "30 9 12 10 *", Prompt: "提醒"}

	kept := claudeSession("inspect every 30 minutes")
	snapshot(kept.ID, "evt_k1", "2026-10-10T06:27:13Z", inspect)
	snapshot(kept.ID, "evt_k2", "2026-10-11T05:02:03Z", inspect, remind)
	if _, err := db.CompleteAgentSession(ctx, kept.ID, "scheduled", "native_kept"); err != nil {
		t.Fatal(err)
	}
	deleted := claudeSession("inspect, then stop")
	snapshot(deleted.ID, "evt_d1", "2026-10-10T07:00:00Z", inspect)
	snapshot(deleted.ID, "evt_d2", "2026-10-10T08:00:00Z")

	// As stored before the server kept schedules.
	if _, err := db.conn().ExecContext(ctx, `UPDATE agent_sessions SET payload_json = json_remove(payload_json, '$.scheduled')`); err != nil {
		t.Fatal(err)
	}
	if err := db.backfillSessionSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	restored, err := db.GetAgentSessionSummary(ctx, kept.ID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Scheduled == nil || restored.Scheduled.ReportedAt != "2026-10-11T05:02:03Z" || len(restored.Scheduled.Timers) != 2 ||
		restored.Scheduled.Timers[0].FirstSeenAt != "2026-10-10T06:27:13Z" || restored.Scheduled.Timers[1].FirstSeenAt != "2026-10-11T05:02:03Z" {
		t.Fatalf("backfilled schedule = %+v", restored.Scheduled)
	}
	if cleared, err := db.GetAgentSessionSummary(ctx, deleted.ID); err != nil || cleared.Scheduled != nil {
		t.Fatalf("after CronDelete the session holds %+v (%v)", cleared.Scheduled, err)
	}

	// A later snapshot keeps when each timer was first seen.
	snapshot(kept.ID, "evt_k3", "2026-10-11T06:00:00Z", inspect, remind)
	if later, _ := db.GetAgentSessionSummary(ctx, kept.ID); later.Scheduled == nil || later.Scheduled.Timers[0].FirstSeenAt != "2026-10-10T06:27:13Z" {
		t.Fatalf("schedule after another snapshot = %+v", later.Scheduled)
	}

	sent, err := db.DeviceSessionTimers(ctx, "dev_ws_t", time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 || sent[0].SessionID != kept.ID || sent[0].NativeSessionID != "native_kept" || len(sent[0].Timers) != 2 ||
		sent[0].Timers[0].Prompt != "巡检" || sent[0].Timers[0].FirstSeenAt != "2026-10-10T06:27:13Z" {
		t.Fatalf("device timers = %+v", sent)
	}
	if other, err := db.DeviceSessionTimers(ctx, "dev_other", time.Now()); err != nil || len(other) != 0 {
		t.Fatalf("another device's timers = %+v, %v", other, err)
	}
	// A week after it was first seen, Claude Code deleted the recurring one.
	expired, err := db.DeviceSessionTimers(ctx, "dev_ws_t", time.Date(2026, 10, 17, 6, 27, 13, 0, time.UTC))
	if err != nil || len(expired) != 1 || len(expired[0].Timers) != 1 || expired[0].Timers[0].ID != remind.ID {
		t.Fatalf("timers after the recurring one expired = %+v, %v", expired, err)
	}

	// A deleted chat's timers are not sent.
	if _, err := db.conn().ExecContext(ctx, `INSERT INTO chat_deletions (workspace_id, deletion_key) VALUES ('ws_t', ?)`, "id:"+kept.ID); err != nil {
		t.Fatal(err)
	}
	if gone, err := db.DeviceSessionTimers(ctx, "dev_ws_t", time.Now()); err != nil || len(gone) != 0 {
		t.Fatalf("a deleted chat's timers = %+v, %v", gone, err)
	}
	if _, err := db.conn().ExecContext(ctx, `DELETE FROM chat_deletions`); err != nil {
		t.Fatal(err)
	}

	// Another native session holds none of the old one's timers.
	moved, err := db.SetAgentSessionNativeSessionID(ctx, kept.ID, "native_new")
	if err != nil {
		t.Fatal(err)
	}
	if moved.Scheduled != nil {
		t.Fatalf("a new native session kept the old one's timers: %+v", moved.Scheduled)
	}
	if after, err := db.DeviceSessionTimers(ctx, "dev_ws_t", time.Now()); err != nil || len(after) != 0 {
		t.Fatalf("timers after the native session changed = %+v, %v", after, err)
	}
}
