package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/browserevent"
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

func (o *sessionObserverForTest) sessionChanged(_ context.Context, change sessionChange, session store.AgentSession) {
	o.mu.Lock()
	defer o.mu.Unlock()
	record := fmt.Sprintf("%s %s %s", change.event().Name(), session.ID, session.Status)
	if o.held != nil {
		record += fmt.Sprintf(" after %d", o.held())
	}
	o.changes = append(o.changes, record)
	o.sessions = append(o.sessions, session)
}

func (o *sessionObserverForTest) sessionEventRecorded(_ context.Context, event store.AgentSessionEvent) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.events = append(o.events, event.ID)
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

// What follows a session's changes observes the sessions notifier, in a
// fixed order (Feishu's card, the chat's queue, the chat's title), each
// after the session's viewers were told; the session it gets carries no
// transcript. Its transcript's events are followed by Feishu's card and the
// chat's queue, and a device's report that it ended by naming.
func TestSessionObserversReactInOrderAfterViewers(t *testing.T) {
	server := NewServer(newTestStore(t))
	sessions := sessionEventsForTest(server)
	for _, observed := range []struct {
		what string
		got  []string
		want []string
	}{
		{"changes", typesForTest(sessions.changeObservers), []string{"httpapi.feishuReactions", "httpapi.chatQueueReactions", "*httpapi.chatTitleService"}},
		{"transcript events", typesForTest(sessions.eventObservers), []string{"httpapi.feishuReactions", "httpapi.chatQueueReactions"}},
		{"reported ends", typesForTest(sessions.endObservers), []string{"*httpapi.chatTitleService"}},
		{"issue updates", typesForTest(server.issues.(*issueEvents).observers), []string{"httpapi.feishuReactions"}},
	} {
		if !reflect.DeepEqual(observed.got, observed.want) {
			t.Fatalf("observers of %s = %v, want %v", observed.what, observed.got, observed.want)
		}
	}

	viewer := subscribeForTest(server.stream)
	observer := &sessionObserverForTest{held: func() int { return len(viewer.C) }}
	sessionEventsForTest(server).observe(observer)
	ctx := context.Background()
	session := sessionWithTranscriptForTest()
	session.Source = "verification"
	server.sessions.changed(ctx, sessionCompleted, session)
	server.sessions.recorded(ctx, session.WorkspaceID, store.AgentSessionEvent{ID: "evt_2", SessionID: session.ID})
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
	sessionEventsForTest(server).observe(observer)
	ctx := context.Background()
	input := store.CreateAgentSessionInput{WorkspaceID: "ws_lineage", AgentID: "agent_lineage", Provider: "claude", Prompt: "hello", Source: "chat"}

	started, status, err := server.startAgentSession(ctx, input)
	if status != http.StatusConflict || !errors.Is(err, ErrLocalDaemonNotConnected) {
		t.Fatalf("a person's session = %d %v, want the conflict", status, err)
	}
	fromFeishu, err := server.CreateSessionAndDispatch(ctx, input)
	if !errors.Is(err, ErrLocalDaemonNotConnected) {
		t.Fatalf("Feishu's session = %v, want the conflict", err)
	}
	want := []string{}
	for _, session := range []store.AgentSession{started, fromFeishu} {
		if session.ID == "" || session.Status != "failed" || session.Error != ErrLocalDaemonNotConnected.Error() {
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

func (r *toldAroundTheAckForTest) changed(_ context.Context, change sessionChange, _ store.AgentSession) {
	r.note(change.event().Name())
}

func (r *toldAroundTheAckForTest) recorded(context.Context, string, store.AgentSessionEvent) {}

func (r *toldAroundTheAckForTest) subagentChanged(string, store.AgentSessionEvent, subagentChange) {}

func (r *toldAroundTheAckForTest) backgroundTaskOutputChanged(store.AgentSession, string) {}

func (r *toldAroundTheAckForTest) endReported(_ context.Context, session store.AgentSession) {
	r.note("end reported " + session.Status)
}

func (r *toldAroundTheAckForTest) updated(store.Issue) { r.note("issue updated") }

func (r *toldAroundTheAckForTest) runEventRecorded(string, store.RunEvent) {}

func (r *toldAroundTheAckForTest) environmentChanged(string, string) {}

// A device's report that a session ended is told in this order: the
// session's end (its viewers, Feishu's card, the chat's queue, the job's
// title), the Issue it settles, the device's acknowledgement, and then what
// follows the end without holding the device up (naming). A report sent
// again settles nothing new and is followed the same way after its ack.
func TestReportedEndIsToldAroundTheAck(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registration := store.DaemonRegistration{Capabilities: []string{store.DaemonCapabilityIssueSessions},
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
	hub.startIssueExecution(ctx, session)
	told.told = nil
	report, _ := json.Marshal(wsSessionCompletedPayload{SessionID: session.ID, InputID: session.Input.ID, Response: "done",
		IssueResult: &store.CompleteIssueInput{RunID: session.ID, Response: "done", Checks: []string{"Done"},
			Artifact: store.AcceptanceArtifact{ID: "art_end", IssueID: issue.ID, Kind: "text", Title: "Report", Summary: "done"}}})

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
	live := httptest.NewServer(server.Routes())
	defer live.Close()
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
