package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func toolEvent(id, sessionID, command, output string) store.AgentSessionEvent {
	return store.AgentSessionEvent{
		ID: id, SessionID: sessionID, Label: "Ran command", Detail: command, Level: "error",
		Message: &store.TranscriptMessage{ID: "turn/" + id, Kind: "tool", Status: "failed", Text: command + "\n\n```\n" + output + "\n```"},
	}
}

// A tool's output is never scanned for something the person must do: the
// errors the old output rules matched make no item. Only the runtime's own
// permission_denied event, a structured fact, does.
func TestToolOutputMakesNoNeedsYouItem(t *testing.T) {
	for _, output := range []string{
		"sudo: a password is required",
		"Error: Foundry gateway: this profile lacks the im:message scope",
		`{"error": "token_expired", "missing": ["search:docs:read"]}`,
		"Error: EACCES: permission denied, open '/etc/foundry/secret.json'",
		"error: your authentication token is missing required scopes [read:packages]",
	} {
		if items := pendingItemsFromEvent(toolEvent("evt_tool", "sess", "run", output), true); len(items) != 0 {
			t.Errorf("tool output %q made items %+v", output, items)
		}
	}
	denied := store.AgentSessionEvent{ID: "evt_denied", SessionID: "sess", Label: store.ProcessLabelPermissionDenied, Detail: "Write to /etc/hosts was denied"}
	items := pendingItemsFromEvent(denied, true)
	if len(items) != 1 || items[0].Source != store.PendingSourceNeedsHands || items[0].Rule != "permission" || items[0].Title != "Write to /etc/hosts was denied" {
		t.Fatalf("permission_denied items = %+v", items)
	}
}

type pendingFixture struct {
	t       *testing.T
	server  *Server
	handler http.Handler
	cookie  string
	session store.AgentSession
}

func newPendingFixture(t *testing.T) *pendingFixture {
	t.Helper()
	server, handler := newAccountsTestServer(t)
	cookie := setupOwner(t, server, handler)
	ctx := context.Background()
	users, err := server.store.(interface {
		ListUsers(context.Context) ([]store.User, error)
	}).ListUsers(ctx)
	if err != nil || len(users) != 1 {
		t.Fatalf("users = %+v (%v)", users, err)
	}
	userID := users[0].ID
	backing := server.store
	if err := backing.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_pending", Label: "Pending Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_pending", Name: "Pending", LocalPath: "/home/person/project", Baseline: "main"},
		Agents: []store.AgentProjection{{
			ID: "agent_pending", WorkspaceID: "ws_pending", DeviceID: "dev_pending", DeviceLabel: "Pending Device",
			Provider: "codex", Status: "healthy", AuthMode: "local_config", SecretStored: "local",
			ConfigScope: "workspace", ConfigLabel: "device local login", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
	session, err := backing.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_pending", AgentID: "agent_pending", Provider: "codex", Prompt: "work", Source: "chat", CreatedByUserID: userID,
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	return &pendingFixture{t: t, server: server, handler: handler, cookie: cookie, session: session}
}

func (f *pendingFixture) list() pendingItemList {
	f.t.Helper()
	recorder := doAuthCall(f.t, f.handler, authCall{method: http.MethodGet, path: "/api/pending-items", cookie: f.cookie})
	expectStatus(f.t, recorder, http.StatusOK, "list pending items")
	var list pendingItemList
	if err := json.Unmarshal(recorder.Body.Bytes(), &list); err != nil {
		f.t.Fatal(err)
	}
	return list
}

func (f *pendingFixture) item(source string) pendingItemView {
	f.t.Helper()
	for _, item := range f.list().Items {
		if item.Source == source {
			return item
		}
	}
	f.t.Fatalf("no %s item in %+v", source, f.list().Items)
	return pendingItemView{}
}

func TestPendingItemsFollowWhatSessionsRecord(t *testing.T) {
	f := newPendingFixture(t)
	ctx := context.Background()
	reactions := pendingReactions{f.server}
	sessionID := f.session.ID

	question := store.AgentSessionEvent{
		ID: "evt_answer", SessionID: sessionID, Label: "Response stream", Level: "info", At: time.Now().UTC().Format(time.RFC3339Nano),
		Message: &store.TranscriptMessage{
			ID: "turn/call_1", Kind: "assistant", Delivery: "async",
			Text:      "I checked the nine rows.\n\nThree are already closed.",
			Questions: []store.AgentQuestion{{Title: "Keep the three closed rows blocked?", Options: []string{"Keep them blocked (Recommended)", "Run them too"}}},
		},
	}
	reactions.SessionEventRecorded(ctx, question)
	// The same answer reported again counts once.
	reactions.SessionEventRecorded(ctx, question)
	asked := f.item(store.PendingSourceQuestion)
	if asked.State != store.PendingOpen || asked.Occurrences != 1 || asked.Excerpt != "Keep the three closed rows blocked?" ||
		asked.Recommendation != "Keep them blocked (Recommended)" || len(asked.Options) != 2 || asked.MessageID != "turn/call_1" ||
		!strings.Contains(asked.Context, "Three are already closed.") || asked.SessionTitle == "" || asked.WorkspaceName != "Pending" {
		t.Fatalf("question item = %+v", asked)
	}

	reactions.SessionEventRecorded(ctx, store.AgentSessionEvent{ID: "evt_denied", SessionID: sessionID, Label: store.ProcessLabelPermissionDenied, Detail: "Write to /etc/hosts was denied"})
	hands := f.item(store.PendingSourceNeedsHands)
	if hands.Rule != "permission" || hands.Title != "Write to /etc/hosts was denied" {
		t.Fatalf("needs-hands item = %+v", hands)
	}
	list := f.list()
	if list.Open != 2 || list.BySession[sessionID] != 2 {
		t.Fatalf("counts = %d, %+v", list.Open, list.BySession)
	}

	// A turn that completes leaves unrelated waiting items alone.
	completed := f.session
	completed.Status = "completed"
	reactions.SessionChanged(ctx, sessions.Completed, completed)
	if got := f.item(store.PendingSourceQuestion).State; got != store.PendingOpen {
		t.Fatalf("question after a completed turn = %s", got)
	}

	// Another session's message answers nothing; the person's answers all.
	queued := f.session
	queued.Input = store.SessionInput{ID: "in_agent", SentBySessionID: "sess_other", At: time.Now().UTC().Format(time.RFC3339Nano)}
	reactions.SessionChanged(ctx, sessions.Queued, queued)
	if got := f.item(store.PendingSourceQuestion).State; got != store.PendingOpen {
		t.Fatalf("question after another session's message = %s", got)
	}
	queued.Input = store.SessionInput{ID: "in_person", At: time.Now().Add(time.Second).UTC().Format(time.RFC3339Nano)}
	reactions.SessionChanged(ctx, sessions.Queued, queued)
	if got := f.item(store.PendingSourceQuestion).State; got != store.PendingReplied {
		t.Fatalf("question after the person's message = %s", got)
	}
	if got := f.item(store.PendingSourceQuestion).Outcome; got != store.PendingOutcomePersonAnswered {
		t.Fatalf("person answer outcome = %s", got)
	}
	if got := f.item(store.PendingSourceNeedsHands).State; got != store.PendingReplied {
		t.Fatalf("needs-hands after the person's message = %s", got)
	}
	// The answer reported again later stays answered.
	reactions.SessionEventRecorded(ctx, question)
	if list := f.list(); list.Open != 0 {
		t.Fatalf("open after a replay = %d (%+v)", list.Open, list.Items)
	}

	// By hand: open again, then done; another person's id is not found.
	id := f.item(store.PendingSourceQuestion).ID
	for _, state := range []string{store.PendingOpen, store.PendingDone} {
		recorder := doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/pending-items/" + id + "/state",
			body: `{"state":"` + state + `"}`, cookie: f.cookie, origin: accountsTestOrigin})
		expectStatus(t, recorder, http.StatusOK, "set "+state)
	}
	if got := f.item(store.PendingSourceQuestion).State; got != store.PendingDone {
		t.Fatalf("question after done = %s", got)
	}
	if got := f.item(store.PendingSourceQuestion).Outcome; got != store.PendingOutcomePersonAnswered {
		t.Fatalf("person done outcome = %s", got)
	}
	dismissed := doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/pending-items/" + id + "/state",
		body: `{"state":"dismissed"}`, cookie: f.cookie, origin: accountsTestOrigin})
	expectStatus(t, dismissed, http.StatusOK, "not needed")
	if got := f.item(store.PendingSourceQuestion).Outcome; got != store.PendingOutcomePersonDismissedNotNeeded {
		t.Fatalf("not-needed outcome = %s", got)
	}
	missing := doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/pending-items/pnd_missing/state",
		body: `{"state":"done"}`, cookie: f.cookie, origin: accountsTestOrigin})
	expectStatus(t, missing, http.StatusNotFound, "unknown item")
	invalid := doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/pending-items/" + id + "/state",
		body: `{"state":"superseded"}`, cookie: f.cookie, origin: accountsTestOrigin})
	expectStatus(t, invalid, http.StatusBadRequest, "resolution by hand")
	anonymous := doAuthCall(t, f.handler, authCall{method: http.MethodGet, path: "/api/pending-items"})
	if anonymous.Code == http.StatusOK {
		t.Fatal("pending items listed without signing in")
	}
}

func TestPendingItemsIgnoreSessionsThePersonDidNotStart(t *testing.T) {
	f := newPendingFixture(t)
	ctx := context.Background()
	child, err := f.server.store.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: "ws_pending", AgentID: "agent_pending", Provider: "codex", Prompt: "sub", Source: "agent",
		CreatedByUserID: f.session.CreatedByUserID, ParentSessionID: f.session.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	pendingReactions{f.server}.SessionEventRecorded(ctx, store.AgentSessionEvent{ID: "evt_child_fail", SessionID: child.ID, Label: "Session failed", Level: "error", Detail: "boom"})
	if list := f.list(); len(list.Items) != 0 {
		t.Fatalf("an Agent-started session made items %+v", list.Items)
	}
}

func TestPendingItemsFollowAnIssueQuestion(t *testing.T) {
	f := newPendingFixture(t)
	reactions := pendingReactions{f.server}
	issue := store.Issue{ID: "iss_1", WorkspaceID: "ws_pending", Title: "Ship the export", Status: "blocked", CreatedByUserID: f.session.CreatedByUserID,
		Question: &store.IssueQuestion{ID: "question_1", Kind: "permission", Text: "May I deploy to staging?", Options: []string{"Yes", "No"}, RunID: f.session.ID}}
	reactions.IssueUpdated(issue)
	reactions.IssueUpdated(issue)
	asked := f.item(store.PendingSourceIssueQuestion)
	if asked.IssueID != "iss_1" || asked.Excerpt != "May I deploy to staging?" || asked.Rule != "permission" || asked.Occurrences != 1 {
		t.Fatalf("issue item = %+v", asked)
	}
	if list := f.list(); list.BySession[f.session.ID] != 0 {
		t.Fatalf("an Issue question counted in its run's chat: %+v", list.BySession)
	}
	issue.Question, issue.Status = nil, "in_progress"
	reactions.IssueUpdated(issue)
	if got := f.item(store.PendingSourceIssueQuestion).State; got != store.PendingSuperseded {
		t.Fatalf("issue item after the answer = %s", got)
	}
}

// A question in the person's own chat stays open after the runtime stops
// waiting for it (timed out, its turn ended): the person may answer it later,
// as the chat's next message. Their next message, a stopped turn, or the
// chat's archiving closes it.
func TestPersonChatQuestionsStayOpenUntilThePersonAnswers(t *testing.T) {
	f := newPendingFixture(t)
	ctx := context.Background()
	reactions := pendingReactions{f.server}
	sessionID := f.session.ID
	ask := func(id, messageID, delivery, title string) {
		reactions.SessionEventRecorded(ctx, store.AgentSessionEvent{
			ID: id, SessionID: sessionID, Label: "Response stream", Level: "info", At: time.Now().UTC().Format(time.RFC3339Nano),
			Message: &store.TranscriptMessage{ID: messageID, Kind: "assistant", Delivery: delivery, Text: title,
				Questions: []store.AgentQuestion{{Title: title, Options: []string{"Approve", "Deny"}, Approval: true}}},
		})
	}
	itemOf := func(title string) store.PendingItem {
		t.Helper()
		items, err := f.server.store.ListPendingItems(ctx, f.session.CreatedByUserID, []string{store.PendingOpen, store.PendingReplied, store.PendingSuperseded, store.PendingDone}, "", 100)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range items {
			if item.Title == title {
				return item
			}
		}
		t.Fatalf("no item %q", title)
		return store.PendingItem{}
	}
	ask("evt_plan", "in_1/approval_toolu_1", "", "Approve this plan?")
	ask("evt_cmd", "approval_cmd_1", "", "Allow this command?")

	// Its worker reports it settled unanswered (timed out): it still waits for
	// the person. The report is a receipt, not transcript.
	if !f.server.observeQuestionSettled(ctx, store.AgentSessionEvent{SessionID: sessionID, Label: store.EventLabelQuestionSettled, Detail: "approval_toolu_1"}) {
		t.Fatal("the settled report was not taken")
	}
	if f.server.observeQuestionSettled(ctx, store.AgentSessionEvent{SessionID: sessionID, Label: "Response stream"}) {
		t.Fatal("another event was taken as a settled report")
	}
	if got := itemOf("Approve this plan?"); got.State != store.PendingOpen || got.Rule != store.PendingRuleHeld {
		t.Fatalf("a timed-out question of the person's chat = %s rule %q, want open and held", got.State, got.Rule)
	}

	// The turn ended: both still wait, and the count says so.
	failed := f.session
	failed.Status = "failed"
	reactions.SessionChanged(ctx, sessions.Completed, failed)
	for _, title := range []string{"Approve this plan?", "Allow this command?"} {
		if got := itemOf(title).State; got != store.PendingOpen {
			t.Fatalf("%q after its turn ended = %s, want open", title, got)
		}
	}
	if list := f.list(); list.Open != 2 || list.BySession[sessionID] != 2 {
		t.Fatalf("counts after the turn = %d, %+v; want both", list.Open, list.BySession)
	}

	// The person's next message in the chat is their answer to both.
	queued := f.session
	queued.Input = store.SessionInput{ID: "in_later", Prompt: "Approve", At: time.Now().Add(time.Second).UTC().Format(time.RFC3339Nano)}
	reactions.SessionChanged(ctx, sessions.Queued, queued)
	if got := itemOf("Approve this plan?"); got.State != store.PendingReplied || got.Outcome != store.PendingOutcomePersonAnswered {
		t.Fatalf("after the person's later message = %s %s, want replied by the person", got.State, got.Outcome)
	}

	// A stopped turn ends what it asked.
	ask("evt_stop", "approval_stop", "", "Deploy now?")
	canceled := f.session
	canceled.Status = "canceled"
	reactions.SessionChanged(ctx, sessions.Completed, canceled)
	if got := itemOf("Deploy now?").State; got != store.PendingSuperseded {
		t.Fatalf("after the person stopped the turn = %s, want superseded", got)
	}

	// The chat archived: its open question waits for no one, and says why.
	ask("evt_archived", "approval_archived", "", "Ship the patch?")
	archiveSession(t, f.server, f.session)
	f.server.closeQuestionsOfGoneSessions(ctx)
	if got := itemOf("Ship the patch?"); got.State != store.PendingDone || got.ResolutionDetail != "session_archived" {
		t.Fatalf("question of an archived chat = %s %q, want done with session_archived", got.State, got.ResolutionDetail)
	}
}

// A queued channel turn answers the person's card only when it carries the
// person's own words (DEV-243): an echo of the assistant's own write, or
// another person's message, leaves it open; the person's message resolves it.
func TestQueuedChannelTurnNeedsThePersonsOwnWords(t *testing.T) {
	f := newPendingFixture(t)
	ctx := context.Background()
	reactions := pendingReactions{f.server}
	sessionID := f.session.ID
	reactions.SessionEventRecorded(ctx, store.AgentSessionEvent{
		ID: "evt_card", SessionID: sessionID, Label: "Response stream", Level: "info", At: time.Now().UTC().Format(time.RFC3339Nano),
		Message: &store.TranscriptMessage{
			ID: "turn/call_card", Kind: "assistant", Delivery: "async", Text: "Which account?",
			Questions: []store.AgentQuestion{{Title: "Use the work account?"}},
		},
	})
	open := func() bool {
		t.Helper()
		for _, item := range f.list().Items {
			if item.Source == store.PendingSourceQuestion {
				return item.State == store.PendingOpen
			}
		}
		t.Fatal("no question item")
		return false
	}
	queued := func(at string, messages ...store.MessageChannelOriginMessage) store.AgentSession {
		t.Helper()
		session := f.session
		session.Input = store.SessionInput{ID: "in_channel", At: at, ChannelOrigin: &store.MessageChannelOrigin{Messages: messages}}
		return session
	}
	at := time.Now().UTC()

	// The assistant's own reply echoed back: not the person's words.
	reactions.SessionChanged(ctx, sessions.Queued, queued(at.Format(time.RFC3339Nano),
		store.MessageChannelOriginMessage{ID: "om_echo", Sender: store.MessageEnvelopeSender{IsSelf: true, IsOwnWrite: true}}))
	if !open() {
		t.Fatal("an echo of the assistant's own write resolved the card")
	}
	// Another person's message: not the person's words.
	reactions.SessionChanged(ctx, sessions.Queued, queued(at.Add(time.Second).Format(time.RFC3339Nano),
		store.MessageChannelOriginMessage{ID: "om_other", Sender: store.MessageEnvelopeSender{ID: "ou_other", Name: "Someone else"}}))
	if !open() {
		t.Fatal("another person's message resolved the card")
	}
	// The person's own message, even beside an echo, resolves it.
	reactions.SessionChanged(ctx, sessions.Queued, queued(at.Add(2*time.Second).Format(time.RFC3339Nano),
		store.MessageChannelOriginMessage{ID: "om_echo2", Sender: store.MessageEnvelopeSender{IsSelf: true, IsOwnWrite: true}},
		store.MessageChannelOriginMessage{ID: "om_person", Sender: store.MessageEnvelopeSender{IsSelf: true}}))
	if open() {
		t.Fatal("the person's message did not resolve the card")
	}
}

// An approval keeps what it asks about on its item, so the list shows the
// command after the prompt is gone; an ordinary question keeps no detail.
func TestApprovalKeepsWhatItAsksAbout(t *testing.T) {
	event := store.AgentSessionEvent{ID: "evt_approval", SessionID: "sess_approval", Message: &store.TranscriptMessage{
		ID: "msg_approval",
		Questions: []store.AgentQuestion{
			{Title: "Allow this command?", Options: []string{"Approve", "Deny"}, Approval: true, Detail: "```sh\nrm -rf build\n```\nIn `/work`"},
			{Title: "Which file?", Options: []string{"a.txt"}, Detail: "not kept"},
		},
	}}
	items := pendingItemsFromEvent(event, false)
	if len(items) != 2 {
		t.Fatalf("items = %+v, want the approval and the question", items)
	}
	if !items[0].Approval || !strings.Contains(items[0].Detail, "rm -rf build") {
		t.Fatalf("approval item = %+v, want its command kept", items[0])
	}
	if items[1].Detail != "" {
		t.Fatalf("an ordinary question kept a detail: %q", items[1].Detail)
	}
}
