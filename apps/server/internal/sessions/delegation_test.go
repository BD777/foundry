package sessions

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type delegationStore struct {
	*sqlitestore.Store
	batches   [][]string
	synthetic map[string][]store.OutstandingChildTurn
}

func (s *delegationStore) OutstandingChildTurns(ctx context.Context, parentIDs []string) (map[string][]store.OutstandingChildTurn, error) {
	s.batches = append(s.batches, append([]string(nil), parentIDs...))
	if s.synthetic != nil {
		result := make(map[string][]store.OutstandingChildTurn)
		for _, parentID := range parentIDs {
			result[parentID] = s.synthetic[parentID]
		}
		return result, nil
	}
	return s.Store.OutstandingChildTurns(ctx, parentIDs)
}

type delegationFixture struct {
	t       *testing.T
	db      *sqlitestore.Store
	store   *delegationStore
	service *Service
}

func newDelegationFixture(t *testing.T) *delegationFixture {
	t.Helper()
	db, err := sqlitestore.Open(t.TempDir() + "/foundry.db")
	if err != nil {
		t.Fatalf("open sqlite store: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Fatalf("close sqlite store: %v", err)
		}
	})
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_waiting", Label: "Waiting", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: "ws_waiting", Name: "Waiting", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{{
			ID: "agent_waiting", WorkspaceID: "ws_waiting", DeviceID: "dev_waiting", Provider: "claude",
			Status: "healthy", AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace",
		}},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
	counting := &delegationStore{Store: db}
	return &delegationFixture{
		t: t, db: db, store: counting,
		service: New(counting, nil, Ports{}),
	}
}

func (f *delegationFixture) root(prompt string) store.AgentSession {
	f.t.Helper()
	session, err := f.db.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		WorkspaceID: "ws_waiting", AgentID: "agent_waiting", Provider: "claude",
		Prompt: prompt, Source: "chat",
	})
	if err != nil {
		f.t.Fatalf("create root session: %v", err)
	}
	return session
}

func (f *delegationFixture) child(parent store.AgentSession, prompt string) store.AgentSession {
	f.t.Helper()
	child, err := f.db.CreateAgentSession(context.Background(), store.CreateAgentSessionInput{
		WorkspaceID: "ws_waiting", AgentID: "agent_waiting", Provider: "claude",
		Prompt: prompt, Source: "agent", ParentSessionID: parent.ID,
	})
	if err != nil {
		f.t.Fatalf("create child session: %v", err)
	}
	return child
}

func (f *delegationFixture) start(session store.AgentSession) store.AgentSession {
	f.t.Helper()
	running, err := f.db.StartAgentSession(context.Background(), session.ID)
	if err != nil {
		f.t.Fatalf("start session %s: %v", session.ID, err)
	}
	return running
}

func (f *delegationFixture) finish(session store.AgentSession) store.AgentSession {
	f.t.Helper()
	current, err := f.db.GetAgentSessionSummary(context.Background(), session.ID)
	if err != nil {
		f.t.Fatalf("read session %s: %v", session.ID, err)
	}
	if current.Status == "queued" {
		current = f.start(current)
	}
	completed, err := f.db.CompleteAgentSession(context.Background(), current.ID, "done", "")
	if err != nil {
		f.t.Fatalf("complete session %s: %v", session.ID, err)
	}
	return completed
}

func (f *delegationFixture) counts(ids ...string) map[string]int {
	f.t.Helper()
	counts, err := f.service.WaitingChildCounts(context.Background(), ids)
	if err != nil {
		f.t.Fatalf("waiting child counts: %v", err)
	}
	return counts
}

func TestWaitingChildCountsRunningChildStartedByParent(t *testing.T) {
	f := newDelegationFixture(t)
	parent := f.root("parent")
	child := f.start(f.child(parent, "child"))

	if got := f.counts(parent.ID)[parent.ID]; got != 1 {
		t.Fatalf("parent waiting count = %d, want 1 for running child %s", got, child.ID)
	}
}

func TestWaitingChildCountsIgnoresPersonStartedTurn(t *testing.T) {
	f := newDelegationFixture(t)
	parent := f.root("parent")
	child := f.finish(f.child(parent, "child"))
	child, err := f.db.SendAgentSessionInput(context.Background(), child.ID, store.SendAgentSessionInput{Prompt: "from the person"})
	if err != nil {
		t.Fatal(err)
	}
	f.start(child)

	if got := f.counts(parent.ID)[parent.ID]; got != 0 {
		t.Fatalf("parent waiting count = %d, want 0 for a person-started child turn", got)
	}
}

func TestWaitingChildCountsIgnoresTimerTurn(t *testing.T) {
	f := newDelegationFixture(t)
	parent := f.root("parent")
	child := f.finish(f.child(parent, "child"))
	child, err := f.db.SendAgentSessionInput(context.Background(), child.ID, store.SendAgentSessionInput{
		Prompt: "timer", TimerFire: &store.AgentSessionTimerFire{ID: "timer_1", Origin: "scheduled", Prompt: "timer"},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.start(child)

	if got := f.counts(parent.ID)[parent.ID]; got != 0 {
		t.Fatalf("parent waiting count = %d, want 0 for a timer-started child turn", got)
	}
}

func TestWaitingChildCountsMergedInboxDelivery(t *testing.T) {
	f := newDelegationFixture(t)
	ctx := context.Background()
	parent := f.root("parent")
	other := f.root("other sender")
	child := f.finish(f.child(parent, "child"))
	child, err := f.db.SendAgentSessionInput(ctx, child.ID, store.SendAgentSessionInput{
		Prompt: "merged", InputID: "input_merged", SentBySessionID: other.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.start(child)
	item, err := f.db.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
		SessionID: child.ID, InputID: "input_parent_merged", SenderSessionID: parent.ID,
		Prompt: "also from parent", RequestedDelivery: store.DeliveryBoundary,
	}, store.SessionInboxRules{Now: time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	if _, changed, err := f.db.ChangeSessionInboxItem(ctx, child.ID, item.Item.InputID, store.SessionInboxChange{
		From: []string{store.InboxHeld}, State: store.InboxDelivered,
		DeliveredAs: "turn", DeliveredInputID: child.Input.ID,
	}); err != nil || !changed {
		t.Fatalf("mark merged inbox item delivered: changed=%v err=%v", changed, err)
	}

	if got := f.counts(parent.ID)[parent.ID]; got != 1 {
		t.Fatalf("parent waiting count = %d, want 1 for merged inbox delivery", got)
	}
}

func TestTurnInitiatorFallsBackToTheDeliveredInboxMessage(t *testing.T) {
	f := newDelegationFixture(t)
	ctx := context.Background()
	parent := f.root("parent")
	child := f.finish(f.child(parent, "child"))
	child, err := f.db.SendAgentSessionInput(ctx, child.ID, store.SendAgentSessionInput{
		Prompt: "turn with older attribution", InputID: "input_older_attribution",
	})
	if err != nil {
		t.Fatal(err)
	}
	item, err := f.db.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
		SessionID: child.ID, InputID: "input_from_parent", SenderSessionID: parent.ID,
		Prompt: "continue", RequestedDelivery: store.DeliveryTurnEnd,
	}, store.SessionInboxRules{Now: time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	if _, changed, err := f.db.ChangeSessionInboxItem(ctx, child.ID, item.Item.InputID, store.SessionInboxChange{
		From: []string{store.InboxHeld}, State: store.InboxDelivered,
		DeliveredAs: "turn", DeliveredInputID: child.Input.ID,
	}); err != nil || !changed {
		t.Fatalf("mark merged inbox item delivered: changed=%v err=%v", changed, err)
	}
	sender, err := f.service.TurnInitiator(ctx, child)
	if err != nil || sender != parent.ID {
		t.Fatalf("turn initiator = %q, %v; want %s", sender, err, parent.ID)
	}
}

func TestWaitingChildCountsTransitiveChild(t *testing.T) {
	f := newDelegationFixture(t)
	parent := f.root("parent")
	child := f.finish(f.child(parent, "ended child"))
	f.start(f.child(child, "running grandchild"))

	if got := f.counts(parent.ID)[parent.ID]; got != 1 {
		t.Fatalf("parent waiting count = %d, want 1 through an ended child", got)
	}
}

func TestWaitingChildCountsStopsPastFourLevels(t *testing.T) {
	f := newDelegationFixture(t)
	within := f.root("within four")
	over := f.root("over four")
	turn := func(parentID, childID, status string) store.OutstandingChildTurn {
		return store.OutstandingChildTurn{
			ParentSessionID: parentID, SessionID: childID, Status: status, StartedByParent: true,
		}
	}
	f.store.synthetic = map[string][]store.OutstandingChildTurn{
		within.ID: {
			turn(within.ID, "within_1", "completed"),
		},
		"within_1": {
			turn("within_1", "within_2", "completed"),
		},
		"within_2": {
			turn("within_2", "within_3", "completed"),
		},
		"within_3": {
			turn("within_3", "within_4", "running"),
		},
		over.ID: {
			turn(over.ID, "over_1", "completed"),
		},
		"over_1": {
			turn("over_1", "over_2", "completed"),
		},
		"over_2": {
			turn("over_2", "over_3", "completed"),
		},
		"over_3": {
			turn("over_3", "over_4", "completed"),
		},
		"over_4": {
			turn("over_4", "over_5", "running"),
		},
	}

	counts := f.counts(within.ID, over.ID)
	if counts[within.ID] != 1 {
		t.Fatalf("four-level waiting count = %d, want 1", counts[within.ID])
	}
	if counts[over.ID] != 0 {
		t.Fatalf("five-level waiting count = %d, want 0", counts[over.ID])
	}
}

func TestWaitingChildCountsCompletedChild(t *testing.T) {
	f := newDelegationFixture(t)
	parent := f.root("parent")
	f.finish(f.child(parent, "child"))

	if got := f.counts(parent.ID)[parent.ID]; got != 0 {
		t.Fatalf("parent waiting count = %d, want 0 for a completed child", got)
	}
}

func TestWaitingChildCountsBatchesParentsByLevel(t *testing.T) {
	f := newDelegationFixture(t)
	first := f.root("first")
	second := f.root("second")
	f.start(f.child(first, "first child"))
	f.start(f.child(second, "second child"))

	counts := f.counts(second.ID, first.ID)
	if counts[first.ID] != 1 || counts[second.ID] != 1 {
		t.Fatalf("waiting counts = %#v, want one child each", counts)
	}
	if len(f.store.batches) != 1 {
		t.Fatalf("store batches = %v, want one level-one batch", f.store.batches)
	}
	if got := f.store.batches[0]; !reflect.DeepEqual(got, []string{first.ID, second.ID}) {
		t.Fatalf("parent batch = %v, want both parents", got)
	}
}
