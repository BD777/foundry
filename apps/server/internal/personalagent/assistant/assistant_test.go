package assistant

import (
	"encoding/json"
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

func maintenancePatchReview(path, baseHash string) string {
	raw, _ := json.Marshal(store.MaintenanceResult{
		Summary: "Review split targets",
		Patches: []store.MaintenancePatch{{
			Path:     path,
			BaseHash: baseHash,
			Content:  "# Reviewed context\n",
			Reason:   "Keep the source bounded",
		}},
	})
	return string(raw)
}

func TestMaintenanceResultRejectsWritesOutsideReviewedContract(t *testing.T) {
	valid := `{"summary":"Initialize purpose","findings":[],"patches":[{"path":"AGENTS.md","baseHash":"missing","content":"# Purpose\nAsk before changing goals.","reason":"No context file exists"}]}`
	if _, e := parseMaintenanceResult("governance", valid); e != nil {
		t.Fatal(e)
	}
	for _, kind := range []string{"instruction_budget", "instruction_bloat"} {
		raw := strings.Replace(valid, `"findings":[]`, `"findings":[{"kind":"`+kind+`","summary":"Split this section","sourceRefs":["AGENTS.md"]}]`, 1)
		if _, e := parseMaintenanceResult("governance", raw); e != nil {
			t.Fatalf("%s finding rejected: %v", kind, e)
		}
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

func TestMaintenanceResultAllowsReviewedSplitTargets(t *testing.T) {
	allowed := []string{
		"AGENTS.md",
		"README.md",
		"apps/web/AGENTS.md",
		"packages/worker/src/AGENTS.md",
		"docs/release.md",
		"docs/operations/release.md",
		".claude/skills/release/SKILL.md",
		".claude/skills/release/references/checklist.md",
		".agents/skills/release/SKILL.md",
		".agents/skills/release/references/checklist.md",
	}
	for _, path := range allowed {
		result, err := parseMaintenanceResult("governance", maintenancePatchReview(path, ""))
		if err != nil {
			t.Fatalf("%s rejected: %v", path, err)
		}
		if result.Patches[0].BaseHash != "" {
			t.Fatalf("%s new-file base hash = %q", path, result.Patches[0].BaseHash)
		}
	}
	if result, err := parseMaintenanceResult("governance", maintenancePatchReview("docs/release.md", strings.Repeat("a", 64))); err != nil || result.Patches[0].BaseHash == "" {
		t.Fatalf("modified file rejected: %+v %v", result, err)
	}
	rejected := []string{
		"/tmp/AGENTS.md",
		"C:/AGENTS.md",
		"../AGENTS.md",
		"docs/../AGENTS.md",
		"docs//release.md",
		"docs/./release.md",
		".git/AGENTS.md",
		"project/.git/AGENTS.md",
		".foundry/AGENTS.md",
		"docs/release.txt",
		".claude/skills/release/notes.md",
		".claude/skills/release/references/nested/checklist.md",
	}
	for _, path := range rejected {
		if _, err := parseMaintenanceResult("governance", maintenancePatchReview(path, "")); err == nil {
			t.Fatalf("%s accepted", path)
		}
	}
}

func TestContextPatchNewFileReviewAcceptsMissingPreview(t *testing.T) {
	if !contextPatchReviewedCurrent("", "missing") || !contextPatchReviewedCurrent("", "") {
		t.Fatal("new-file preview was not accepted")
	}
	hash := strings.Repeat("a", 64)
	if !contextPatchReviewedCurrent(hash, hash) {
		t.Fatal("modified-file preview was not accepted")
	}
	if contextPatchReviewedCurrent(hash, "missing") || contextPatchReviewedCurrent("", strings.Repeat("b", 64)) {
		t.Fatal("unreviewed source was accepted")
	}
}

func TestAssistantRefusalsKeepTheirStatus(t *testing.T) {
	service := Service{origin: "https://foundry.example"}
	settings := service.settingsURL(store.PersonalAgent{ID: "asst_work"})
	if settings != "https://foundry.example/assistants/asst_work/settings" {
		t.Fatalf("settings link = %q", settings)
	}
	if err := notAllowed(store.PersonalAgentActionArchive, settings); refusalStatus(err) != http.StatusUnprocessableEntity || !strings.Contains(err.Error(), settings) {
		t.Fatalf("not allowed answers %d: %v", refusalStatus(err), err)
	}
	// The link the assistant passes on is a full one: a Feishu chat cannot
	// open a path of the web app.
	limit := limitRefusal(&personalagent.LimitError{Limit: "dailyWorkspaces", Max: 3}, settings)
	if kind := refusalKind(limit); kind != store.PersonalAgentRefusalLimit || !strings.Contains(limit.Error(), "/assistants/asst_work/settings") {
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

// A memory review may judge each entry's layer; only a memory review, and
// only with a known judgement and confidence.
func TestMemoryReviewPlacements(t *testing.T) {
	valid := `{"summary":"Sorted","findings":[],"patches":[],"placements":[{"entryId":"knowledge_1","belongs":"assistant","confidence":"high","reason":"A colleague at work.","mentions":["Weichao"]},{"entryId":"knowledge_2","belongs":"person","confidence":"medium","reason":"A general preference.","mentions":[]}]}`
	review, err := parseMaintenanceReview("memory", valid)
	if err != nil || len(review.Placements) != 2 || review.Placements[0].Mentions[0] != "Weichao" || review.Summary != "Sorted" {
		t.Fatalf("review = %+v %v", review, err)
	}
	if _, err := parseMaintenanceResult("governance", valid); err == nil {
		t.Fatal("a governance review placed memory entries")
	}
	for _, raw := range []string{
		strings.Replace(valid, `"belongs":"assistant"`, `"belongs":"everyone"`, 1),
		strings.Replace(valid, `"confidence":"high"`, `"confidence":"sure"`, 1),
		strings.Replace(valid, `"reason":"A colleague at work."`, `"reason":""`, 1),
		strings.Replace(valid, `"entryId":"knowledge_1"`, `"entryId":""`, 1),
	} {
		if _, err := parseMaintenanceReview("memory", raw); err == nil {
			t.Fatal("invalid placement accepted", raw)
		}
	}
}
