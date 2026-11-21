package assistant

import (
	"fmt"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An item file opens with the read-only notice inside its front matter, holds
// the item's facts as YAML, then its goal, progress, evidence, helpers and
// the latest 20 events, newest first.
func TestItemFileRendersFactsAndSections(t *testing.T) {
	item := store.PersonalAgentListItem{
		ID: "pai_1", AssistantID: "asst_a", Text: "Ship the \"items\" ledger", Status: store.PersonalAgentItemOpen,
		Owner: store.PersonalAgentItemOwnerAssistant, HomeWorkspaceID: "ws_home", HolderSessionID: "sess_lead",
		UpdatedAt: "2026-11-21T08:00:00Z", Revision: 7,
		Quote:   "make items readable\nfrom the folder",
		Summary: "Projection first, no double write.",
		Plan: &store.PersonalAgentItemPlan{Progress: "server done", NextAction: "worker", WaitingFor: "review",
			Evidence: []store.PersonalAgentCompletionEvidence{{Kind: "test", Ref: "go test ./internal/x", Summary: "passes", ObservedAt: "2026-11-21T07:30:00Z"}}},
	}
	helpers := []store.PersonalAgentTask{
		{SessionID: "sess_a", Title: "Server", Status: "completed", WorkspaceID: "ws_home"},
		{SessionID: "sess_b", Title: "Web", Status: "running", WorkspaceID: "ws_web"},
	}
	var events []store.PersonalAgentItemEvent
	for i := range 25 {
		events = append(events, store.PersonalAgentItemEvent{At: fmt.Sprintf("2026-11-21T07:%02d:00Z", i), Actor: "assistant", Kind: "summary_updated"})
	}
	events = append(events, store.PersonalAgentItemEvent{At: "2026-11-21T07:59:00Z", Actor: "session", Kind: store.PersonalAgentItemEventRehomed,
		Detail: &store.PersonalAgentItemEventDetail{To: "ws_home"}})

	file := ItemFile(item, helpers, events)
	head := "---\n" + ItemFileNotice + "\n" +
		"id: \"pai_1\"\ntitle: \"Ship the \\\"items\\\" ledger\"\nstatus: \"open\"\nowner: \"assistant\"\nhome: \"ws_home\"\n" +
		"touches: [\"ws_web\"]\nholder: \"sess_lead\"\nupdated: \"2026-11-21T08:00:00Z\"\nrevision: 7\n---\n"
	if !strings.HasPrefix(file, head) {
		t.Fatalf("front matter:\n%s", file)
	}
	for _, want := range []string{
		"## 目标\n\n本人原话：\n\n> make items readable\n> from the folder\n\n摘要：\n\nProjection first, no double write.\n",
		"## 进展\n\n- 进展：server done\n- 下一步：worker\n- 等待：review\n",
		"## 证据\n\n- [test] passes (go test ./internal/x)，2026-11-21 07:30 UTC\n",
		"## 帮手\n\n- sess_a — Server — completed\n- sess_b — Web — running（ws_web）\n",
		"## 最近时间线\n\n- 2026-11-21 07:59 UTC · session · rehomed：inbox → ws_home\n- 2026-11-21 07:24 UTC",
	} {
		if !strings.Contains(file, want) {
			t.Fatalf("missing %q in:\n%s", want, file)
		}
	}
	if lines := strings.Count(file[strings.Index(file, "## 最近时间线"):], "\n- "); lines != itemFileTimeline {
		t.Fatalf("timeline has %d events, want %d", lines, itemFileTimeline)
	}
	if strings.Contains(file, "07:05 UTC") {
		t.Fatal("the timeline kept an event older than the latest 20")
	}

	bare := ItemFile(store.PersonalAgentListItem{ID: "pai_2", Text: "Call mum", Status: store.PersonalAgentItemDone, Owner: "person"}, nil, nil)
	for _, want := range []string{"touches: []\n", "holder: \"\"\n", "> Call mum\n", "## 进展\n\n（暂无）\n", "## 证据\n\n（暂无）\n", "## 帮手\n\n（暂无）\n", "## 最近时间线\n\n（暂无）\n"} {
		if !strings.Contains(bare, want) {
			t.Fatalf("missing %q in:\n%s", want, bare)
		}
	}
}
