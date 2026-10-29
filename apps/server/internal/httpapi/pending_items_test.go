package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

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
	reactions.sessionEventRecorded(ctx, question)
	// The same answer reported again counts once.
	reactions.sessionEventRecorded(ctx, question)
	asked := f.item(store.PendingSourceQuestion)
	if asked.State != store.PendingOpen || asked.Occurrences != 1 || asked.Excerpt != "Keep the three closed rows blocked?" ||
		asked.Recommendation != "Keep them blocked (Recommended)" || len(asked.Options) != 2 || asked.MessageID != "turn/call_1" ||
		!strings.Contains(asked.Context, "Three are already closed.") || asked.SessionTitle == "" || asked.WorkspaceName != "Pending" {
		t.Fatalf("question item = %+v", asked)
	}

	// A failed turn reported three times is one item seen three times.
	for index, id := range []string{"evt_fail_1", "evt_fail_2", "evt_fail_3"} {
		reactions.sessionEventRecorded(ctx, store.AgentSessionEvent{ID: id, SessionID: sessionID, Label: "Session failed", Level: "error",
			Detail: "API Error: 503 no eligible upstream account" + strings.Repeat(" ", index)})
	}
	failed := f.item(store.PendingSourceTurnFailed)
	if failed.Occurrences != 3 || failed.State != store.PendingOpen {
		t.Fatalf("failed item = %+v", failed)
	}
	reactions.sessionEventRecorded(ctx, toolEvent("evt_sudo", sessionID, "sudo apt install jq", "sudo: a password is required"))
	hands := f.item(store.PendingSourceNeedsHands)
	if hands.Rule != "sudo" || hands.Context != "sudo apt install jq" || hands.Title != "sudo: a password is required" {
		t.Fatalf("needs-hands item = %+v", hands)
	}
	list := f.list()
	if list.Open != 3 || list.BySession[sessionID] != 3 {
		t.Fatalf("counts = %d, %+v", list.Open, list.BySession)
	}

	// A turn that completes makes the failure moot, nothing else.
	completed := f.session
	completed.Status = "completed"
	reactions.sessionChanged(ctx, sessionCompleted, completed)
	if got := f.item(store.PendingSourceTurnFailed).State; got != store.PendingSuperseded {
		t.Fatalf("failure after a completed turn = %s", got)
	}
	if got := f.item(store.PendingSourceQuestion).State; got != store.PendingOpen {
		t.Fatalf("question after a completed turn = %s", got)
	}

	// Another session's message answers nothing; the person's answers all.
	queued := f.session
	queued.Input = store.SessionInput{ID: "in_agent", SentBySessionID: "sess_other", At: time.Now().UTC().Format(time.RFC3339Nano)}
	reactions.sessionChanged(ctx, sessionQueued, queued)
	if got := f.item(store.PendingSourceQuestion).State; got != store.PendingOpen {
		t.Fatalf("question after another session's message = %s", got)
	}
	queued.Input = store.SessionInput{ID: "in_person", At: time.Now().Add(time.Second).UTC().Format(time.RFC3339Nano)}
	reactions.sessionChanged(ctx, sessionQueued, queued)
	if got := f.item(store.PendingSourceQuestion).State; got != store.PendingReplied {
		t.Fatalf("question after the person's message = %s", got)
	}
	if got := f.item(store.PendingSourceNeedsHands).State; got != store.PendingReplied {
		t.Fatalf("needs-hands after the person's message = %s", got)
	}
	// The answer reported again later stays answered.
	reactions.sessionEventRecorded(ctx, question)
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
	pendingReactions{f.server}.sessionEventRecorded(ctx, store.AgentSessionEvent{ID: "evt_child_fail", SessionID: child.ID, Label: "Session failed", Level: "error", Detail: "boom"})
	if list := f.list(); len(list.Items) != 0 {
		t.Fatalf("an Agent-started session made items %+v", list.Items)
	}
}

func TestPendingItemsFollowAnIssueQuestion(t *testing.T) {
	f := newPendingFixture(t)
	reactions := pendingReactions{f.server}
	issue := store.Issue{ID: "iss_1", WorkspaceID: "ws_pending", Title: "Ship the export", Status: "blocked", CreatedByUserID: f.session.CreatedByUserID,
		Question: &store.IssueQuestion{ID: "question_1", Kind: "permission", Text: "May I deploy to staging?", Options: []string{"Yes", "No"}, RunID: f.session.ID}}
	reactions.issueUpdated(issue)
	reactions.issueUpdated(issue)
	asked := f.item(store.PendingSourceIssueQuestion)
	if asked.IssueID != "iss_1" || asked.Excerpt != "May I deploy to staging?" || asked.Rule != "permission" || asked.Occurrences != 1 {
		t.Fatalf("issue item = %+v", asked)
	}
	if list := f.list(); list.BySession[f.session.ID] != 0 {
		t.Fatalf("an Issue question counted in its run's chat: %+v", list.BySession)
	}
	issue.Question, issue.Status = nil, "in_progress"
	reactions.issueUpdated(issue)
	if got := f.item(store.PendingSourceIssueQuestion).State; got != store.PendingSuperseded {
		t.Fatalf("issue item after the answer = %s", got)
	}
}
