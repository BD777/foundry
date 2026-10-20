package sqlitestore

import (
	"context"
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A canceled query must not leave an idle pooled connection pinned to its
// previous WAL snapshot. That made newly committed sessions and leases look
// missing, even though the writer and fresh connections could read them.
func TestCanceledReadsDoNotHideCommittedSessionsOrLeases(t *testing.T) {
	oldProcs := runtime.GOMAXPROCS(4)
	defer runtime.GOMAXPROCS(oldProcs)
	db := newTestStore(t)
	ctx := context.Background()
	db.read.SetMaxOpenConns(1)
	db.read.SetMaxIdleConns(1)
	registerAgentSessionTestDaemon(t, db, "ws_cancel_snapshot", "agent_cancel_snapshot")
	create := func() store.AgentSession {
		s, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_cancel_snapshot", AgentID: "agent_cancel_snapshot", Provider: "codex", Prompt: "synthetic snapshot regression"})
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	seed := create()
	columns := make([]string, 160)
	for i := range columns {
		columns[i] = fmt.Sprintf("payload_json AS v%d", i)
	}
	query := "SELECT " + strings.Join(columns, ",") + " FROM agent_sessions WHERE id=?"
	for i := 1; i <= 5000; i++ {
		timed, cancel := context.WithTimeout(ctx, time.Duration(20+i%160)*time.Microsecond)
		rows, err := db.reader().QueryContext(timed, query, seed.ID)
		if rows != nil {
			rows.Close()
		}
		wasCanceled := timed.Err() != nil
		cancel()
		if err != nil && !wasCanceled {
			t.Fatalf("unexpected uncanceled read error: %v", err)
		}
		if i%250 != 0 {
			continue
		}
		next := create()
		got, err := db.GetAgentSessionSummary(ctx, next.ID)
		if err != nil || got.ID != next.ID {
			t.Fatalf("after %d canceled reads, committed session disappeared from idle read pool: %v", i, err)
		}
		lease := store.ResourceLease{ID: fmt.Sprintf("lease_%d", i), ResourceID: fmt.Sprintf("resource_%d", i), SourceID: "device", Generation: 1, HolderSessionID: next.ID, State: store.LeaseActive}
		if err := db.SaveResourceLeaseChanges(ctx, store.ResourceLeaseChanges{Leases: []store.ResourceLease{lease}}); err != nil {
			t.Fatal(err)
		}
		leases, err := db.ListResourceLeases(ctx, store.ResourceLeaseFilter{ID: lease.ID})
		if err != nil || len(leases) != 1 || leases[0].HolderSessionID != next.ID {
			t.Fatalf("after %d canceled reads, committed lease disappeared: count=%d err=%v", i, len(leases), err)
		}
		if stats := db.read.Stats(); stats.InUse != 0 {
			t.Fatalf("reader was not returned: %+v", stats)
		}
	}
	var busy, frames, checkpointed int
	if err := db.conn().QueryRowContext(ctx, "PRAGMA wal_checkpoint(PASSIVE)").Scan(&busy, &frames, &checkpointed); err != nil {
		t.Fatal(err)
	}
	if busy != 0 || frames != checkpointed {
		t.Fatalf("idle readers still pin WAL: busy=%d frames=%d checkpointed=%d", busy, frames, checkpointed)
	}
}
