package workspacedigest

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// §2: the L0 index stays within its 3k tokens however many projects and
// however long their lines, and with the longest "about the person" the
// snapshot stays within 6k.
func TestIndexStaysWithinItsBudget(t *testing.T) {
	now := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC)
	long := strings.Repeat("长", 300)
	digests := []store.WorkspaceDigest{}
	for i := 0; i < 200; i++ {
		digests = append(digests, store.WorkspaceDigest{
			WorkspaceID:    fmt.Sprintf("ws_%040d", i),
			Name:           long,
			DeviceLabel:    long,
			L0:             long,
			AccessRole:     store.WorkspaceRoleMember,
			LastActivityAt: now.Add(-time.Duration(i) * time.Hour).Format(time.RFC3339),
			CompiledAt:     now.Format(time.RFC3339),
		})
	}
	devices := []store.DeviceDigest{}
	for i := 0; i < 20; i++ {
		devices = append(devices, store.DeviceDigest{DeviceID: fmt.Sprintf("dev_%d", i), Label: long, System: "macOS 15.1", Runtimes: []string{"claude", "codex"}, Resources: []string{"browser", "screen"}})
	}
	index := Index(digests, devices, now)
	tokens := EstimateTokens(index)
	if tokens > personalagent.L0IndexMaxTokens {
		t.Fatalf("index takes %d tokens, more than %d", tokens, personalagent.L0IndexMaxTokens)
	}
	if !strings.Contains(index, "more projects: use find_workspace") {
		t.Fatalf("the index does not say what it left out:\n%s", index)
	}
	about := strings.Repeat("关", personalagent.L0AboutMaxChars)
	if total := EstimateTokens(about) + tokens; total > personalagent.L0TotalMaxTokens {
		t.Fatalf("about + index take %d tokens, more than %d", total, personalagent.L0TotalMaxTokens)
	}

	few := Index(digests[:50], nil, now)
	if lines := strings.Count(few, "\n- 『"); lines > personalagent.L0IndexMaxEntries {
		t.Fatalf("index lists %d projects, more than %d", lines, personalagent.L0IndexMaxEntries)
	}
}

func TestIndexLinesSayWhatAndHowFresh(t *testing.T) {
	now := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC)
	index := Index([]store.WorkspaceDigest{
		{WorkspaceID: "ws_a", Name: "Budget", DeviceLabel: "MacBook", DeviceOnline: true, L0: "记账网页", LastActivityAt: "2026-10-14T00:00:00Z", CompiledAt: "2026-10-14T00:00:00Z", AccessRole: "owner"},
		{WorkspaceID: "ws_b", Name: "Blog", DeviceLabel: "MacBook", Intro: "My blog. Built with Hugo.", Dirty: true, LastActivityAt: "2026-10-01T00:00:00Z", CompiledAt: "2026-10-01T00:00:00Z", AccessRole: "viewer"},
		{WorkspaceID: "ws_c", Name: "Old", Archived: true},
		{WorkspaceID: "ws_pa", Name: "Assistant", Kind: store.WorkspaceKindPersonalAgent},
	}, []store.DeviceDigest{{DeviceID: "dev_1", Label: "MacBook", Online: true, WorkspaceCount: 2}}, now)
	want := []string{
		"Computers (1):",
		"- MacBook (dev_1) · online · 2 projects",
		"Projects (2), most recently active first:",
		"- 『Budget』 (ws_a) · on MacBook · active 2026-10-14 · verified 2026-10-14 — 记账网页",
		"- 『Blog』 (ws_b) · on MacBook, offline · active 2026-10-01 · you are viewer · verified 2026-10-01, stale — My blog.",
	}
	if index != strings.Join(want, "\n") {
		t.Fatalf("index =\n%s\nwant\n%s", index, strings.Join(want, "\n"))
	}
}
