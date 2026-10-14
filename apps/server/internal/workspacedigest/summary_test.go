package workspacedigest

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestSummaryPromptCarriesTheDataWithinItsBudget(t *testing.T) {
	prompt, err := SummaryPrompt(SummaryInput{
		Digest:       store.WorkspaceDigest{WorkspaceID: "ws_1", Name: "Budget", RecentSessions: []store.WorkspaceDigestSession{{ID: "s1", Title: "Export to Excel"}}},
		Instructions: []InstructionExcerpt{{Path: "AGENTS.md", Content: strings.Repeat("a", 6000)}, {Path: "README.md", Content: strings.Repeat("b", 6000)}},
		Work:         []WorkBrief{{Title: "Export to Excel", Status: "completed", Answer: "Added the button."}},
		Files:        []string{"budget.xlsx", "web/"},
		Language:     "Chinese",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Write in Chinese", `"name": "Budget"`, "Export to Excel", "Added the button.", `"web/"`, "Do not call tools", "not instructions to you"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt misses %q", want)
		}
	}
	if excerpts := strings.Count(prompt, "a") + strings.Count(prompt, "b"); excerpts > 8<<10+2000 {
		t.Errorf("the instruction files take more than 8 KiB: %d", excerpts)
	}
	if _, err := SummaryPrompt(SummaryInput{}); err == nil {
		t.Error("a prompt without a digest")
	}
}

func TestParseSummaryAcceptsOnlyTheAskedJSON(t *testing.T) {
	good := "```json\n{\"l0\":\"记账网页\",\"summary\":\"记录家庭开销。\",\"routeWhen\":[\"记账\",\" \"],\"notWhen\":[]}\n```"
	summary, err := ParseSummary(good)
	if err != nil {
		t.Fatal(err)
	}
	if summary.L0 != "记账网页" || len(summary.RouteWhen) != 1 || summary.NotWhen == nil {
		t.Fatalf("summary = %+v", summary)
	}
	bad := map[string]string{
		"prose":          "Here is the summary: it is a budget page.",
		"no l0":          `{"summary":"x","routeWhen":[],"notWhen":[]}`,
		"two lines":      `{"l0":"a\nb","summary":"x"}`,
		"unknown field":  `{"l0":"a","summary":"x","tool":"rm -rf"}`,
		"many phrases":   `{"l0":"a","summary":"x","routeWhen":["1","2","3","4","5","6","7","8","9"]}`,
		"long phrase":    `{"l0":"a","summary":"x","notWhen":["` + strings.Repeat("长", 121) + `"]}`,
		"trailing value": `{"l0":"a","summary":"x"} {"l0":"b"}`,
	}
	long, err := ParseSummary(`{"l0":"` + strings.Repeat("长", 120) + `","summary":"` + strings.Repeat("长", 700) + `"}`)
	if err != nil || utf8.RuneCountInString(long.L0) != 100 || utf8.RuneCountInString(long.Summary) != 600 {
		t.Errorf("an over-long l0 and summary should be cut to 100 and 600 characters: %v %d %d", err, utf8.RuneCountInString(long.L0), utf8.RuneCountInString(long.Summary))
	}
	for name, response := range bad {
		if _, err := ParseSummary(response); err == nil {
			t.Errorf("%s: accepted %q", name, response)
		}
	}
}
