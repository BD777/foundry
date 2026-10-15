package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The dev report of 2026-10-15 (sess_1792049361424425217): the assistant
// handed work to byte-dev without a profile; its Claude Local and Codex
// Local logins are not signed in there, an endpoint's check failed, and
// only a Codex gateway and a model service work. ws_budget on dev_home
// stands in for byte-dev.
type accountsFixture struct {
	digestFixture
	call         func(tool string, arguments any) (string, bool)
	conversation store.AgentSession
	service      store.ProfileDefinition
}

const (
	accountsGateway = "codex_provider_llm_gateway"
)

func budgetAccounts(statuses map[string]string) []store.AgentProjection {
	agent := func(id, provider, profile, connection string) store.AgentProjection {
		status := statuses[profile]
		if status == "" {
			status = "healthy"
		}
		return store.AgentProjection{
			ID: id, WorkspaceID: "ws_budget", DeviceID: "dev_home", Provider: provider, ProfileID: profile,
			ProfileLabel: profile, ConnectionType: connection, Status: status, AuthMode: "local_config", SecretStored: "local",
			ConfigScope: "device", ConfigLabel: "local", LastSeenLabel: "online",
		}
	}
	return []store.AgentProjection{
		agent("agent_budget", "claude", "claude_local", "local_login"),
		agent("agent_budget_codex", "codex", "codex_local", "local_login"),
		agent("agent_budget_ccm", "codex", "codex_provider_ccm", "openai_compatible"),
		agent("agent_budget_gateway", "codex", accountsGateway, "openai_compatible"),
	}
}

func (f accountsFixture) registerBudget(t *testing.T, statuses map[string]string) {
	t.Helper()
	if err := f.db.RegisterDaemon(context.Background(), store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_home", Label: "byte-dev", Status: "connected"},
		Workspace: store.WorkspaceProjection{ID: "ws_budget", Name: "Budget", LocalPath: "/home/me/budget"},
		Agents:    budgetAccounts(statuses),
	}); err != nil {
		t.Fatal(err)
	}
}

func newAccountsFixture(t *testing.T) accountsFixture {
	t.Helper()
	f := accountsFixture{digestFixture: newDigestFixture(t)}
	ctx := context.Background()
	f.registerBudget(t, map[string]string{"claude_local": "missing_auth", "codex_local": "missing_auth", "codex_provider_ccm": "unavailable"})
	service, err := f.db.SaveProfile(ctx, store.SaveProfileInput{
		Runtime: "claude", Label: "super-relay", ConnectionType: "anthropic_compatible", BaseURL: "https://relay.internal",
	})
	if err != nil {
		t.Fatal(err)
	}
	f.service = service
	agent, _ := f.db.GetPersonalAgent(ctx, f.aliceID)
	agent.Settings.Language = "en"
	if _, err := f.db.SavePersonalAgentSettings(ctx, f.aliceID, agent.Settings); err != nil {
		t.Fatal(err)
	}
	conversation, err := f.server.createAndDispatch(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Provider: "claude", Prompt: "review the doc", Source: "chat",
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	run := f.daemon.nextChatRun()
	if run.Session.ID != conversation.ID || run.SessionToken == "" {
		t.Fatalf("conversation run = %s with token %q", run.Session.ID, run.SessionToken)
	}
	f.daemon.complete(run.Session, "On it.")
	waitForStatus(t, f.db, conversation.ID, "completed")
	f.conversation = conversation
	f.call = mcpToolCaller(t, f.server.Routes(), run.SessionToken)
	return f
}

// heard is the next notice the assistant's conversation was told, once
// it has answered it.
func (f accountsFixture) heard(t *testing.T) string {
	t.Helper()
	run := f.daemon.nextChatRun()
	if run.Session.ID != f.conversation.ID {
		t.Fatalf("a run of %s, want the conversation", run.Session.ID)
	}
	f.daemon.complete(run.Session, "Noted.")
	waitForStatus(t, f.db, f.conversation.ID, "completed")
	return run.Session.Input.Prompt
}

// quiet fails the test if the assistant is told anything soon.
func (f accountsFixture) quiet(t *testing.T, what string) {
	t.Helper()
	select {
	case run := <-f.daemon.runs:
		t.Fatalf("%s: %q", what, run.Session.Input.Prompt)
	case <-time.After(300 * time.Millisecond):
	}
}

func instantNotices(t *testing.T) {
	previous := coalesceNotices
	coalesceNotices = 0
	t.Cleanup(func() { coalesceNotices = previous })
}

// createHelper hands ws_budget work over MCP and answers the helper the
// device received.
func (f accountsFixture) createHelper(t *testing.T, arguments map[string]any) store.AgentSession {
	t.Helper()
	arguments["workspaceId"], arguments["prompt"] = "ws_budget", "review the doc"
	if text, isError := f.call("create_session", arguments); isError {
		t.Fatalf("create_session %v = %s", arguments, text)
	}
	return f.daemon.nextChatRun().Session
}

// Without a profile, a helper on another device runs under an account
// that works there: never a login its device reports as not signed in or
// an endpoint whose check failed; a named runtime narrows the choice; the
// account the person last completed work on there comes first.
func TestHelperRunsUnderAnAccountThatWorksOnItsDevice(t *testing.T) {
	f := newAccountsFixture(t)
	ctx := context.Background()
	for _, want := range []struct {
		arguments map[string]any
		profile   string
	}{
		{map[string]any{}, accountsGateway},
		{map[string]any{"provider": "codex"}, accountsGateway},
	} {
		if helper := f.createHelper(t, want.arguments); helper.ProfileID != want.profile {
			t.Fatalf("create_session %v ran %s/%s, want %s", want.arguments, helper.Provider, helper.ProfileID, want.profile)
		}
	}
	text, isError := f.call("create_session", map[string]any{"workspaceId": "ws_budget", "provider": "claude", "prompt": "go"})
	var refusal struct {
		Error    string             `json:"error"`
		Accounts []workspaceAccount `json:"accounts"`
	}
	if !isError || json.Unmarshal([]byte(text), &refusal) != nil || refusal.Error != "no_usable_account" || len(refusal.Accounts) != 4 ||
		!strings.Contains(text, `"problem":"not_signed_in"`) {
		t.Fatalf("a claude helper where no claude account works = %s, want no_usable_account listing the accounts", text)
	}

	if err := f.db.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: "dev_home", ProfileIDs: []string{f.service.ID}}); err != nil {
		t.Fatal(err)
	}
	if helper := f.createHelper(t, map[string]any{"provider": "claude"}); helper.ProfileID != f.service.ID {
		t.Fatalf("a claude helper ran %s, want the model service %s", helper.ProfileID, f.service.ID)
	} else {
		f.daemon.complete(helper, "Reviewed.")
		waitForStatus(t, f.db, helper.ID, "completed")
	}
	f.heard(t)
	if helper := f.createHelper(t, map[string]any{}); helper.ProfileID != f.service.ID {
		t.Fatalf("a helper ran %s, want %s the person last completed work on there", helper.ProfileID, f.service.ID)
	}

	text, isError = f.call("get_workspace", map[string]any{"workspaceId": "ws_budget", "include": []string{"note"}})
	if isError || !strings.Contains(text, `"defaultProfileId": "`+f.service.ID+`"`) || !strings.Contains(text, `"problem": "not_signed_in"`) ||
		!strings.Contains(text, `"kind": "model_service"`) || !strings.Contains(text, `"kind": "device_login"`) {
		t.Fatalf("get_workspace accounts = %s", text)
	}
}

// send_message naming only another runtime switches to an account of it
// that works; naming the session's own runtime keeps its account.
func TestRuntimeSwitchRunsUnderAnAccountThatWorks(t *testing.T) {
	instantNotices(t)
	f := newAccountsFixture(t)
	ctx := context.Background()
	if err := f.db.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: "dev_home", ProfileIDs: []string{f.service.ID}}); err != nil {
		t.Fatal(err)
	}
	helper := f.createHelper(t, map[string]any{"profileId": f.service.ID})
	f.daemon.complete(helper, "Done.")
	waitForStatus(t, f.db, helper.ID, "completed")
	f.heard(t)
	for _, provider := range []string{"codex", "codex"} {
		if text, isError := f.call("send_message", map[string]any{"sessionId": helper.ID, "prompt": "again", "provider": provider}); isError {
			t.Fatalf("send_message = %s", text)
		}
		run := f.daemon.nextChatRun().Session
		if run.ProfileID != accountsGateway {
			t.Fatalf("send_message provider=%s ran %s, want %s", provider, run.ProfileID, accountsGateway)
		}
		f.daemon.complete(run, "Done.")
		waitForStatus(t, f.db, helper.ID, "completed")
		f.heard(t)
	}
}

// A helper that failed because its account is not signed in tells the
// assistant why, as a category it can act on, and which accounts work
// there instead.
func TestFailedHelperNoticeCarriesItsReason(t *testing.T) {
	instantNotices(t)
	f := newAccountsFixture(t)
	ctx := context.Background()
	helper := f.createHelper(t, map[string]any{"profileId": "claude_local"})
	f.server.failUndelivered(ctx, helper, "Not logged in · Please run /login")
	notice := f.heard(t)
	for _, want := range []string{"Failed:", "Not logged in", "is not signed in on that computer", "[reason=not_signed_in profileId=claude_local runtime=claude]",
		"Accounts that work there:", "profileId " + accountsGateway} {
		if !strings.Contains(notice, want) {
			t.Fatalf("failure notice misses %q:\n%s", want, notice)
		}
	}
	if strings.Contains(notice, "profileId claude_local,") || strings.Contains(notice, "profileId codex_local") {
		t.Fatalf("the notice offers an account that does not work:\n%s", notice)
	}
}

// A helper whose latest events are only failed attempts to reach its
// model service is reported once, within serviceUnreachableAfter, and
// keeps running; one that got through after reconnecting is not.
func TestUnreachableHelperIsReported(t *testing.T) {
	instantNotices(t)
	f := newAccountsFixture(t)
	ctx := context.Background()
	start := time.Now().UTC()
	record := func(session store.AgentSession, offset time.Duration, label, detail string) {
		t.Helper()
		at := start.Add(offset).Format(time.RFC3339Nano)
		if err := f.db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{
			ID: fmt.Sprintf("evt_%s_%d", session.ID, offset), SessionID: session.ID, At: at, Label: label, Detail: detail, Level: "warning",
		}); err != nil {
			t.Fatal(err)
		}
	}
	running := func() store.AgentSession {
		helper := f.createHelper(t, map[string]any{"profileId": "codex_local"})
		if _, err := f.db.StartAgentSession(ctx, helper.ID); err != nil {
			t.Fatal(err)
		}
		record(helper, 0, "Thinking", "The model is processing the request.")
		record(helper, 45*time.Second, "Notice", "Reconnecting... 2/5 (request timed out)")
		record(helper, 105*time.Second, "Notice", "Falling back from WebSockets to HTTPS transport. request timed out")
		record(helper, 3*time.Minute, "Notice", "Reconnecting... waiting for network (Connection failed: error sending request)")
		return helper
	}

	recovered := running()
	record(recovered, 4*time.Minute, "Ran command", "git status")
	if err := f.server.superviseAssistantTasks(ctx, start.Add(5*time.Minute)); err != nil {
		t.Fatal(err)
	}
	f.quiet(t, "a helper that got through was reported")

	stuck := running()
	if err := f.server.superviseAssistantTasks(ctx, start.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := f.server.superviseAssistantTasks(ctx, start.Add(45*time.Second+serviceUnreachableAfter)); err != nil {
		t.Fatal(err)
	}
	notice := f.heard(t)
	for _, want := range []string{"Stuck, can't reach its service", stuck.ID, "waiting for network", "[reason=unreachable profileId=codex_local runtime=codex]",
		"Stop it with cancel_session", "profileId " + accountsGateway} {
		if !strings.Contains(notice, want) {
			t.Fatalf("unreachable notice misses %q:\n%s", want, notice)
		}
	}
	if !personalagent.IsNotice(notice) {
		t.Fatalf("the report reads as the person's words: %q", notice)
	}
	if current, _ := f.db.GetAgentSessionSummary(ctx, stuck.ID); current.Status != "running" {
		t.Fatalf("the stuck helper is %s, want it left running", current.Status)
	}
	if err := f.server.superviseAssistantTasks(ctx, start.Add(4*time.Minute)); err != nil {
		t.Fatal(err)
	}
	f.quiet(t, "the same spell was reported twice")
}

// A helper the worker blocks while its model request retries waits on no
// one: the assistant is not asked to fetch an answer for it.
func TestRetryingHelperIsNotReportedAsAsking(t *testing.T) {
	instantNotices(t)
	f := newAccountsFixture(t)
	ctx := context.Background()
	helper := f.createHelper(t, map[string]any{"profileId": accountsGateway})
	if _, err := f.db.StartAgentSession(ctx, helper.ID); err != nil {
		t.Fatal(err)
	}
	blocked, err := f.db.BlockAgentSession(ctx, helper.ID, "Model request retry")
	if err != nil {
		t.Fatal(err)
	}
	f.server.sessions.changed(ctx, sessionBlocked, blocked)
	f.quiet(t, "a retrying helper was reported")
	if tasks, _ := f.db.ListPersonalAgentTasks(ctx, f.aliceID, []string{store.PersonalAgentTaskAsking}); len(tasks) != 0 {
		t.Fatalf("asking tasks = %+v", tasks)
	}
}

func TestHelperFailureReasons(t *testing.T) {
	var s Server
	for text, want := range map[string]string{
		"Not logged in · Please run /login":                            helperNotSignedIn,
		"unexpected status 401 Unauthorized":                           helperNotSignedIn,
		"API Error: 429 rate limit exceeded":                           helperRateLimited,
		"API Error: Connection error.":                                 helperUnreachable,
		"stream disconnected before completion: error sending request": helperUnreachable,
		ErrLocalDaemonNotConnected.Error():                             helperDeviceOffline,
		"spawn E2BIG":                                                  helperTaskError,
	} {
		if got := s.helperFailureReason(store.AgentSession{Error: text}, workspaceAccount{}, false); got != want {
			t.Errorf("reason of %q = %s, want %s", text, got, want)
		}
	}
	if got := s.helperFailureReason(store.AgentSession{Error: "exit code 1"}, workspaceAccount{Problem: accountNotReady}, true); got != accountNotReady {
		t.Errorf("reason of a failure on an account that is not ready = %s", got)
	}
}
