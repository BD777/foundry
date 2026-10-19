package httpapi

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Advance after the handler reads but before it writes, without relying on
// scheduler timing. The transactional settlement must recheck input identity.
type completionSnapshotRaceStore struct {
	*sqlitestore.Store
	afterRead func()
}

func (s *completionSnapshotRaceStore) GetAgentSessionRecord(ctx context.Context, id string) (store.AgentSession, error) {
	result, err := s.Store.GetAgentSessionRecord(ctx, id)
	if err == nil && s.afterRead != nil {
		f := s.afterRead
		s.afterRead = nil
		f()
	}
	return result, err
}

func TestCompletionReplayCannotSettleInputStartedAfterItsSnapshot(t *testing.T) {
	for _, failure := range []string{"", "old input failed"} {
		t.Run("failure="+failure, func(t *testing.T) {
			db := newEmptyTestStore(t)
			ctx := context.Background()
			first := startedQueueSession(t, db)
			backing := &completionSnapshotRaceStore{Store: db}
			var next store.AgentSession
			backing.afterRead = func() {
				if _, err := db.CompleteAgentSession(ctx, first.ID, "original answer", ""); err != nil {
					t.Fatal(err)
				}
				var err error
				next, err = db.SendAgentSessionInput(ctx, first.ID, store.SendAgentSessionInput{Prompt: "new work"})
				if err != nil {
					t.Fatal(err)
				}
				if _, err = db.StartAgentSession(ctx, first.ID); err != nil {
					t.Fatal(err)
				}
			}
			server := NewServer(backing)
			c := newDaemonConnection(server.hub, nil)
			payload, _ := json.Marshal(wsSessionCompletedPayload{SessionID: first.ID, InputID: first.Input.ID, Response: "late old answer", Error: failure})
			if err := c.onSessionCompleted(ctx, wsEnvelope{ID: "replay", Type: wsSessionCompleteType, Payload: payload}); err != nil {
				t.Fatal(err)
			}
			got, err := db.GetAgentSessionRecord(ctx, first.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Input.ID != next.Input.ID || got.Status != "running" || got.Response != "" || got.Error != "" {
				t.Fatalf("late report overwrote new input: input=%s status=%s response=%q error=%q", got.Input.ID, got.Status, got.Response, got.Error)
			}
		})
	}
}
