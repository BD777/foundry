package prompt_test

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/workspacedigest"
)

var update = flag.Bool("update", false, "rewrite testdata/*.golden from the outputs")

// Every prompt version's hash. Before 2026-11-12.5 the digest covered
// system.md alone; from that version it covers system.md and every skill.
// Changing any instruction fails here until it gets a new Version and line.
var promptVersions = map[string]string{
	"2026-11-12.6": "333a8cd9404227cc6df7ad6572514daeb3533be32fe54c2cb80f48a894ecbbf4", // DEV-197 B1: report blockers plainly; asking remains the executor's choice
	"2026-11-13.2": "d7f4798c007177e262b7e1944ffaedf267b0f2d216b906a5aeaac3e6b95b7ff3", // DEV-200 follow-up: check needs-you items before their deadline (DEV-199 B3)
	"2026-11-13.1": "42fb0be72eaf05d1604d26d19a91ce47312b897e8c1b5adfed8e5e469bb38754", // DEV-200: no per-turn guidance; rules and confirmed facts in AGENTS.md, notices are facts
	"2026-11-12.5": "bdcca1d4c2751dec05b826cec46c91cc46875a623f32fa57bf8ab78f810e1e75", // progressive disclosure: short core plus three assistant skills
	"2026-11-12.4": "8ea02a38cff4ed22e6c314a221957065c5e8672e172d12d000c0fe033c054141", // slim the assistant prompt: tool mechanics live in tool descriptions; 31KB → 15.5KB
	"2026-11-12.3": "724e990d1ec63d55ec24e653f73ba00d1d968e6cf764f403a71509dded298aa5", // DEV-191 v1b: fit the per-assistant settings link within the AGENTS.md limit
	"2026-11-12.2": "97d1dab13c7a1a13c37073aba25036d9d3e964ebee3b49c0f8e91e6a0872f392", // DEV-191 P2: two memory layers, unconfirmed facts are not kept
	"2026-11-12.1": "ea64a17c0f1471f28ed3b14b2a90d757ad5c32e60035510b9778dfebcbb30e29", // executor defaults and configured alternatives
	"2026-11-10.2": "03ec0bea5367e340fd8cc92d84ca8ad9d6afbed85bc2191c0bcfead809b1e792", // project index opens each conversation
	"2026-11-10.1": "7c7e2555657dac302e514781dac1ec3fabe88ab1ee9c921a3c1f5d2705a70568", // device removal always asks
	"2026-10-30.1": "3598a48427e1294664fa26b93cbce452055d31c7b287223a49514a50eed3c0ff",
	"2026-10-30.2": "26c1ca07ffc97e094070c94b3afc42d479c379f9865e119f79ec41ac47ef0111",
	"2026-11-02.1": "f0e5324dd1ffb2d06d45285d9d8b3008424b853f954c16d152a6d4394673ce20", // DEV-109: instructions as the folder's AGENTS.md, what it knows in the turn's context
	"2026-11-09.1": "f08d11510e01af7238a505d387187efcefeb10dc458b095995902381f6e642f2", // DEV-152: helpers' questions answered or handed to the person with needs_you
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
	got := prompt.ContentDigest()
	want, ok := promptVersions[prompt.Version]
	if !ok || want != got {
		t.Fatalf("the instructions (sha256 %s) are not recorded as %s: bump prompt.Version and add it to promptVersions", got, prompt.Version)
	}
}

// The embedded files are valid Agent Skills: their frontmatter names the
// directory, and each description is short enough for native discovery.
func TestAssistantSkillsHaveValidFrontmatter(t *testing.T) {
	skills := prompt.AssistantSkills()
	if len(skills) != 3 {
		t.Fatalf("embedded %d assistant skills, want 3", len(skills))
	}
	for _, skill := range skills {
		name, description, ok := frontmatter(skill.Content)
		if !ok {
			t.Errorf("%s has no valid frontmatter", skill.Name)
			continue
		}
		if name != skill.Name {
			t.Errorf("%s frontmatter names %q", skill.Name, name)
		}
		if pathName := strings.Split(strings.TrimPrefix(prompt.AssistantSkillPath(skill.Name), prompt.AssistantSkillsPath+"/"), "/")[0]; pathName != skill.Name {
			t.Errorf("%s is stored under %q", skill.Name, pathName)
		}
		if description == "" {
			t.Errorf("%s has no description", skill.Name)
		}
		if size := utf8.RuneCountInString(description); size >= 1024 {
			t.Errorf("%s description has %d characters, want fewer than 1024", skill.Name, size)
		}
	}
}

func frontmatter(content string) (name, description string, ok bool) {
	if !strings.HasPrefix(content, "---\n") {
		return "", "", false
	}
	rest := strings.TrimPrefix(content, "---\n")
	front, _, found := strings.Cut(rest, "\n---\n")
	if !found {
		return "", "", false
	}
	for _, line := range strings.Split(front, "\n") {
		switch {
		case strings.HasPrefix(line, "name: "):
			name = strings.TrimSpace(strings.TrimPrefix(line, "name: "))
		case strings.HasPrefix(line, "description: "):
			description = strings.TrimSpace(strings.TrimPrefix(line, "description: "))
		}
	}
	return name, description, name != "" && description != ""
}

// The words a non-technical person should never meet (§1, §13), as the
// prompt lists them.
var (
	bannedEnglish = regexp.MustCompile(`(?i)\b(workspaces?|devices?|sessions?|repos?|repositor(?:y|ies)|branch(?:es)?|commits?|profiles?|runtimes?|models?|mcp|tokens?|agents?|prompts?|director(?:y|ies)|paths?|claude|codex)\b`)
	// "issue" is an ordinary word; Foundry's Issue is capitalised.
	bannedIssue   = regexp.MustCompile(`\bIssues?\b`)
	bannedEnList  = []string{"workspace", "device", "session", "repo", "branch", "commit", "Issue", "profile", "runtime", "model", "MCP", "token", "agent", "prompt", "path"}
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

// userFacingLines are the instructions' lines the assistant would say in
// plain words. The one example after "they used technical words" may mirror
// them.
func userFacingLines(text string) []string {
	lines := []string{}
	inSayInstead := false
	mirroringTechnicalWords := false
	for _, line := range strings.Split(text, "\n") {
		switch {
		case strings.HasPrefix(line, "You:"):
			mirroringTechnicalWords = strings.Contains(line, "technical words")
		case strings.HasPrefix(line, "Reply:"):
			if !mirroringTechnicalWords {
				lines = append(lines, strings.TrimPrefix(line, "Reply:"))
			}
			mirroringTechnicalWords = false
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

func promptTexts() []string {
	texts := []string{prompt.System()}
	for _, skill := range prompt.AssistantSkills() {
		texts = append(texts, skill.Content)
	}
	return texts
}

func TestUserFacingLinesUseNoImplementationWords(t *testing.T) {
	lines := []string{}
	for _, text := range promptTexts() {
		lines = append(lines, userFacingLines(text)...)
	}
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
	if english < 3 || chinese < 2 {
		t.Fatalf("found %d English and %d Chinese user-facing lines; the scan is not reading all examples", english, chinese)
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
	start := strings.Index(text, "Never introduce technical words they did not use first")
	end := strings.Index(text, "Never show ids")
	if start < 0 || end < start {
		t.Fatal("the prompt's list of forbidden words moved; keep it and this test together")
	}
	list := strings.Join(strings.Fields(text[start:end]), " ")
	for _, word := range append(append([]string{}, bannedEnList...), bannedChinese...) {
		if !regexp.MustCompile(`(^|[ ,.:()])` + regexp.QuoteMeta(word) + `([ ,.:()]|$)`).MatchString(list) {
			t.Errorf("the prompt does not forbid %q", word)
		}
	}
}

func TestTemplateHasOnlyFilledPlaceholders(t *testing.T) {
	known := map[string]bool{"assistant_name": true, "person_name": true, "timezone": true, "language": true, "speaking_style": true, "verbosity": true}
	for _, match := range regexp.MustCompile(`\{\{(\w+)\}\}`).FindAllStringSubmatch(prompt.System(), -1) {
		if !known[match[1]] {
			t.Errorf("system.md has {{%s}}, which AgentsFile does not fill", match[1])
		}
	}
	for _, in := range []prompt.Input{fullInput(), newPersonInput()} {
		if out := prompt.AgentsFile(in) + prompt.ExamplesFile(in); strings.Contains(out, "{{") {
			t.Fatal("a placeholder was left")
		}
	}
}

func TestAgentsFileGolden(t *testing.T) {
	for name, in := range map[string]prompt.Input{"full": fullInput(), "new_person": newPersonInput()} {
		t.Run(name, func(t *testing.T) {
			golden(t, "agents_"+name, prompt.AgentsFile(in))
		})
	}
}

func TestRunFilesIncludeTheAssistantSkills(t *testing.T) {
	files := prompt.RunFiles(fullInput())
	got := map[string]string{}
	for _, file := range files {
		got[file.Path] = file.Content
	}
	for _, path := range []string{"AGENTS.md", prompt.ExamplesPath, prompt.ProjectIndexPath} {
		if _, ok := got[path]; !ok {
			t.Errorf("run files lack %s", path)
		}
	}
	for _, skill := range prompt.AssistantSkills() {
		path := prompt.AssistantSkillPath(skill.Name)
		if got[path] != skill.Content {
			t.Errorf("run files lack the embedded content at %s", path)
		}
	}
	if len(files) != 3+len(prompt.AssistantSkills()) {
		t.Fatalf("run files contain %d entries", len(files))
	}
}

func TestTurnContextGolden(t *testing.T) {
	golden(t, "turn_context_full", prompt.TurnContext(fullInput()))
}

// The project index is a file AGENTS.md points to, not part of any turn.
func TestProjectIndexIsAFileAGENTSPointsTo(t *testing.T) {
	in := fullInput()
	index := prompt.ProjectIndexFile(in)
	for _, line := range []string{"As of 2026-10-15 09:30;", "- 『家庭记账』 (ws_budget)", "- 『Personal blog』 (ws_blog)"} {
		if !strings.Contains(index, line) {
			t.Errorf("the project index lacks %q:\n%s", line, index)
		}
	}
	if !strings.Contains(prompt.AgentsFile(in), prompt.ProjectIndexPath) || strings.Contains(prompt.AgentsFile(in), "ws_blog") {
		t.Fatal("AGENTS.md should point to the project index, not hold it")
	}
	if strings.Contains(prompt.TurnContext(in), "ws_budget") {
		t.Fatal("the turn's context carries the index")
	}
	if got := prompt.ProjectIndexFile(newPersonInput()); !strings.Contains(got, "No projects yet.") {
		t.Fatalf("empty index: %q", got)
	}
}

func TestComputersGolden(t *testing.T) {
	golden(t, "computers_full", prompt.Computers(fullInput()))
}

// AGENTS.md carries what lasts: the person's rules and the facts they
// confirmed, loaded natively once per conversation. It never carries live
// state (the time, which computers are online, the project index), so it
// does not change between turns that change only that state.
func TestAgentsFileHoldsTheRulesAndConfirmedFacts(t *testing.T) {
	in := fullInput()
	file := prompt.AgentsFile(in)
	for _, shown := range []string{
		"# The person's rules", "叫我小林。周末不要发通知。",
		"- the person confirms first: use a folder of theirs outside the managed folders; rename a project or restate its purpose;",
		"# What the person confirmed (newest first)", "有两个孩子", "Works at a bank. (they wrote it in settings",
		"Before you took over their Feishu direct chat it went to \"家庭记账\" (ws_budget)",
		prompt.ProjectIndexPath, prompt.ExamplesPath,
	} {
		if !strings.Contains(file, shown) {
			t.Errorf("AGENTS.md lacks %q", shown)
		}
	}
	for _, absent := range []string{"Always put new things in Old blog", "Home server", "intranet.corp.example", "Quarterly reports", "2026-10-15 09:30", "Person: \""} {
		if strings.Contains(file, absent) {
			t.Errorf("AGENTS.md holds %q", absent)
		}
	}
	next := fullInput()
	next.Now = in.Now.Add(3 * time.Hour)
	next.Devices, next.Places, next.L0Index = nil, nil, ""
	if prompt.AgentsFile(next) != file {
		t.Fatal("AGENTS.md changed with live state")
	}
	if examples := prompt.ExamplesFile(in); !strings.HasPrefix(examples, "# Examples\n") || !strings.Contains(examples, "Person: \"") {
		t.Fatalf("examples file: %.80q", examples)
	}
}

// agentsFileBudget is the size of the typical AGENTS.md (fullInput) before
// the rules and confirmed facts moved into it (DEV-196, 7840 bytes): moving
// them must not make the file larger.
const agentsFileBudget = 7840

func TestAgentsFileStaysWithinItsBudget(t *testing.T) {
	size := len(prompt.AgentsFile(fullInput()))
	t.Logf("AGENTS.md (typical) is %d bytes", size)
	if size > agentsFileBudget {
		t.Fatalf("AGENTS.md is %d bytes, more than its budget of %d", size, agentsFileBudget)
	}
}

// The turn's context is facts only: the time in the person's zone (and a
// receipt the caller adds). No guidance, no live state.
func TestTurnContextCarriesNoGuidance(t *testing.T) {
	out := prompt.TurnContext(fullInput())
	want := prompt.TurnContextStart + "\nNow: Thursday, 2026-10-15 09:30 (Asia/Shanghai).\n" + prompt.TurnContextEnd
	if out != want {
		t.Fatalf("turn context:\n%s", out)
	}
	for _, phrase := range []string{"follow them", "act on them", "never", "Never", "you can plan", "should", "must", "Tell ", "tell ", "ask ", "Ask ", "remember", "Learn as you go", "read_list", "update_list", "needs_you"} {
		if strings.Contains(out, phrase) {
			t.Errorf("the turn's context says %q", phrase)
		}
	}
}

// Codex reads at most 32 KiB of AGENTS.md in all; the assistant's must
// leave room for the person's own global one.
func TestAgentsFileFitsCodexsLimit(t *testing.T) {
	in := fullInput()
	in.Settings.AssistantName = strings.Repeat("名", 60)
	in.PersonName = strings.Repeat("名", 60)
	in.Settings.ExtraInstructions = strings.Repeat("规", personalagent.ExtraInstructionsMaxChars)
	for i := 0; i < 40; i++ {
		in.Memory = append(in.Memory, store.PersonalAgentMemoryItem{ID: fmt.Sprintf("mem_w%d", i), Content: strings.Repeat("记", 60),
			Origin: store.PersonalAgentMemoryStated, Status: store.PersonalAgentMemoryActive, Scope: store.MemoryScopePerson, UpdatedAt: at(-time.Duration(i) * time.Hour)})
	}
	size := len(prompt.AgentsFile(in))
	t.Logf("AGENTS.md is %d bytes", size)
	if size > prompt.AgentsFileMaxBytes {
		t.Fatalf("AGENTS.md is %d bytes, more than %d", size, prompt.AgentsFileMaxBytes)
	}
}

// The limits of personalagent/defaults.go hold.
func TestTheDesignLimitsHold(t *testing.T) {
	in := newPersonInput()
	in.Settings.Language = "zh-CN"
	if out := prompt.AgentsFile(in); !strings.HasPrefix(out, "You are "+personalagent.DefaultNameZH+",") {
		t.Fatalf("Chinese default name: %q", out[:40])
	}
	if out := prompt.AgentsFile(newPersonInput()); !strings.HasPrefix(out, "You are "+personalagent.DefaultNameEN+",") {
		t.Fatalf("English default name: %q", out[:40])
	}

	in = newPersonInput()
	in.Settings.ExtraInstructions = strings.Repeat("x", personalagent.ExtraInstructionsMaxChars+10)
	if out := prompt.AgentsFile(in); strings.Contains(out, strings.Repeat("x", personalagent.ExtraInstructionsMaxChars)) {
		t.Fatal("the person's requests are cut to the settings limit")
	}

	in = newPersonInput()
	for i := 0; i < 3; i++ {
		in.Memory = append(in.Memory, store.PersonalAgentMemoryItem{
			ID: fmt.Sprintf("mem_%d", i), Content: strings.Repeat("y", personalagent.L0AboutMaxChars/2),
			Origin: store.PersonalAgentMemoryStated, Status: store.PersonalAgentMemoryActive, UpdatedAt: at(-time.Duration(i) * time.Hour),
		})
	}
	if out := prompt.AgentsFile(in); !strings.Contains(out, "…and 1 older facts: read_memory") || strings.Contains(out, "[mem_2]") {
		t.Fatal("what AGENTS.md says about the person stays within the limit, newest first")
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
	in := prompt.Input{
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
				Facts:  []store.DeviceFact{{Key: "os", Value: "macos", Source: "system"}, {Key: "reaches", Value: "intranet.corp.example", Detail: "Corp network", Source: "connector"}, {Key: "toolchain", Value: "go", Detail: "Go 1.23", Source: "toolchain"}}},
			"dev_nas": {DeviceID: "dev_nas", Facts: []store.DeviceFact{{Key: "always-on", Source: "presence"}}},
		},
		DirectChatPreviousWorkspaceID: "ws_budget",
		ConnectorsURL:                 "https://foundry.example/connectors",
		SettingsURL:                   "https://foundry.example/assistants/asst_work/settings",
	}
	in.L0Index = workspacedigest.Index(in.Workspaces, in.Devices, in.Now)
	return in
}
