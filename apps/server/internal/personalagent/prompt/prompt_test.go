package prompt_test

import (
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

var update = flag.Bool("update", false, "rewrite testdata/*.golden from Fill's output")

// Every version system.md shipped as, with its hash. Changing the prompt
// fails here until it gets a new Version and a new line.
var promptVersions = map[string]string{
	"2026-10-30.1": "3598a48427e1294664fa26b93cbce452055d31c7b287223a49514a50eed3c0ff",
	"2026-10-28.1": "cf16b28425c3b4f4fcbed7c390cd7c823506f217fb7f7424afd3f5e891d1a675",
	"2026-10-21.1": "4283f7527aa14b7b952b12c759adf2f606a4aca67672fe88f07ed591bb51a896",
	"2026-10-20.1": "6f891e80c691d52772216f879bca831342289aa0e6c5b8aeb9326516c3a0ac14",
	"2026-10-15.1": "5b8281e77291423e1cccd62f52d716ac78e9f417d5c7eb0daf8563a35d2bfee1",
	"2026-10-15.2": "787ddd55f14e5daec392abf63f6e231cc9af52f7db0b040a29602d2edff489b6",
	"2026-10-15.3": "2a2af22e131a0bfb8661c0e8e5888ad31307d11ebc70cadfe499b596b1b03a72",
	"2026-10-15.4": "7f4e4e2544404bd90328b2091b320fa31bfdba59150622afb5246044d8eadde4",
	"2026-10-15.5": "e3754f6a11bcde6c23e44115c5836c6c62fc22a3c490638b027067c8268b1785",
	"2026-10-15.6": "9585d7b75f3193634203260075216603451c384a95ed7bbdb1e2014e616c39dc",
}

func TestEveryPromptChangeHasItsOwnVersion(t *testing.T) {
	sum := sha256.Sum256([]byte(prompt.System()))
	got := hex.EncodeToString(sum[:])
	want, ok := promptVersions[prompt.Version]
	if !ok || want != got {
		t.Fatalf("system.md (sha256 %s) is not the prompt recorded as %s: bump prompt.Version and add it to promptVersions", got, prompt.Version)
	}
}

// The words a non-technical person should never meet (§1, §13), as the
// prompt lists them.
var (
	bannedEnglish = regexp.MustCompile(`(?i)\b(workspaces?|devices?|sessions?|repos?|repositor(?:y|ies)|branch(?:es)?|commits?|profiles?|runtimes?|models?|mcp|tokens?|agents?|prompts?|director(?:y|ies)|paths?|claude|codex)\b`)
	// "issue" is an ordinary word; Foundry's Issue is capitalised.
	bannedIssue   = regexp.MustCompile(`\bIssues?\b`)
	bannedEnList  = []string{"workspace", "device", "session", "repo", "repository", "branch", "commit", "Issue", "profile", "runtime", "model", "MCP", "token", "agent", "prompt", "directory", "path", "Claude", "Codex"}
	bannedChinese = []string{"工作区", "设备", "会话", "仓库", "分支", "提交", "模型", "令牌", "智能体", "提示词", "目录", "路径"}
	foundryIDs    = regexp.MustCompile(`\b(ws|sess|dev|iss|native_claude|native_codex)_`)
)

func bannedIn(text string) []string {
	found := append(bannedEnglish.FindAllString(text, -1), bannedIssue.FindAllString(text, -1)...)
	for _, word := range bannedChinese {
		if strings.Contains(text, word) {
			found = append(found, word)
		}
	}
	return append(found, foundryIDs.FindAllString(text, -1)...)
}

// userFacingLines are the prompt's lines the assistant would say: example
// replies ("Reply:"; "Reply (mirroring their words):" is the one example of
// echoing a technical person) and the plain words it is told to use.
func userFacingLines() []string {
	lines := []string{}
	inSayInstead := false
	for _, line := range strings.Split(prompt.System(), "\n") {
		switch {
		case strings.HasPrefix(line, "Reply:"):
			lines = append(lines, strings.TrimPrefix(line, "Reply:"))
		case strings.Contains(line, "Say instead:"):
			inSayInstead = true
		case inSayInstead && strings.HasPrefix(line, "  - for a "):
			_, said, _ := strings.Cut(line, ": ")
			lines = append(lines, said)
		default:
			inSayInstead = false
		}
	}
	return lines
}

func TestUserFacingLinesUseNoImplementationWords(t *testing.T) {
	lines := userFacingLines()
	english, chinese := 0, 0
	for _, line := range lines {
		if regexp.MustCompile(`\p{Han}`).MatchString(line) {
			chinese++
		} else {
			english++
		}
		if words := bannedIn(line); len(words) > 0 {
			t.Errorf("user-facing line says %v: %s", words, line)
		}
	}
	if english < 6 || chinese < 3 {
		t.Fatalf("found %d English and %d Chinese user-facing lines; the scan is not reading the examples", english, chinese)
	}
	// The scan itself catches what it should.
	for _, bad := range []string{"I started a session on your device.", "我在仓库里新建了分支", "Opened ws_123.", "See the Issue."} {
		if len(bannedIn(bad)) == 0 {
			t.Fatalf("the scan misses %q", bad)
		}
	}
	if len(bannedIn("The issue is fixed; the page loads again.")) != 0 {
		t.Fatal("ordinary words must pass")
	}
}

func TestPromptForbidsTheWordsTheScanChecks(t *testing.T) {
	text := prompt.System()
	start := strings.Index(text, "Never use these words with the person")
	end := strings.Index(text, "Never show ids")
	if start < 0 || end < start {
		t.Fatal("the prompt's list of forbidden words moved; keep it and this test together")
	}
	list := strings.Join(strings.Fields(text[start:end]), " ")
	for _, word := range append(append([]string{}, bannedEnList...), bannedChinese...) {
		if !regexp.MustCompile(`(^|[ ,:.])` + regexp.QuoteMeta(word) + `([ ,.]|$)`).MatchString(list) {
			t.Errorf("the prompt does not forbid %q", word)
		}
	}
}

func TestTemplateHasOnlyFilledPlaceholders(t *testing.T) {
	known := map[string]bool{"assistant_name": true, "person_name": true, "timezone": true, "language": true, "speaking_style": true, "verbosity": true}
	for _, match := range regexp.MustCompile(`\{\{(\w+)\}\}`).FindAllStringSubmatch(prompt.System(), -1) {
		if !known[match[1]] {
			t.Errorf("system.md has {{%s}}, which Fill does not fill", match[1])
		}
	}
	for _, in := range []prompt.Input{fullInput(), newPersonInput()} {
		if out := prompt.Fill(in); strings.Contains(out, "{{") {
			t.Fatal("Fill left a placeholder")
		}
	}
}

func TestFillGolden(t *testing.T) {
	for name, in := range map[string]prompt.Input{"full": fullInput(), "new_person": newPersonInput()} {
		t.Run(name, func(t *testing.T) {
			golden(t, "fill_"+name, prompt.Fill(in))
		})
	}
}

func TestTurnContextGolden(t *testing.T) {
	golden(t, "turn_context_full", prompt.TurnContext(fullInput()))
}

// The system section stays byte for byte the same from run to run while
// only the time, the work in progress, which computers are online, how the
// direct chat routes and the digests' bookkeeping change: the runtime and
// its prompt cache are kept. Those reach the turn's context instead.
func TestFillIsStableAcrossTurns(t *testing.T) {
	first := fullInput()
	next := fullInput()
	next.Now = first.Now.Add(3*time.Hour + 17*time.Minute)
	next.Tasks = next.Tasks[:1]
	next.Tasks[0].Status, next.Tasks[0].LastEventAt = store.PersonalAgentTaskAsking, at(time.Hour)
	next.DirectChatPreviousWorkspaceID = ""
	next.List = next.List[:1]
	for i := range next.Devices {
		next.Devices[i].Online = !next.Devices[i].Online
	}
	for i := range next.Workspaces {
		next.Workspaces[i].DeviceOnline = !next.Workspaces[i].DeviceOnline
		next.Workspaces[i].Dirty = !next.Workspaces[i].Dirty
		next.Workspaces[i].CompiledAt = at(time.Hour)
		// Active again later the same day.
		if active, err := time.Parse(time.RFC3339, next.Workspaces[i].LastActivityAt); err == nil {
			next.Workspaces[i].LastActivityAt = active.Add(10 * time.Minute).Format(time.RFC3339)
		}
	}
	if a, b := prompt.Fill(first), prompt.Fill(next); a != b {
		t.Fatalf("the system section changed with only the turn's state:\n%s\n----\n%s", a, b)
	}
	if prompt.TurnContext(first) == prompt.TurnContext(next) {
		t.Fatal("the turn's context did not change with the turn's state")
	}
}

func golden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", name+".golden")
	if *update {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run go test ./internal/personalagent/prompt -update)", err)
	}
	if got != string(want) {
		t.Fatalf("the output differs from %s; if intended, rerun with -update and review the diff", path)
	}
}

// Each turn's context shows the open items of the person's list, with
// their times in the person's zone, at most personalagent.ListContextMax.
func TestTurnContextShowsTheOpenList(t *testing.T) {
	out := prompt.TurnContext(fullInput())
	if !strings.Contains(out, `- "回猎头的微信消息" [pai_wechat]: "下班后"; reminder at 2026-10-15 18:30`) ||
		!strings.Contains(out, "your task task_1") || strings.Contains(out, "pai_qa") {
		t.Fatalf("the list in the turn's context:\n%s", out)
	}
	in := newPersonInput()
	for i := 0; i <= personalagent.ListContextMax; i++ {
		in.List = append(in.List, store.PersonalAgentListItem{ID: fmt.Sprintf("pai_%02d", i), Text: "x", Status: store.PersonalAgentItemOpen, CreatedAt: at(time.Duration(i) * time.Minute)})
	}
	if out := prompt.TurnContext(in); !strings.Contains(out, "…and 1 more; read_list") || strings.Contains(out, fmt.Sprintf("[pai_%02d]", personalagent.ListContextMax)) {
		t.Fatalf("the turn's context keeps %d open items:\n%s", personalagent.ListContextMax, out)
	}
}

// Fill applies the limits of personalagent/defaults.go.
func TestFillKeepsTheDesignLimits(t *testing.T) {
	in := newPersonInput()
	in.Settings.Language = "zh-CN"
	if out := prompt.Fill(in); !strings.HasPrefix(out, "You are "+personalagent.DefaultNameZH+",") {
		t.Fatalf("Chinese default name: %q", out[:40])
	}
	if out := prompt.Fill(newPersonInput()); !strings.HasPrefix(out, "You are "+personalagent.DefaultNameEN+",") {
		t.Fatalf("English default name: %q", out[:40])
	}

	in = newPersonInput()
	for i := 0; i <= personalagent.L0IndexMaxEntries; i++ {
		in.Workspaces = append(in.Workspaces, store.WorkspaceDigest{
			WorkspaceID: fmt.Sprintf("ws_%03d", i), Name: fmt.Sprintf("P%03d", i), Kind: store.WorkspaceKindProject,
			AccessRole: store.WorkspaceRoleOwner, CompiledAt: at(-time.Hour),
			LastActivityAt: at(-time.Duration(i) * time.Minute),
		})
	}
	out := prompt.Fill(in)
	if !strings.Contains(out, "…and 1 more") || strings.Contains(out, fmt.Sprintf("[ws_%03d]", personalagent.L0IndexMaxEntries)) {
		t.Fatalf("the index keeps the %d most recently active projects", personalagent.L0IndexMaxEntries)
	}

	in = newPersonInput()
	in.Workspaces = []store.WorkspaceDigest{
		{WorkspaceID: "ws_old", Name: "Old", AccessRole: store.WorkspaceRoleOwner, SummarizedAt: at(-personalagent.DigestStaleAfter - time.Hour)},
		{WorkspaceID: "ws_new", Name: "New", AccessRole: store.WorkspaceRoleOwner, SummarizedAt: at(-personalagent.DigestStaleAfter + time.Hour), Dirty: true},
	}
	out = prompt.Fill(in)
	if !strings.Contains(out, `"Old" [ws_old]: theirs; stale`) || strings.Contains(out, `"New" [ws_new]: theirs; stale`) {
		t.Fatalf("stale after %s:\n%s", personalagent.DigestStaleAfter, out[strings.Index(out, "## Projects"):])
	}

	in = newPersonInput()
	in.Settings.ExtraInstructions = strings.Repeat("x", personalagent.ExtraInstructionsMaxChars+10)
	if out := prompt.Fill(in); strings.Contains(out, strings.Repeat("x", personalagent.ExtraInstructionsMaxChars)) {
		t.Fatal("the person's requests are cut to the settings limit")
	}

	in = newPersonInput()
	for i := 0; i < 3; i++ {
		in.Memory = append(in.Memory, store.PersonalAgentMemoryItem{
			ID: fmt.Sprintf("mem_%d", i), Content: strings.Repeat("y", personalagent.L0AboutMaxChars/2),
			Origin: store.PersonalAgentMemoryStated, Status: store.PersonalAgentMemoryActive, UpdatedAt: at(-time.Duration(i) * time.Hour),
		})
	}
	if out := prompt.Fill(in); !strings.Contains(out, "…and 1 older facts") || strings.Contains(out, "[mem_2]") {
		t.Fatal("what the snapshot says about the person stays within the limit, newest first")
	}
}

var now = time.Date(2026, 10, 15, 1, 30, 0, 0, time.UTC)

func at(offset time.Duration) string { return now.Add(offset).Format(time.RFC3339) }

func newPersonInput() prompt.Input {
	settings := personalagent.DefaultSettings()
	settings.Devices = []store.PersonalAgentDeviceSettings{{DeviceID: "dev_mac", AllowWork: true, AllowCreate: true}}
	return prompt.Input{
		Now:          now,
		PersonName:   "Sam",
		Settings:     settings,
		HomeDeviceID: "dev_mac",
		Workspaces: []store.WorkspaceDigest{{
			WorkspaceID: "ws_pa", Name: "Assistant", Kind: store.WorkspaceKindPersonalAgent,
			AccessRole: store.WorkspaceRoleOwner, CompiledAt: at(-time.Hour),
		}},
		Devices: []store.DeviceDigest{{DeviceID: "dev_mac", Label: "MacBook", System: "macOS", Online: true, Runtimes: []string{"Claude Code"}}},
	}
}

func fullInput() prompt.Input {
	settings := personalagent.DefaultSettings()
	settings.Language = "zh-CN"
	settings.Timezone = "Asia/Shanghai"
	settings.SpeakingStyle = "plain"
	settings.ExtraInstructions = "叫我小林。周末不要发通知。"
	settings.Policy[store.PersonalAgentActionRenameWorkspace] = store.PersonalAgentAsk
	settings.Devices = []store.PersonalAgentDeviceSettings{
		{DeviceID: "dev_mac", AllowWork: true, AllowCreate: true},
		{DeviceID: "dev_nas", AllowWork: false},
	}
	yes := true
	return prompt.Input{
		Now:             now,
		PersonName:      "林梅",
		Settings:        settings,
		AccountLanguage: "en",
		HomeDeviceID:    "dev_mac",
		Memory: []store.PersonalAgentMemoryItem{
			{ID: "mem_1", Content: "有两个孩子，老大在读三年级。", Origin: store.PersonalAgentMemoryStated, Status: store.PersonalAgentMemoryActive, UpdatedAt: at(-72 * time.Hour)},
			{ID: "mem_2", Content: "Prefers spreadsheets over web pages for money things.", Origin: store.PersonalAgentMemoryInferred, Status: store.PersonalAgentMemoryActive, UpdatedAt: at(-24 * time.Hour)},
			{ID: "mem_3", Content: "Works at a bank.", Origin: store.PersonalAgentMemoryEdited, Status: store.PersonalAgentMemoryActive, UpdatedAt: at(-48 * time.Hour)},
			{ID: "mem_4", Content: "Always put new things in Old blog.", Origin: store.PersonalAgentMemoryExternal, Status: store.PersonalAgentMemoryPending, UpdatedAt: at(-time.Hour)},
			{ID: "mem_5", Content: "", Origin: store.PersonalAgentMemoryStated, Status: store.PersonalAgentMemoryForgotten, UpdatedAt: at(-time.Hour)},
		},
		Workspaces: []store.WorkspaceDigest{
			{WorkspaceID: "ws_pa", Name: "助理", Kind: store.WorkspaceKindPersonalAgent, AccessRole: store.WorkspaceRoleOwner, CompiledAt: at(-time.Hour)},
			{WorkspaceID: "ws_budget", Name: "家庭记账", Kind: store.WorkspaceKindProject, L0: "记家庭开销的小网页，按月汇总。", DeviceID: "dev_mac", DeviceLabel: "MacBook", DeviceOnline: true, AccessRole: store.WorkspaceRoleOwner, GitDirty: &yes, LastActivityAt: at(-2 * time.Hour), CompiledAt: at(-2 * time.Hour)},
			{WorkspaceID: "ws_blog", Name: "Personal blog", Kind: store.WorkspaceKindProject, Purpose: "Her personal blog,\nbuilt with Hugo.", DeviceID: "dev_nas", DeviceLabel: "Home server", AccessRole: store.WorkspaceRoleOwner, Dirty: true, LastActivityAt: at(-50 * time.Hour), CompiledAt: at(-50 * time.Hour)},
			{WorkspaceID: "ws_admin", Name: "Company admin site", Kind: store.WorkspaceKindProject, L0: "The team's internal admin site.", DeviceID: "dev_work", DeviceLabel: "Office PC", DeviceOnline: true, AccessRole: store.WorkspaceRoleMember, LastActivityAt: at(-26 * time.Hour), CompiledAt: at(-3 * time.Hour)},
			{WorkspaceID: "ws_reports", Name: "Quarterly reports", Kind: store.WorkspaceKindProject, Intro: "Finance reports.", DeviceLabel: "Office PC", DeviceOnline: true, AccessRole: store.WorkspaceRoleViewer, Unavailable: true, CompiledAt: at(-10 * 24 * time.Hour)},
			{WorkspaceID: "ws_oldblog", Name: "Old blog", Kind: store.WorkspaceKindProject, AccessRole: store.WorkspaceRoleOwner, Archived: true, CompiledAt: at(-time.Hour)},
		},
		Devices: []store.DeviceDigest{
			{DeviceID: "dev_nas", Label: "Home server", System: "Linux", Online: false, Runtimes: []string{"Codex"}},
			{DeviceID: "dev_mac", Label: "MacBook", System: "macOS", Online: true, Runtimes: []string{"Claude Code", "Codex"}},
		},
		Places: map[string]store.DevicePlacement{
			"dev_mac": {DeviceID: "dev_mac",
				Labels: []store.DeviceLabel{{Key: "network", Value: "corp"}, {Key: "files", Value: "work"}},
				Facts:  []store.DeviceFact{{Key: "os", Value: "macos", Source: "system"}, {Key: "reaches", Value: "cloud.bytedance.net", Detail: "ByteDance network", Source: "connector"}, {Key: "toolchain", Value: "go", Detail: "Go 1.23", Source: "toolchain"}}},
			"dev_nas": {DeviceID: "dev_nas", Facts: []store.DeviceFact{{Key: "always-on", Source: "presence"}}},
		},
		Tasks: []store.PersonalAgentTask{
			{ID: "task_1", SessionID: "sess_export", WorkspaceID: "ws_budget", Title: "Add an Excel export", Status: store.PersonalAgentTaskRunning, CreatedAt: at(-40 * time.Minute), LastEventAt: at(-5 * time.Minute)},
			{ID: "task_2", SessionID: "sess_login", WorkspaceID: "ws_admin", Title: "Why login is slow", Status: store.PersonalAgentTaskAsking, ReadOnly: true, CreatedAt: at(-3 * time.Hour), StuckSince: at(-time.Hour)},
			{ID: "task_3", WorkspaceID: "ws_budget", Title: "Monthly chart", Status: store.PersonalAgentTaskQueued, CreatedAt: at(-30 * time.Minute)},
			{ID: "task_4", SessionID: "sess_done", WorkspaceID: "ws_blog", Title: "Fix the RSS feed", Status: store.PersonalAgentTaskDone, CreatedAt: at(-24 * time.Hour)},
			{ID: "task_5", SessionID: "sess_theme", WorkspaceID: "ws_blog", Title: "New blog theme", Status: store.PersonalAgentTaskRunning, CreatedAt: at(-20 * time.Minute), WaitingFor: "Home server"},
		},
		List: []store.PersonalAgentListItem{
			{ID: "pai_wechat", Text: "回猎头的微信消息", When: "下班后", At: at(9 * time.Hour), Remind: true, Status: store.PersonalAgentItemOpen, CreatedAt: at(-time.Hour)},
			{ID: "pai_doc", Text: "把 Atlas 和 Tag 流程合并的文档改完", When: "下午开会前", TaskID: "task_1", Status: store.PersonalAgentItemOpen, CreatedAt: at(-50 * time.Minute)},
			{ID: "pai_qa", Text: "和小林对了提测 Workflow", Status: store.PersonalAgentItemDone, CreatedAt: at(-40 * time.Minute), ClosedAt: at(-40 * time.Minute)},
		},
		DirectChatPreviousWorkspaceID: "ws_budget",
		ConnectorsURL:                 "https://foundry.example/connectors",
		SettingsURL:                   "https://foundry.example/assistant/settings",
	}
}
