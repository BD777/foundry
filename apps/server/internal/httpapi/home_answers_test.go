package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A home answer is unseen until the person looks at the home conversation
// (DEV-278); helper turns, message channels and empty answers never mark it.
func TestHomeAnswerUnreadFollowsThePersonLastView(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)

	unread := func() (bool, string) {
		t.Helper()
		state, err := f.server.assistant.HomeUnread(ctx, agent)
		if err != nil {
			t.Fatal(err)
		}
		return state.Unread, state.LastAnswerAt
	}
	answer := func(response string, mutate func(*store.AgentSession)) store.AgentSession {
		t.Helper()
		session := f.conversation
		session.Status, session.Response = "completed", response
		session.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
		if mutate != nil {
			mutate(&session)
		}
		// A fresh answer time, so a second turn is newer than the first.
		time.Sleep(time.Millisecond)
		homeAnswerReactions{f.server}.SessionChanged(ctx, sessions.Completed, session)
		return session
	}

	if seen, _ := unread(); seen {
		t.Fatal("an assistant that never answered is unread")
	}
	answer("Here is what I found.", nil)
	if seen, at := unread(); !seen || at == "" {
		t.Fatalf("a home answer is not unread: seen=%v at=%q", seen, at)
	}
	if err := f.server.assistant.MarkHomeSeen(ctx, agent); err != nil {
		t.Fatal(err)
	}
	if seen, _ := unread(); seen {
		t.Fatal("the answer the person looked at stays unseen")
	}

	// A helper's own turn is not the home conversation.
	answer("A helper's report.", func(session *store.AgentSession) {
		session.ParentSessionID = f.helper.ID
	})
	if seen, _ := unread(); seen {
		t.Fatal("a helper's answer marked the home conversation unread")
	}
	// A turn that ended without an answer changes nothing.
	answer("", nil)
	if seen, _ := unread(); seen {
		t.Fatal("an empty answer marked the home conversation unread")
	}
}

// The marker has its own pair of routes, person-only, on the current
// assistant and on any of theirs.
func TestHomeUnreadRoutesMarkSeen(t *testing.T) {
	f := newNeedsYouFixture(t)
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	answer := f.conversation
	answer.Status, answer.Response = "completed", "Finished the export."
	answer.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	homeAnswerReactions{f.server}.SessionChanged(context.Background(), sessions.Completed, answer)

	call := func(method, path string) (int, store.AssistantHomeUnread) {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader("{}"))
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		f.server.testActor = &Actor{Kind: ActorAccount, Account: &store.User{ID: f.aliceID}}
		defer func() { f.server.testActor = nil }()
		f.server.Routes().ServeHTTP(recorder, request)
		var state store.AssistantHomeUnread
		if recorder.Code == http.StatusOK {
			if err := json.Unmarshal(recorder.Body.Bytes(), &state); err != nil {
				t.Fatalf("%s %s: %s", method, path, recorder.Body)
			}
		}
		return recorder.Code, state
	}

	code, state := call(http.MethodGet, "/api/personal-agent/home-unread")
	if code != http.StatusOK || !state.Unread {
		t.Fatalf("home-unread = %d %+v", code, state)
	}
	code, state = call(http.MethodPost, "/api/assistants/"+agent.ID+"/home-seen")
	if code != http.StatusOK || state.Unread {
		t.Fatalf("home-seen = %d %+v", code, state)
	}
	code, state = call(http.MethodGet, "/api/personal-agent/home-unread")
	if code != http.StatusOK || state.Unread {
		t.Fatalf("home-unread after seen = %d %+v", code, state)
	}
}
