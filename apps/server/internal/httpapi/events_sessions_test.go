package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
	"github.com/foundry-dev/foundry/apps/server/internal/issues"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

// sessionObserverForTest records what a session observer is told.
type sessionObserverForTest struct {
	mu sync.Mutex
	// held, when set, is how many frames a viewer holds: the record says
	// how many it held when the observer was told.
	held     func() int
	changes  []string
	sessions []store.AgentSession
	events   []string
}

func (o *sessionObserverForTest) SessionChanged(_ context.Context, change sessions.Change, session store.AgentSession) {
	o.mu.Lock()
	defer o.mu.Unlock()
	record := fmt.Sprintf("%s %s %s", change.Event().Name(), session.ID, session.Status)
	if o.held != nil {
		record += fmt.Sprintf(" after %d", o.held())
	}
	o.changes = append(o.changes, record)
	o.sessions = append(o.sessions, session)
}

func (o *sessionObserverForTest) SessionEventRecorded(_ context.Context, event store.AgentSessionEvent) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.events = append(o.events, event.ID)
}

// observing registers the observer for changes and transcript events.
func (o *sessionObserverForTest) observing() sessions.Observers {
	return sessions.Observers{Changes: []sessions.ChangeObserver{o}, Events: []sessions.EventObserver{o}}
}

// told is what the observer was told of changes starting with prefix.
func (o *sessionObserverForTest) told(prefix string) []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	found := []string{}
	for _, change := range o.changes {
		if strings.HasPrefix(change, prefix) {
			found = append(found, change)
		}
	}
	return found
}

// typesForTest names each observer's type, in order.
func typesForTest[O any](observers []O) []string {
	names := []string{}
	for _, observer := range observers {
		names = append(names, reflect.TypeOf(observer).String())
	}
	return names
}

// Everything that reacts to sessions observes the sessions notifier, as
// server.go registers it, in a fixed order, each after the session's viewers
// were told; the session it gets carries no transcript. Changes are followed
// by a scheduled run's outcome, Feishu's card, the chat's queue, the chat's
// title, leases, the assistant's tasks, inbox results and run controls, the
// session's inbox, its report to its parent, pending items, digests and,
// last, an Issue's run starting. Its transcript's events are followed by
// Feishu's card, the chat's queue, its inbox and pending items, and a
// device's report that it ended by naming.
func TestSessionObserversReactInOrderAfterViewers(t *testing.T) {
	server := NewServer(newTestStore(t))
	events := sessionEventsForTest(server)
	for _, observed := range []struct {
		what string
		got  []string
		want []string
	}{
		{"changes", typesForTest(events.Observing().Changes), []string{"httpapi.workRunReactions", "httpapi.feishuReactions", "httpapi.chatQueueReactions", "*httpapi.chatTitleService", "httpapi.resourceLeaseReactions", "assistant.taskReactions", "assistant.inboxReactions", "assistant.runControlReactions", "sessions.inboxReactions", "httpapi.childReportReactions", "httpapi.pendingReactions", "httpapi.workspaceDigestReactions", "issues.executionStarts"}},
		{"transcript events", typesForTest(events.Observing().Events), []string{"httpapi.feishuReactions", "httpapi.chatQueueReactions", "sessions.inboxReactions", "httpapi.pendingReactions", "httpapi.childQuestionReactions"}},
		{"reported ends", typesForTest(events.Observing().Ends), []string{"*httpapi.chatTitleService"}},
		{"issue updates", typesForTest(server.issues.Observing()), []string{"httpapi.feishuReactions", "httpapi.pendingReactions", "httpapi.workspaceDigestReactions"}},
	} {
		if !reflect.DeepEqual(observed.got, observed.want) {
			t.Fatalf("observers of %s = %v, want %v", observed.what, observed.got, observed.want)
		}
	}

	viewer := subscribeForTest(server.stream)
	observer := &sessionObserverForTest{held: func() int { return len(viewer.C) }}
	sessionEventsForTest(server).Observe(observer.observing())
	ctx := context.Background()
	session := sessionWithTranscriptForTest()
	session.Source = "verification"
	server.sessions.Changed(ctx, sessions.Completed, session)
	server.sessions.Recorded(ctx, session.WorkspaceID, store.AgentSessionEvent{ID: "evt_2", SessionID: session.ID})
	if want := []string{"agent_session_completed sess_big completed after 1"}; !reflect.DeepEqual(observer.changes, want) {
		t.Fatalf("observer was told %v, want %v", observer.changes, want)
	}
	if !reflect.DeepEqual(observer.events, []string{"evt_2"}) {
		t.Fatalf("observer was told events %v", observer.events)
	}
}

// Every new session a device does not take ends the same way, whoever
// started it: failed as not taken, told to its viewers and to what reacts
// to ended sessions (Feishu's card, the chat's queue, naming).
func TestUndeliveredSessionsEndTheSameWayOnEveryPath(t *testing.T) {
	db, _ := lineageFixture(t)
	server := NewServer(db)
	// Connected, but nothing reads what the server sends it.
	stalled := newDaemonConnection(server.hub, nil)
	stalled.send = make(chan wsEnvelope)
	server.hub.connections["dev_lineage"] = stalled
	observer := &sessionObserverForTest{}
	sessionEventsForTest(server).Observe(observer.observing())
	ctx := context.Background()
	input := store.CreateAgentSessionInput{WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude", Prompt: "hello", Source: "chat"}

	started, err := server.sessionService.Start(ctx, input)
	if errorStatus(err) != http.StatusConflict || !errors.Is(err, sessions.ErrLocalDaemonNotConnected) {
		t.Fatalf("a person's session = %v, want the conflict", err)
	}
	fromFeishu, err := server.CreateSessionAndDispatch(ctx, input)
	if !errors.Is(err, sessions.ErrLocalDaemonNotConnected) {
		t.Fatalf("Feishu's session = %v, want the conflict", err)
	}
	want := []string{}
	for _, session := range []store.AgentSession{started, fromFeishu} {
		if session.ID == "" || session.Status != "failed" || session.Error != sessions.ErrLocalDaemonNotConnected.Error() {
			t.Fatalf("undelivered session = %+v, want it failed as not taken", session)
		}
		want = append(want, "agent_session_completed "+session.ID+" failed")
	}
	if told := observer.told("agent_session_completed"); !reflect.DeepEqual(told, want) {
		t.Fatalf("observers were told %v, want %v", told, want)
	}
}

// toldAroundTheAckForTest records what a device hub tells of sessions and
// Issues, each with how many replies its connection had queued by then.
type toldAroundTheAckForTest struct {
	connection *daemonConnection
	told       []string
}

func (r *toldAroundTheAckForTest) note(what string) {
	r.connection.replyMu.Lock()
	queued := len(r.connection.replies)
	r.connection.replyMu.Unlock()
	r.told = append(r.told, fmt.Sprintf("%s@%d", what, queued))
}

func (r *toldAroundTheAckForTest) Changed(_ context.Context, change sessions.Change, _ store.AgentSession) {
	r.note(change.Event().Name())
}

func (r *toldAroundTheAckForTest) Recorded(context.Context, string, store.AgentSessionEvent) {}

func (r *toldAroundTheAckForTest) SubagentChanged(string, store.AgentSessionEvent, sessions.SubagentChange) {
}

func (r *toldAroundTheAckForTest) BackgroundTaskOutputChanged(store.AgentSession, string) {}

func (r *toldAroundTheAckForTest) EndReported(_ context.Context, session store.AgentSession) {
	r.note("end reported " + session.Status)
}

func (r *toldAroundTheAckForTest) Created(store.Issue) {}

func (r *toldAroundTheAckForTest) Updated(store.Issue) { r.note("issue updated") }

func (r *toldAroundTheAckForTest) EvidenceChanged(store.Issue, string, int, string) {}

func (r *toldAroundTheAckForTest) EnvironmentChanged(string, string) {}

// The Issue's devices as the hub's test sees them: none to claim on.
func (r *toldAroundTheAckForTest) Connected(string) bool { return false }
func (r *toldAroundTheAckForTest) Git(context.Context, string, bool) (bool, error) {
	return false, nil
}
func (r *toldAroundTheAckForTest) CheckRetry(context.Context, store.Issue) error { return nil }
func (r *toldAroundTheAckForTest) Dispatch(store.AgentSession) error             { return nil }
func (r *toldAroundTheAckForTest) ClaimReady()                                   {}

// A device's report that a session ended is told in this order: the
// session's end (its viewers, Feishu's card, the chat's queue, the job's
// title), the Issue it settles, the device's acknowledgement, and then what
// follows the end without holding the device up (naming). A report sent
// again settles nothing new and is followed the same way after its ack.
func TestReportedEndIsToldAroundTheAck(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registration := store.DaemonRegistration{Capabilities: []string{},
		Device: store.DeviceProjection{ID: "dev_end"}, Workspace: store.WorkspaceProjection{ID: "ws_end"}}
	if err := db.RegisterDaemon(ctx, registration); err != nil {
		t.Fatal(err)
	}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_end", Title: "ends", Runtime: "mock"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, db, issue.ID)
	_, session, err := db.ClaimIssueExecution(ctx, "dev_end", "ws_end")
	if err != nil {
		t.Fatal(err)
	}
	if session, err = db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	told := &toldAroundTheAckForTest{}
	others := newNotifiersForTest(db)
	hub := NewDaemonHub(db, daemonNotifiers{sessions: told, issues: told, devices: others.devices, chats: others.chatList, dataChanges: others.data}, "")
	told.connection = newDaemonConnection(hub, nil)
	told.connection.deviceID, told.connection.registration = "dev_end", registration
	service := issues.New(db, told, told)
	hub.settleIssueSession = service.Settle
	service.Observer().SessionChanged(ctx, sessions.Started, session)
	told.told = nil
	report, _ := json.Marshal(wsSessionCompletedPayload{SessionID: session.ID, InputID: session.Input.ID, Response: "done",
		IssueResult: &store.CompleteIssueInput{RunID: session.ID, Response: "done", Checks: []string{"Done"}}})

	for _, envelopeID := range []string{"end", "end_again"} {
		if err := told.connection.handleEnvelope(ctx, wsEnvelope{ID: envelopeID, Type: wsSessionCompleteType, Payload: report}); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{"agent_session_completed@0", "issue updated@0", "end reported completed@1"}
	if len(told.told) < len(want)+1 || !reflect.DeepEqual(told.told[:len(want)], want) {
		t.Fatalf("told %v, want %v first", told.told, want)
	}
	again := told.told[len(want):]
	if again[len(again)-1] != "end reported completed@2" || slices.Contains(again, "agent_session_completed@1") {
		t.Fatalf("told for the report sent again %v, want its end reported after its ack and nothing changed", again)
	}
}

// threadGateStore holds every read of a chat's thread until released;
// entered says one waits.
type threadGateStore struct {
	*sqlitestore.Store
	entered chan struct{}
	release chan struct{}
}

func (s *threadGateStore) ListAgentSessionThread(ctx context.Context, workspaceID string, id string) ([]store.AgentSession, error) {
	select {
	case s.entered <- struct{}{}:
	default:
	}
	<-s.release
	return s.Store.ListAgentSessionThread(ctx, workspaceID, id)
}

// Naming a chat's first answer reads its whole thread and starts a job on a
// device: it runs on its own once the device was answered, so neither the
// answer's acknowledgement nor the device's next message waits for it.
func TestNamingAnAnswerDoesNotHoldTheDeviceUp(t *testing.T) {
	backing := &threadGateStore{Store: newEmptyTestStore(t), entered: make(chan struct{}, 1), release: make(chan struct{})}
	session := startedQueueSession(t, backing.Store)
	server := NewServer(backing)
	viewer := subscribeForTest(server.stream)
	live := serveForTest(t, server)
	daemon := connectBacklogDaemon(t, live.URL, []string{session.ID})

	daemon.send("answered", wsSessionCompleteType, map[string]any{"sessionId": session.ID, "inputId": session.Input.ID, "response": "Done."})
	select {
	case <-backing.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the chat's answer was not named")
	}
	daemon.send("heartbeat_after", wsHeartbeatType, map[string]any{})
	close(backing.release)
	for {
		created := payloadForTest[store.AgentSession](t, nextStreamedForTest(t, viewer, browserevent.AgentSessionCreated))
		if created.Source == "naming" {
			break
		}
	}
}
