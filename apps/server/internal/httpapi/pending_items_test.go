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

func TestNeedsHandsMatchesOnlyNarrowToolErrors(t *testing.T) {
	workspace := "/home/person/project"
	cases := []struct {
		name, output, want string
	}{
		{"sudo password", "sudo: a password is required", "sudo"},
		{"sudo terminal", "sudo: a terminal is required to read the password; either use the -S option", "sudo"},
		{"gateway refusal", "Error: Foundry gateway: this profile lacks the im:message scope", "gateway"},
		{"docker socket", "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock", "docker"},
		{"expired token", `{"error": "token_expired", "missing": ["search:docs:read"]}`, "login"},
		{"expired refresh", `"error_description": "The refresh token has expired."`, "login"},
		{"remote 403", "urllib.error.HTTPError: HTTP Error 403: Forbidden", "http_auth"},
		{"local 401", "curl -i http://127.0.0.1:8080/health\nHTTP/1.1 401 Unauthorized", ""},
		{"outside EACCES", "Error: EACCES: permission denied, open '/etc/foundry/secret.json'", "permission"},
		{"inside EACCES", "Error: EACCES: permission denied, open '/home/person/project/out/a.txt'", ""},
		{"python outside", "PermissionError: [Errno 13] Permission denied: '/data/docker/volumes/x/_data/a.json'", "permission"},
		{"relative path", "PermissionError: [Errno 13] Permission denied: 'logs/a.txt'", ""},
		{"coreutils outside", "cat: /data/docker/volumes/x/_data/a.json: Permission denied", "permission"},
		{"coreutils cannot open", "ls: cannot open directory '/root': Permission denied", "permission"},
		{"coreutils inside", "cat: /home/person/project/a.txt: Permission denied", ""},
		{"session gh guard", "gh auth refresh is not available in a Foundry session: the device's GitHub login is changed by the person in Foundry.", "github_scope"},
		{"gh missing scope", "error: your authentication token is missing required scopes [read:packages]", "github_scope"},
		{"git workflow scope", " ! [remote rejected] main -> main (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)", "github_scope"},
		{"failing test", "AssertionError: expected 2, got 3", ""},
		{"404", "HTTP/1.1 404 Not Found", ""},
	}
	for _, c := range cases {
		rule, line, excerpt := needsHands(c.output, workspace)
		if rule != c.want {
			t.Errorf("%s: rule = %q, want %q", c.name, rule, c.want)
		}
		if rule != "" && (excerpt == "" || !strings.Contains(c.output, line)) {
			t.Errorf("%s: line %q, excerpt %q", c.name, line, excerpt)
		}
	}
	// A command that only mentions an error matches nothing: only the output is read.
	event := toolEvent("evt_cmd", "sess", "grep -rn 'sudo: a password is required' src", "src/a.go:1: no match")
	if items := pendingItemsFromEvent(event, workspace); len(items) != 0 {
		t.Fatalf("a command mentioning an error made items %+v", items)
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

	reactions.SessionEventRecorded(ctx, toolEvent("evt_sudo", sessionID, "sudo apt install jq", "sudo: a password is required"))
	hands := f.item(store.PendingSourceNeedsHands)
	if hands.Rule != "sudo" || hands.Context != "sudo apt install jq" || hands.Title != "sudo: a password is required" {
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

func TestPendingQuestionsCloseOnceTheyStopWaiting(t *testing.T) {
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
	state := func(title string) string {
		t.Helper()
		for _, item := range f.list().Items {
			if item.Title == title {
				return item.State
			}
		}
		t.Fatalf("no item %q", title)
		return ""
	}
	outcome := func(title string) string {
		t.Helper()
		for _, item := range f.list().Items {
			if item.Title == title {
				return item.Outcome
			}
		}
		t.Fatalf("no item %q", title)
		return ""
	}
	ask("evt_plan", "in_1/approval_toolu_1", "", "Approve this plan?")
	ask("evt_cmd", "approval_cmd_1", "", "Allow this command?")
	ask("evt_async", "call_async", "async", "Keep the rows?")

	// Its worker reports it settled unanswered (timed out, declined): only
	// that one closes; the report is a receipt, not transcript.
	settled := store.AgentSessionEvent{SessionID: sessionID, Label: store.EventLabelQuestionSettled, Detail: "approval_toolu_1"}
	if !f.server.observeQuestionSettled(ctx, settled) {
		t.Fatal("the settled report was not taken")
	}
	if got := state("Approve this plan?"); got != store.PendingSuperseded {
		t.Fatalf("settled approval = %s", got)
	}
	if got := outcome("Approve this plan?"); got != store.PendingOutcomeAutoResolved {
		t.Fatalf("settled approval outcome = %s", got)
	}
	if got := state("Allow this command?"); got != store.PendingOpen {
		t.Fatalf("other approval = %s", got)
	}
	if f.server.observeQuestionSettled(ctx, store.AgentSessionEvent{SessionID: sessionID, Label: "Response stream"}) {
		t.Fatal("another event was taken as a settled report")
	}

	// The turn ended (however): what held it waits no more; an async
	// question still does.
	failed := f.session
	failed.Status = "failed"
	reactions.SessionChanged(ctx, sessions.Completed, failed)
	if got := state("Allow this command?"); got != store.PendingSuperseded {
		t.Fatalf("held approval after the turn = %s", got)
	}
	if got := state("Keep the rows?"); got != store.PendingOpen {
		t.Fatalf("async question after the turn = %s", got)
	}
}
