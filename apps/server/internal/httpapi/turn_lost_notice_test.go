package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// DEV-306: an assistant's own turn cut off by its computer going away is
// told once, and only when the computer, asked after it came back, says it no
// longer runs the turn and kept no result. A turn it still runs, or that
// finished while away, is not told.

const (
	turnLostComputer    = "Alice's computer"
	turnLostAnswerError = "The worker stopped while this message was running, so its result was lost. Send it again to continue."
)

// turnLostComputerConn is the assistant's computer (dev_alice) as a daemon
// connection: it claims the inputs it still runs, answers recover_session and
// records the notices sent to it.
type turnLostComputerConn struct {
	t       *testing.T
	conn    *websocket.Conn
	mu      sync.Mutex
	acks    map[string]bool
	asked   []wsRecoverSessionPayload
	prompts []string
}

func connectTurnLostComputer(t *testing.T, f assistantFixture, serverURL string, claimed []string) *turnLostComputerConn {
	t.Helper()
	headers := http.Header{}
	headers.Set(deviceCredentialHeader, f.aliceDevice)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(serverURL, "http")+"/api/daemon/ws", headers)
	if err != nil {
		t.Fatalf("dial daemon websocket: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	computer := &turnLostComputerConn{t: t, conn: conn, acks: map[string]bool{}}
	writeWSIDForTest(t, conn, "hello_1", "hello", map[string]any{
		"activeSessionIds": claimed,
		"device":           map[string]any{"id": "dev_alice", "label": turnLostComputer, "status": "connected", "lastSeenLabel": "online"},
		"workspace":        map[string]any{"id": "ws_pa", "name": "ws_pa", "localPath": t.TempDir(), "baseline": "main"},
		"providerHealth":   []map[string]any{},
		"assets":           []map[string]any{},
		"agents": []map[string]any{{
			"id": "agent_ws_pa", "workspaceId": "ws_pa", "deviceId": "dev_alice", "deviceLabel": turnLostComputer,
			"provider": "claude", "status": "healthy", "authMode": "local_config", "secretStored": "local",
			"configScope": "workspace", "configLabel": "device local login", "lastSeenLabel": "online",
		}},
	})
	registered := make(chan struct{})
	go func() {
		for {
			var envelope struct {
				ID      string          `json:"id"`
				Type    string          `json:"type"`
				Payload json.RawMessage `json:"payload"`
			}
			if err := conn.ReadJSON(&envelope); err != nil {
				return
			}
			computer.mu.Lock()
			switch envelope.Type {
			case wsRegisteredType:
				if envelope.ID == "hello_1" {
					close(registered)
				}
			case wsAckType:
				computer.acks[envelope.ID] = true
			case wsRecoverSessionType:
				var payload wsRecoverSessionPayload
				if json.Unmarshal(envelope.Payload, &payload) == nil {
					computer.asked = append(computer.asked, payload)
				}
			case wsRunSessionType:
				var payload wsRunSessionPayload
				if json.Unmarshal(envelope.Payload, &payload) == nil && payload.Session.Source != "naming" {
					computer.prompts = append(computer.prompts, payload.Session.Input.Prompt)
				}
			}
			computer.mu.Unlock()
		}
	}()
	select {
	case <-registered:
	case <-time.After(5 * time.Second):
		t.Fatal("computer never registered")
	}
	return computer
}

// askedAbout is what recover_session asked this connection about the session.
func (c *turnLostComputerConn) askedAbout(sessionID string) []wsRecoverSessionPayload {
	c.mu.Lock()
	defer c.mu.Unlock()
	var asked []wsRecoverSessionPayload
	for _, payload := range c.asked {
		if payload.SessionID == sessionID {
			asked = append(asked, payload)
		}
	}
	return asked
}

// interruptionNotices counts the notices that say a turn was interrupted,
// in either language.
func (c *turnLostComputerConn) interruptionNotices() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	count := 0
	for _, prompt := range c.prompts {
		if strings.Contains(prompt, "你的这一轮被中断了") || strings.Contains(prompt, "Your turn was interrupted") {
			count++
		}
	}
	return count
}

// answer sends the computer's answer to a question and waits for the ack.
func (c *turnLostComputerConn) answer(id string, payload map[string]any) {
	c.t.Helper()
	writeWSIDForTest(c.t, c.conn, id, wsSessionCompleteType, payload)
	waitForTest(c.t, "ack of "+id, func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.acks[id]
	})
}

// dropAndReturn is the assistant's computer going away with claimed inputs
// running, then connecting again and claiming back what it still runs.
func dropAndReturn(t *testing.T, f assistantFixture, serverURL string, claimedBefore, claimedAfter []string) *turnLostComputerConn {
	t.Helper()
	before := connectTurnLostComputer(t, f, serverURL, claimedBefore)
	before.conn.Close()
	return connectTurnLostComputer(t, f, serverURL, claimedAfter)
}

// runningConversation starts the assistant's own conversation (the fixture's
// session in its home workspace), as a running turn.
func runningConversation(t *testing.T, f assistantFixture) store.AgentSession {
	t.Helper()
	conversation, err := f.server.store.StartAgentSession(context.Background(), f.conversation.ID)
	if err != nil {
		t.Fatal(err)
	}
	return conversation
}

// requireSameInput checks that the session still has the input it had: a
// notice is an input of the conversation, so none means no notice. tell
// makes the input before it goes to the computer, and the wait covers the
// goroutine that sends it.
func requireSameInput(t *testing.T, f assistantFixture, sessionID, inputID string) {
	t.Helper()
	time.Sleep(300 * time.Millisecond)
	current, err := f.server.store.GetAgentSessionSummary(context.Background(), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if current.Input.ID != inputID {
		t.Fatalf("the conversation got a new input %s, want none after %s", current.Input.ID, inputID)
	}
}

// waitForNotice waits until the conversation has an input after the lost
// one, and the computer has been sent it: the launch of a run can take
// seconds, so this waits longer than the other checks. It returns the notice's
// input.
func waitForNotice(t *testing.T, f assistantFixture, back *turnLostComputerConn, sessionID, lostInputID string) string {
	t.Helper()
	var noticeInput string
	waitUntil(t, "the notice to become the conversation's input", 20*time.Second, func() bool {
		current, err := f.server.store.GetAgentSessionSummary(context.Background(), sessionID)
		if err != nil || current.Input.ID == lostInputID {
			return false
		}
		noticeInput = current.Input.ID
		return true
	})
	waitUntil(t, "the computer to be sent the notice", 20*time.Second, func() bool {
		return back.interruptionNotices() == 1
	})
	return noticeInput
}

// waitUntil is waitForTest with a longer patience.
func waitUntil(t *testing.T, what string, patience time.Duration, done func() bool) {
	t.Helper()
	for deadline := time.Now().Add(patience); !done(); {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// The computer still runs the turn when it comes back: nothing asks about it,
// nothing is told.
func TestOrphanedTurnTheComputerStillRunsIsNotTold(t *testing.T) {
	f := newAssistantFixture(t)
	conversation := runningConversation(t, f)
	live := serveForTest(t, f.server)
	back := dropAndReturn(t, f, live.URL, []string{conversation.ID}, []string{conversation.ID})
	time.Sleep(300 * time.Millisecond)
	if asked := back.askedAbout(conversation.ID); len(asked) != 0 {
		t.Fatalf("a turn the computer claims was asked about: %+v", asked)
	}
	requireSameInput(t, f, conversation.ID, conversation.Input.ID)
	if current, err := f.server.store.GetAgentSessionSummary(context.Background(), conversation.ID); err != nil || current.Status != "running" {
		t.Fatalf("the turn the computer still runs = %q, %v", current.Status, err)
	}
}

// The turn finished while the computer was away and recorded its result: the
// answer carries the result, and nothing is told.
func TestOrphanedTurnFinishedWhileAwayIsNotTold(t *testing.T) {
	f := newAssistantFixture(t)
	conversation := runningConversation(t, f)
	live := serveForTest(t, f.server)
	back := dropAndReturn(t, f, live.URL, []string{conversation.ID}, nil)
	waitForTest(t, "the turn to be asked about", func() bool {
		return len(back.askedAbout(conversation.ID)) == 1
	})
	back.answer("finished_1", map[string]any{"sessionId": conversation.ID, "inputId": conversation.Input.ID, "response": "done while away"})
	if current, err := f.server.store.GetAgentSessionSummary(context.Background(), conversation.ID); err != nil || current.Status != "completed" {
		t.Fatalf("the finished turn = %q, %v", current.Status, err)
	}
	requireSameInput(t, f, conversation.ID, conversation.Input.ID)
}

// The computer no longer runs the turn and kept no result: the turn is
// interrupted, the assistant is told once, and an answer sent again does not
// tell it again.
func TestOrphanedTurnLostIsToldOnce(t *testing.T) {
	f := newAssistantFixture(t)
	conversation := runningConversation(t, f)
	live := serveForTest(t, f.server)
	back := dropAndReturn(t, f, live.URL, []string{conversation.ID}, nil)
	waitForTest(t, "the turn to be asked about", func() bool {
		return len(back.askedAbout(conversation.ID)) == 1
	})
	answer := map[string]any{"sessionId": conversation.ID, "inputId": conversation.Input.ID, "error": turnLostAnswerError}
	back.answer("lost_1", answer)
	noticeInput := waitForNotice(t, f, back, conversation.ID, conversation.Input.ID)
	back.answer("lost_2", answer)
	requireSameInput(t, f, conversation.ID, noticeInput)
	if n := back.interruptionNotices(); n != 1 {
		t.Fatalf("the lost turn was told %d times, want once", n)
	}
}

// Stopped, the assistant is not told: the back notice is not sent to a
// stopped assistant either.
func TestOrphanedTurnLostWhileStoppedIsNotTold(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	conversation := runningConversation(t, f)
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	live := serveForTest(t, f.server)
	back := dropAndReturn(t, f, live.URL, []string{conversation.ID}, nil)
	waitForTest(t, "the turn to be asked about", func() bool {
		return len(back.askedAbout(conversation.ID)) == 1
	})
	if _, err := f.server.store.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	back.answer("lost_1", map[string]any{"sessionId": conversation.ID, "inputId": conversation.Input.ID, "error": turnLostAnswerError})
	requireSameInput(t, f, conversation.ID, conversation.Input.ID)
}

// A later input that started in the conversation before the notice goes out
// makes the notice no longer news: nothing is told.
func TestLostTurnIsNotToldWhenThePersonSentSomethingNew(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	conversation := runningConversation(t, f)
	live := serveForTest(t, f.server)
	connectTurnLostComputer(t, f, live.URL, nil)
	if _, _, err := f.server.store.SettleAgentSessionInput(ctx, conversation.ID, conversation.Input.ID, "", "", turnLostAnswerError); err != nil {
		t.Fatal(err)
	}
	later, err := f.server.sessionService.Send(ctx, conversation.ID, store.SendAgentSessionInput{Prompt: "a message after the loss"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if later.Input.ID == conversation.Input.ID {
		t.Fatalf("the person's message did not start a new input: %q", later.Input.ID)
	}
	f.server.assistant.TurnLost(ctx, later, turnLostFor(conversation, time.Now()))
	requireSameInput(t, f, conversation.ID, later.Input.ID)
}

// A turn in a session that is not the assistant's own conversation is not
// told, even on the computer the assistant works on.
func TestLostTurnOfANonAssistantSessionIsNotTold(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	project := f.startSession(t, "ws_alice", "", "a project chat")
	project, err := f.server.store.StartAgentSession(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	live := serveForTest(t, f.server)
	connectTurnLostComputer(t, f, live.URL, nil)
	f.server.assistant.TurnLost(ctx, project, turnLostFor(project, time.Now()))
	requireSameInput(t, f, project.ID, project.Input.ID)
}

// turnLostFor is the lost input of session as the reconnect would have asked
// about it: the computer back now and dropped a moment earlier.
func turnLostFor(session store.AgentSession, now time.Time) assistant.LostTurn {
	return assistant.LostTurn{DeviceID: "dev_alice", InputID: session.Input.ID, DroppedAt: now.Add(-time.Minute), BackAt: now}
}
