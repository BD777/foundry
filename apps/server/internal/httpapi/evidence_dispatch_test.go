package httpapi

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type dispatchProbeStore struct {
	*sqlitestore.Store
	started chan string
	release chan struct{}
}

func (s *dispatchProbeStore) StartVerification(_ context.Context, issueID, _ string) (store.Verification, error) {
	s.started <- issueID
	<-s.release
	return store.Verification{}, fmt.Errorf("probe complete")
}

func TestSiblingVerificationsQueueBeforeWorkerDispatch(t *testing.T) {
	probe := &dispatchProbeStore{Store: newTestStore(t), started: make(chan string, 3), release: make(chan struct{})}
	defer close(probe.release)
	server := NewServer(probe)
	go server.dispatchVerification(store.Issue{ID: "one"}, store.IssueContract{}, store.Verification{ID: "a"})
	if got := <-probe.started; got != "one" {
		t.Fatal(got)
	}
	go server.dispatchVerification(store.Issue{ID: "one"}, store.IssueContract{}, store.Verification{ID: "b"})
	go server.dispatchVerification(store.Issue{ID: "two"}, store.IssueContract{}, store.Verification{ID: "c"})
	select {
	case got := <-probe.started:
		if got != "two" {
			t.Fatal("same Issue raced its active verification")
		}
	case <-time.After(time.Second):
		t.Fatal("different Issues should remain independently dispatchable")
	}
	select {
	case <-probe.started:
		t.Fatal("sibling started before active verification completed")
	case <-time.After(30 * time.Millisecond):
	}
	probe.release <- struct{}{}
	probe.release <- struct{}{}
	select {
	case got := <-probe.started:
		if got != "one" {
			t.Fatal(got)
		}
	case <-time.After(time.Second):
		t.Fatal("queued sibling did not resume")
	}
}

func TestPendingReviewDefersCandidateObservation(t *testing.T) {
	if !reviewHasPendingJudgment(store.ReviewSnapshot{BlockingReasons: []store.ReviewBlocker{{Code: "verification_pending"}}}) {
		t.Fatal("pending review should not contend with collector")
	}
	if reviewHasPendingJudgment(store.ReviewSnapshot{Eligible: true}) {
		t.Fatal("eligible review must recheck candidate")
	}
}
