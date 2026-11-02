package assistant

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/run"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestMaintenanceResultRejectsWritesOutsideReviewedContract(t *testing.T) {
	valid := `{"summary":"Initialize purpose","findings":[],"patches":[{"path":"AGENTS.md","baseHash":"missing","content":"# Purpose\nAsk before changing goals.","reason":"No context file exists"}]}`
	if _, e := parseMaintenanceResult("governance", valid); e != nil {
		t.Fatal(e)
	}
	for _, raw := range []string{strings.Replace(valid, "AGENTS.md", "../AGENTS.md", 1), strings.Replace(valid, "missing", "not-a-hash", 1), strings.Replace(valid, `"findings":[]`, `"findings":[{"kind":"confirmed_fact","summary":"guess","sourceRefs":[]}]`, 1)} {
		if _, e := parseMaintenanceResult("governance", raw); e == nil {
			t.Fatal("invalid model output accepted", raw)
		}
	}
	if _, e := parseMaintenanceResult("memory", valid); e == nil {
		t.Fatal("memory review wrote a new source fact")
	}
}

func TestAssistantRefusalsKeepTheirStatus(t *testing.T) {
	settings := "https://foundry.example/assistant/settings"
	if err := notAllowed(store.PersonalAgentActionArchive, settings); refusalStatus(err) != http.StatusUnprocessableEntity || !strings.Contains(err.Error(), settings) {
		t.Fatalf("not allowed answers %d: %v", refusalStatus(err), err)
	}
	// The link the assistant passes on is a full one: a Feishu chat cannot
	// open a path of the web app.
	limit := limitRefusal(&personalagent.LimitError{Limit: "dailyWorkspaces", Max: 3}, settings)
	if kind := refusalKind(limit); kind != store.PersonalAgentRefusalLimit || !strings.Contains(limit.Error(), "("+settings+")") {
		t.Fatalf("a limit is refused as %s: %v", kind, limit)
	}
}

func TestHelperFailureReasons(t *testing.T) {
	var s Service
	for text, want := range map[string]string{
		"Not logged in · Please run /login":                            helperNotSignedIn,
		"unexpected status 401 Unauthorized":                           helperNotSignedIn,
		"API Error: 429 rate limit exceeded":                           helperRateLimited,
		"API Error: Connection error.":                                 helperUnreachable,
		"stream disconnected before completion: error sending request": helperUnreachable,
		sessions.ErrLocalDaemonNotConnected.Error():                    helperDeviceOffline,
		"spawn E2BIG": helperTaskError,
	} {
		if got := s.helperFailureReason(store.AgentSession{Error: text}, run.Account{}, false); got != want {
			t.Errorf("reason of %q = %s, want %s", text, got, want)
		}
	}
	if got := s.helperFailureReason(store.AgentSession{Error: "exit code 1"}, run.Account{Problem: run.AccountNotReady}, true); got != run.AccountNotReady {
		t.Errorf("reason of a failure on an account that is not ready = %s", got)
	}
}

// Task events to one conversation within the window go as one.
func TestAssistantNoticesCoalesce(t *testing.T) {
	previous := CoalesceNotices
	CoalesceNotices = 100 * time.Millisecond
	t.Cleanup(func() { CoalesceNotices = previous })
	var notices notices
	sent := make(chan string, 4)
	send := func(text string) { sent <- text }
	now := time.Now()
	notices.add("sess_c", "en", "first", now, send)
	notices.add("sess_c", "en", "second", now, send)
	notices.add("sess_c", "en", "third", now, send)
	if text := <-sent; text != "first" {
		t.Fatalf("first = %q", text)
	}
	select {
	case text := <-sent:
		if !strings.Contains(text, "2 updates") || !strings.Contains(text, "- second\n- third") {
			t.Fatalf("coalesced = %q", text)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the gathered notices were never sent")
	}
}

// A managed root on a Windows device holds its folders whatever the
// server's own path rules are.
func TestWithinAnyUsesDevicePaths(t *testing.T) {
	roots := []string{`C:\Users\me\Projects`, "/home/me/projects"}
	for path, want := range map[string]bool{
		`C:\Users\me\Projects\atlas`:     true,
		`C:\Users\me\Projects`:           false,
		`C:\Users\me\Projects\..\secret`: false,
		`C:\Users\me\Other`:              false,
		"/home/me/projects/atlas":        true,
		"/home/me/projectsx":             false,
	} {
		if got := withinAny(roots, path); got != want {
			t.Errorf("withinAny(%q) = %v, want %v", path, got, want)
		}
	}
}

// refusalStatus is the status a refusal answers with, 0 for none.
func refusalStatus(err error) int {
	var refusal interface{ HTTPStatus() int }
	if errors.As(err, &refusal) {
		return refusal.HTTPStatus()
	}
	return 0
}
