package assistant

import (
	"fmt"
	"strings"
	"testing"
	"time"

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

	file := ItemFile(item, helpers, events, time.UTC)
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

	bare := ItemFile(store.PersonalAgentListItem{ID: "pai_2", Text: "Call mum", Status: store.PersonalAgentItemDone, Owner: "person"}, nil, nil, time.UTC)
	for _, want := range []string{"touches: []\n", "holder: \"\"\n", "> Call mum\n", "## 进展\n\n（暂无）\n", "## 证据\n\n（暂无）\n", "## 帮手\n\n（暂无）\n", "## 最近时间线\n\n（暂无）\n"} {
		if !strings.Contains(bare, want) {
			t.Fatalf("missing %q in:\n%s", want, bare)
		}
	}
}

// The file lists every decision of the item with its id and the person's
// words, oldest first, a superseded one struck through with the id that
// replaced it, however long the timeline grows; then the acceptance criteria.
func TestItemFileListsDecisionsAndAcceptance(t *testing.T) {
	item := store.PersonalAgentListItem{ID: "pai_1", Text: "Channel replies", Status: store.PersonalAgentItemOpen, Owner: "assistant",
		Plan: &store.PersonalAgentItemPlan{Progress: "working", Acceptance: []string{"No text in a chat with others when blocked", "The person gets a Feishu card"}}}
	events := []store.PersonalAgentItemEvent{
		{ID: "pie_a", At: "2026-11-19T06:00:00Z", Actor: "assistant", Kind: store.PersonalAgentItemEventDecided,
			Detail: &store.PersonalAgentItemEventDetail{Decision: "Post a short text line", Quote: "回一句"}},
		{ID: "pie_b", At: "2026-11-19T07:00:00Z", Actor: "assistant", Kind: store.PersonalAgentItemEventDecided,
			Detail: &store.PersonalAgentItemEventDetail{Decision: "React with an emoji only", Quote: "用表情", Supersedes: "pie_a"}},
	}
	for i := range 30 {
		events = append(events, store.PersonalAgentItemEvent{At: fmt.Sprintf("2026-11-20T07:%02d:00Z", i), Actor: "assistant", Kind: "summary_updated"})
	}
	file := ItemFile(item, nil, events, time.UTC)
	for _, want := range []string{
		"## 决定\n\n- ~~2026-11-19 06:00 UTC · `pie_a` · Post a short text line~~（已被 `pie_b` 取代）\n  > 回一句\n" +
			"- 2026-11-19 07:00 UTC · `pie_b` · React with an emoji only\n  > 用表情\n",
		"## 完成标准\n\n- No text in a chat with others when blocked\n- The person gets a Feishu card\n",
	} {
		if !strings.Contains(file, want) {
			t.Fatalf("missing %q in:\n%s", want, file)
		}
	}
	bare := ItemFile(store.PersonalAgentListItem{ID: "pai_2", Text: "Call mum", Status: store.PersonalAgentItemOpen, Owner: "person"}, nil, nil, time.UTC)
	for _, want := range []string{"## 决定\n\n（暂无）\n", "## 完成标准\n\n（暂无）\n"} {
		if !strings.Contains(bare, want) {
			t.Fatalf("missing %q in:\n%s", want, bare)
		}
	}
}

// The times people read are in the person's zone with its UTC offset; the
// front matter keeps the stored RFC 3339 instant.
func TestItemFileTimesInPersonZone(t *testing.T) {
	item := store.PersonalAgentListItem{ID: "pai_1", Text: "Zones", Status: store.PersonalAgentItemOpen, Owner: "assistant",
		UpdatedAt: "2026-11-21T03:09:53.337313233Z",
		Plan:      &store.PersonalAgentItemPlan{Evidence: []store.PersonalAgentCompletionEvidence{{Summary: "seen", ObservedAt: "2026-11-21T03:30:00Z"}}}}
	events := []store.PersonalAgentItemEvent{
		{ID: "pie_a", At: "2026-11-20T23:15:00Z", Actor: "assistant", Kind: store.PersonalAgentItemEventDecided,
			Detail: &store.PersonalAgentItemEventDetail{Decision: "Use the offset", Quote: "带时区"}},
		{At: "2026-11-21T03:09:00Z", Actor: "session", Kind: "created"},
	}
	zone := func(name string) *time.Location {
		location, err := time.LoadLocation(name)
		if err != nil {
			t.Fatal(err)
		}
		return location
	}
	for _, c := range []struct {
		name                         string
		location                     *time.Location
		decision, evidence, timeline string
	}{
		{"UTC", time.UTC, "2026-11-20 23:15 UTC", "2026-11-21 03:30 UTC", "2026-11-21 03:09 UTC"},
		{"nil is UTC", nil, "2026-11-20 23:15 UTC", "2026-11-21 03:30 UTC", "2026-11-21 03:09 UTC"},
		{"Shanghai", zone("Asia/Shanghai"), "2026-11-21 07:15 UTC+8", "2026-11-21 11:30 UTC+8", "2026-11-21 11:09 UTC+8"},
		{"New York", zone("America/New_York"), "2026-11-20 18:15 UTC-5", "2026-11-20 22:30 UTC-5", "2026-11-20 22:09 UTC-5"},
		{"Kolkata", zone("Asia/Kolkata"), "2026-11-21 04:45 UTC+5:30", "2026-11-21 09:00 UTC+5:30", "2026-11-21 08:39 UTC+5:30"},
	} {
		file := ItemFile(item, nil, events, c.location)
		for _, want := range []string{
			"updated: \"2026-11-21T03:09:53.337313233Z\"\n",
			"## 决定\n\n- " + c.decision + " · `pie_a` · Use the offset\n",
			"## 证据\n\n- seen，" + c.evidence + "\n",
			"## 最近时间线\n\n- " + c.timeline + " · session · created\n- " + c.decision + " · assistant · decided",
		} {
			if !strings.Contains(file, want) {
				t.Fatalf("%s: missing %q in:\n%s", c.name, want, file)
			}
		}
	}
	if got := zonedTime("yesterday  noon", zone("Asia/Shanghai")); got != "yesterday noon" {
		t.Fatalf("unparsed time = %q", got)
	}
}
