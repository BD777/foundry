package assistant

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A due summary is counted only once it is due now, once per workspace, and
// never while its summary runs (DEV-252).
func TestDueDigestFactsKeepsDueUnrunningWorkspaces(t *testing.T) {
	now := time.Date(2026, 11, 16, 6, 0, 0, 0, time.UTC)
	due := func(id, name, at string) store.WorkspaceDigestRecord {
		return store.WorkspaceDigestRecord{Digest: store.WorkspaceDigest{WorkspaceID: id, Name: name}, SummaryDueAt: at}
	}
	past := due("ws_budget", "Budget", "2026-11-16T05:00:00Z")
	future := due("ws_notes", "Notes", "2026-11-16T07:00:00Z")
	running := due("ws_blog", "Blog", "2026-11-16T05:00:00Z")
	running.SummarySessionID = "sess_summary"
	got := dueDigestFacts([]store.WorkspaceDigestRecord{past, future, running, past}, now)
	if len(got) != 1 || got[0].WorkspaceID != "ws_budget" || got[0].Project != "Budget" {
		t.Fatalf("due digests = %+v", got)
	}
}

// The facts file names the waiting changes, the failure and stalled reasons,
// the blocked summaries, and the settings page of the assistant it is for.
func TestUpkeepFileContentNamesTheFactsAndItsAssistant(t *testing.T) {
	now := time.Date(2026, 11, 16, 6, 0, 0, 0, time.UTC)
	state := upkeepState{
		Proposals:   []upkeepProposal{{WorkspaceID: "ws_budget", Project: "Budget", Changes: 2, Since: now.Add(-time.Hour)}},
		Failed:      []upkeepJob{{WorkspaceID: "ws_notes", Project: "Notes", Role: "governance", Reason: "runner_failed", Since: now.Add(-2 * time.Hour)}},
		Stalled:     []upkeepJob{{WorkspaceID: "ws_blog", Project: "Blog", Role: "memory", Reason: "device_offline", Since: now.Add(-time.Hour)}},
		Digests:     []upkeepDigest{{WorkspaceID: "ws_home", Project: "Home", DueAt: now.Add(-time.Hour)}},
		DeviceLabel: "Mac mini",
	}
	settings := "https://foundry.test/assistants/asst_second/settings"
	got := upkeepFileContent(state, now, time.UTC, settings)
	for _, want := range []string{
		"Budget (ws_budget): 2 suggested changes", settings,
		"Notes (ws_notes): project review failed (runner_failed)",
		"Blog (ws_blog): memory review waiting", "device_offline",
		"1 summary is due and wait for Mac mini to come online", "Home (ws_home)",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the upkeep file lacks %q:\n%s", want, got)
		}
	}
	if empty := upkeepFileContent(upkeepState{}, now, time.UTC, ""); !strings.Contains(empty, "Nothing needs attention.") {
		t.Fatalf("empty upkeep = %q", empty)
	}
}

func TestMaintenancePromptRedactsThePurpose(t *testing.T) {
	prompt := maintenancePromptText("governance", "Review the project.", "Sync sk-proj-AbCdEf1234567890GhIjKlMnOp with ops@example.com using https://deploy:hunter2@example.com/job")
	for _, secret := range []string{"sk-proj-AbCdEf1234567890GhIjKlMnOp", "ops@example.com", "deploy:hunter2"} {
		if strings.Contains(prompt, secret) {
			t.Fatalf("maintenance prompt leaked %q: %s", secret, prompt)
		}
	}
	for _, placeholder := range []string{"‹secret›", "‹email›"} {
		if !strings.Contains(prompt, placeholder) {
			t.Fatalf("maintenance prompt lacks %s: %s", placeholder, prompt)
		}
	}
}

func TestMaintenanceKnowledgeIndexRedactsTextAndKeepsIdentity(t *testing.T) {
	index := maintenanceKnowledgeIndex([]store.KnowledgeEntry{{
		ID:            "entry_1",
		VaultID:       "vault_1",
		Epoch:         4,
		Revision:      7,
		Hash:          "sha256:unchanged",
		Title:         "Rotate sk-proj-AbCdEf1234567890GhIjKlMnOp",
		SourceRef:     "https://deploy:hunter2@example.com/job",
		SourceVersion: "version-3",
		State:         "active",
		UpdatedAt:     "2026-11-10T00:00:00Z",
	}})
	if strings.Contains(index, "sk-proj-AbCdEf1234567890GhIjKlMnOp") || strings.Contains(index, "deploy:hunter2") || !strings.Contains(index, "‹secret›") {
		t.Fatalf("maintenance index was not redacted: %s", index)
	}
	var entries []store.KnowledgeEntry
	if err := json.Unmarshal([]byte(index), &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v", entries)
	}
	entry := entries[0]
	if entry.ID != "entry_1" || entry.VaultID != "vault_1" || entry.Epoch != 4 || entry.Revision != 7 ||
		entry.Hash != "sha256:unchanged" || entry.SourceVersion != "version-3" || entry.UpdatedAt != "2026-11-10T00:00:00Z" {
		t.Fatalf("maintenance index changed identity fields: %+v", entry)
	}
}
