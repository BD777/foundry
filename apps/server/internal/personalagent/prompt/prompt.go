// Package prompt is the Personal Agent's instructions (docs/personal-agent.md
// §12): system.md and the assistant's skills, embedded and versioned.
// AgentsFile fills system.md with the assistant's settings, the person's
// rules and the facts they confirmed into the AGENTS.md Foundry writes into
// the assistant's folder, which Claude Code and Codex load natively at the
// start of a conversation. RunFiles also supplies the project index
// (ProjectIndexPath), one summary file per project (.foundry/projects/),
// the worked examples and the canonical skill files that the Worker exposes
// to both runtimes. Foundry injects no guidance per turn:
// TurnContext is one line with the time in the person's zone (the runtime
// does not know it) and, for a captured message, its receipt. Live state
// (computers, the list, followed work, what waits for the person) comes
// from tools when the assistant needs it (list_computers: Computers).
//
// The few limits it applies mirror personalagent/defaults.go (prompt_test
// checks they agree).
package prompt

import (
	"cmp"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

//go:embed system.md
var system string

//go:embed skills/assistant-handoff/SKILL.md
var assistantHandoffSkill string

//go:embed skills/assistant-memory-and-list/SKILL.md
var assistantMemoryAndListSkill string

//go:embed skills/assistant-projects/SKILL.md
var assistantProjectsSkill string

// Version names these embedded instructions; it is stored as each assistant's
// prompt_version. Bump it whenever the system prompt or a skill changes
// (prompt_test holds the digest of every version).
const Version = "2026-11-23.2"

// AssistantSkillsPath is where Foundry keeps the canonical skill files in the
// assistant's folder. It is outside the workspace-draft roots; the Worker
// links these directories into each runtime's native discovery path.
const AssistantSkillsPath = ".foundry/assistant-skills"

// AssistantSkill is one embedded Agent Skill.
type AssistantSkill struct {
	Name    string
	Content string
}

var assistantSkills = []AssistantSkill{
	{Name: "assistant-handoff", Content: assistantHandoffSkill},
	{Name: "assistant-memory-and-list", Content: assistantMemoryAndListSkill},
	{Name: "assistant-projects", Content: assistantProjectsSkill},
}

// Limits mirrored from personalagent/defaults.go.
const (
	aboutMaxChars    = 2000
	extraMaxChars    = 2000
	defaultNameZH    = "助理"
	defaultNameEN    = "Assistant"
	timeLayout       = "2006-01-02 15:04"
	dateLayout       = "2006-01-02"
	headerDateLayout = "Monday, 2006-01-02"
	examplesHeading  = "\n# Examples\n"
)

// ExamplesPath is where in the assistant's folder Foundry writes
// ExamplesFile; AGENTS.md points there.
const ExamplesPath = ".foundry/assistant-examples.md"

// ProjectIndexPath is where Foundry writes ProjectIndexFile, the project and
// device index as of the run; AGENTS.md points there.
const ProjectIndexPath = ".foundry/project-index.md"

// UpkeepPath is where Foundry writes UpkeepFile, the upkeep facts as of the
// run (proposals waiting for the person, failed or stalled reviews, due
// summaries); the managed block points there.
const UpkeepPath = ".foundry/upkeep.md"

// AgentsFileMaxBytes bounds AgentsFile: Codex reads at most 32 KiB of
// AGENTS.md files in all (project_doc_max_bytes), the person's own global
// one included.
const AgentsFileMaxBytes = 28 * 1024

// Input is everything the assistant's instructions and turn context are
// made from. Pass records as stored: what is shown (active memory) is
// picked, ordered and capped here.
type Input struct {
	// Now is when the turn starts.
	Now time.Time
	// PersonName is how the assistant names the person (display name).
	PersonName string
	// Settings are the assistant's settings with the server's defaults
	// applied (Policy names every managed action). Empty AssistantName,
	// Language and Timezone fall back as the protocol says.
	Settings store.PersonalAgentSettings
	// AccountLanguage is the person's account language, used when
	// Settings.Language is empty.
	AccountLanguage string
	// HomeDeviceID is the device the assistant's folder is on.
	HomeDeviceID string
	// Memory is what the assistant recalls of its memory layers (the
	// person's and its own, DEV-191 P2); only active ones are shown.
	Memory []store.PersonalAgentMemoryItem
	// Workspaces are the person's workspace digests (WP-S2); the assistant's
	// own and archived ones are left out.
	Workspaces []store.WorkspaceDigest
	// Devices are the digests of the devices the person owns.
	Devices []store.DeviceDigest
	// Channels are the assistant's message channels whose workspace is on
	// its home device: each has its own folder and its own AGENTS.md, whose
	// rules its sessions follow (DEV-251).
	Channels []ChannelPlace
	// L0Index is the current project and device index, already limited by
	// personalagent.L0IndexMaxEntries and personalagent.L0IndexMaxTokens.
	L0Index string
	// ProjectFiles are one summary file per project, .foundry/projects/,
	// with their manifest; the runtime reads them natively.
	ProjectFiles []personalagent.WorkspaceFile
	// Upkeep is the content of UpkeepPath for this run; empty when the run
	// writes no such file (a channel workspace).
	Upkeep string
	// Places are those devices' labels and detected facts, by device id.
	Places map[string]store.DevicePlacement
	// MemoryPublications are the ids of the confirmed-memory publications
	// the assistant may read with read_knowledge.
	MemoryPublications []string
	// ConnectorsURL and SettingsURL are the Foundry pages where the person
	// connects their accounts (Feishu and other sign-ins) and changes the
	// assistant's settings. Empty: not shown.
	ConnectorsURL string
	SettingsURL   string
	// OtherAssistants are the person's other active assistants (D1): what
	// each is in charge of and how a message reaches it.
	OtherAssistants []AssistantPlace
	// DirectChatPreviousWorkspaceID is where the person's Feishu direct chat
	// went before the assistant took it over (§14): the routing prior when
	// nothing else points elsewhere. Empty: none.
	DirectChatPreviousWorkspaceID string
}

// ChannelPlace is one of the assistant's message channels as its
// instructions name it: the person's name for it and the folder its
// sessions run in, on the assistant's home device.
type ChannelPlace struct {
	Name string
	Path string
}

// AssistantPlace is another of the person's assistants as this one's
// instructions name it: its label, what the person put it in charge of
// (settings) and the home conversation they used last, "" when none.
type AssistantPlace struct {
	Name           string
	Default        bool
	Responsibility string
	ConversationID string
}

// System is system.md as embedded, placeholders unfilled.
func System() string { return system }

// AssistantSkills are the embedded Agent Skills, in stable order.
func AssistantSkills() []AssistantSkill {
	return append([]AssistantSkill(nil), assistantSkills...)
}

// AssistantSkillPath is a skill's canonical SKILL.md path in the assistant's
// folder.
func AssistantSkillPath(name string) string {
	return AssistantSkillsPath + "/" + name + "/SKILL.md"
}

// ContentDigest covers system.md and every embedded skill. It identifies the
// complete instruction set, not only the main prompt file.
func ContentDigest() string {
	sum := sha256.New()
	writeDigestPart := func(path, content string) {
		fmt.Fprintf(sum, "%s\x00%d\x00", path, len(content))
		sum.Write([]byte(content))
	}
	writeDigestPart("system.md", system)
	for _, skill := range assistantSkills {
		writeDigestPart(AssistantSkillPath(skill.Name), skill.Content)
	}
	return hex.EncodeToString(sum.Sum(nil))
}

// The assistant's AGENTS.md is two parts (DEV-223). On top, Foundry's
// managed block (ManagedBlock): who the assistant is for (from its
// settings), the person's rules, the facts they confirmed and the pages
// they can open, rewritten before each run. Below it, the instructions,
// which are the person's: seeded once from DefaultInstructions, then edited
// by them in the Web or by the assistant when they ask; Foundry never
// rewrites them. A newer DefaultInstructions is offered to the person, not
// applied.
const (
	ManagedBlockStart = "<!-- foundry:managed:start (Foundry rewrites this block before each conversation; the rest is the person's) -->"
	ManagedBlockEnd   = "<!-- foundry:managed:end -->"
)

// DefaultInstructions are the instructions an assistant's AGENTS.md starts
// with below the managed block: system.md after its opening lines, without
// the worked examples (ExamplesFile).
func DefaultInstructions() string {
	_, rest, _ := strings.Cut(system, "\n\n")
	body, _, _ := strings.Cut(rest, examplesHeading)
	return strings.TrimSpace(body) + "\n"
}

// DefaultInstructionsSha256 names DefaultInstructions, to tell the person
// when a newer default is there.
func DefaultInstructionsSha256() string {
	sum := sha256.Sum256([]byte(DefaultInstructions()))
	return hex.EncodeToString(sum[:])
}

// ManagedBlock is Foundry's block of AGENTS.md, markers included: the
// assistant's identity filled from its settings, then the person's rules,
// the facts they confirmed and the pages they can open. It changes with
// those, not with live state, so a conversation's runtime loads it once,
// natively.
func ManagedBlock(in Input) string {
	identity, _, _ := strings.Cut(filled(in), "\n\n")
	var out strings.Builder
	out.WriteString(ManagedBlockStart + "\n")
	out.WriteString(strings.TrimRight(identity, "\n"))
	out.WriteString("\n")
	if len(in.Channels) > 0 {
		out.WriteString("\n# Message channels\n\n")
		out.WriteString("Each channel's folder has its own AGENTS.md, whose rules its sessions follow; those rules are separate from this file.\n\n")
		for _, channel := range in.Channels {
			fmt.Fprintf(&out, "- 「%s」: %s\n", channel.Name, channel.Path)
		}
	}
	writeAssistants(&out, in)
	writeRules(&out, in)
	out.WriteString("\n# What the person confirmed (newest first)\n\n")
	writeMemory(&out, in.Memory, timeLocation(in))
	for _, id := range in.MemoryPublications {
		fmt.Fprintf(&out, "Their confirmed memory is also a publication: read_knowledge publicationId %s.\n", id)
	}
	out.WriteString("\n# Where the upkeep facts are\n\n")
	fmt.Fprintf(&out, "- %s: suggested changes waiting for them, failed or stalled reviews, and summaries that are due.\n", UpkeepPath)
	names := map[string]string{}
	for _, digest := range in.Workspaces {
		names[digest.WorkspaceID] = digest.Name
	}
	if id := in.DirectChatPreviousWorkspaceID; id != "" && names[id] != "" {
		fmt.Fprintf(&out, "\nBefore you took over their Feishu direct chat it went to %s (%s): work asked for there\nbelongs there when nothing else points elsewhere.\n", quote(names[id]), id)
	}
	if in.ConnectorsURL != "" || in.SettingsURL != "" {
		out.WriteString("\n# Pages the person can open\n\n")
		if in.ConnectorsURL != "" {
			fmt.Fprintf(&out, "- Connecting their accounts (Feishu and other sign-ins): %s\n", in.ConnectorsURL)
		}
		if in.SettingsURL != "" {
			fmt.Fprintf(&out, "- Your settings, limits and what you remember: %s\n", in.SettingsURL)
		}
	}
	out.WriteString(ManagedBlockEnd)
	return out.String()
}

// AgentsFile is the whole AGENTS.md of an assistant whose instructions are
// still the default: the managed block, then DefaultInstructions. A Worker
// without assistant_instructions_block gets it whole before each run.
func AgentsFile(in Input) string {
	return ManagedBlock(in) + "\n\n" + DefaultInstructions()
}

// InitialAgentsFile is the AGENTS.md a new assistant folder starts with:
// an empty managed block, which its first run fills, and the default
// instructions.
func InitialAgentsFile() string {
	return JoinAgentsFile(ManagedBlockStart+"\n"+ManagedBlockEnd, DefaultInstructions())
}

// SplitAgentsFile parses an AGENTS.md into the managed block (markers
// included; "" when it has none) and the rest, the person's instructions.
func SplitAgentsFile(content string) (block, instructions string) {
	start := strings.Index(content, managedBlockMarker)
	if start < 0 {
		return "", content
	}
	end := strings.Index(content[start:], ManagedBlockEnd)
	if end < 0 {
		return "", content
	}
	end += start + len(ManagedBlockEnd)
	rest := content[:start] + strings.TrimLeft(content[end:], "\n")
	return content[start:end], rest
}

// JoinAgentsFile is AGENTS.md with the block on top of the instructions.
func JoinAgentsFile(block, instructions string) string {
	return strings.TrimRight(block, "\n") + "\n\n" + strings.TrimLeft(instructions, "\n")
}

// managedBlockMarker starts every version of the block's start marker.
const managedBlockMarker = "<!-- foundry:managed:start"

// writeAssistants is what the person put each of their assistants in charge
// of, and how a message reaches the others: facts from their settings.
// Nothing when they have one assistant and set nothing.
func writeAssistants(out *strings.Builder, in Input) {
	own := oneLine(in.Settings.Responsibility)
	if own == "" && len(in.OtherAssistants) == 0 {
		return
	}
	out.WriteString("\n# What the person's assistants are in charge of (their settings)\n\n")
	fmt.Fprintf(out, "- You: %s\n", cmp.Or(own, "not set"))
	for _, other := range in.OtherAssistants {
		name := oneLine(other.Name)
		switch {
		case name == "" && other.Default:
			name = "the default assistant"
		case name == "":
			name = "an assistant without a name"
		default:
			name = "「" + name + "」"
		}
		conversation := "none yet"
		if other.ConversationID != "" {
			conversation = other.ConversationID
		}
		fmt.Fprintf(out, "- %s: %s (the conversation they used last: %s)\n", name, cmp.Or(oneLine(other.Responsibility), "not set"), conversation)
	}
	if len(in.OtherAssistants) > 0 {
		out.WriteString("Each assistant works within its own permissions, projects and accounts; send_message to\nanother's conversation reaches it.\n")
	}
}

// writeRules is the person's own requests from the settings and when
// Foundry asks them first, grouped by decision.
func writeRules(out *strings.Builder, in Input) {
	out.WriteString("\n# The person's rules\n\n")
	if extra := strings.TrimSpace(in.Settings.ExtraInstructions); extra != "" {
		out.WriteString("Their own requests, from your settings (they apply unless they conflict with your\ninstructions below or with privacy and safety):\n\n")
		out.WriteString(textcut.Excerpt(extra, extraMaxChars))
		out.WriteString("\n\n")
	}
	out.WriteString("When Foundry asks them first (Foundry enforces this):\n")
	groups := map[string][]string{}
	for _, action := range store.PersonalAgentActions {
		label := decisionLabel(in.Settings.Policy[action])
		groups[label] = append(groups[label], actionLabels[action])
	}
	for _, label := range []string{decisionLabel(store.PersonalAgentAuto), decisionLabel(store.PersonalAgentAsk), decisionLabel(store.PersonalAgentDeny), decisionLabel("")} {
		if actions := groups[label]; len(actions) > 0 {
			fmt.Fprintf(out, "- %s: %s\n", label, strings.Join(actions, "; "))
		}
	}
	out.WriteString("- never, whatever the rules: delete anything, share with other people, change a computer's\n  settings, change a project the person does not own\n")
}

// ProjectIndexFile is the project and device index as of the run (L0Index),
// which AGENTS.md points to; each project's summary is its own file in
// .foundry/projects/, and get_workspace reads the current state.
func ProjectIndexFile(in Input) string {
	index := strings.TrimSpace(in.L0Index)
	if index == "" {
		index = "No projects yet."
	}
	return fmt.Sprintf("# Projects and computers\n\nAs of %s; each project's full summary is in .foundry/projects/, and get_workspace reads the current state.\n\n%s\n",
		in.Now.In(timeLocation(in)).Format(timeLayout), index)
}

// ExamplesFile is system.md's worked examples, filled like AgentsFile.
func ExamplesFile(in Input) string {
	_, examples, ok := strings.Cut(filled(in), examplesHeading)
	if !ok {
		return ""
	}
	return "# Examples\n" + examples
}

// ChannelClaudePath is the generated CLAUDE.md of a channel workspace.
// Claude Code runs a channel session with instructionFiles "claude-md", so
// it loads CLAUDE.md only and not the assistant home's AGENTS.md above it;
// this file imports the channel's own AGENTS.md (DEV-251).
const ChannelClaudePath = "CLAUDE.md"

// ChannelClaudeFile is the CLAUDE.md a channel workspace runs with: the
// channel's rules stay in AGENTS.md, the file the person edits, and Foundry
// rewrites this file before every run, so its own guidance goes here (DEV-318).
// Only Claude Code reads it; a Codex run reads AGENTS.md alone.
func ChannelClaudeFile() personalagent.WorkspaceFile {
	return personalagent.WorkspaceFile{Path: ChannelClaudePath, Content: "@AGENTS.md\n\n" + channelRepliesSection}
}

// channelRepliesSection is the guidance for a turn in a conversation that
// has other people in it (DEV-318): what the reply in that chat contains.
const channelRepliesSection = "## 有别人在场时的回复\n\n" +
	"- 「有别人在场」指会话里除了本人还有其他人：群聊，或与别人的私聊。本人自聊没有别人在场。\n" +
	"- 本人用触发词发出的请求，在有别人在场的会话里卡住（要本人决定、确认或补充信息）或失败时，会话里不发任何文字，不说原因、选项或进展。有 `react` 时，只用它给触发消息加一个表情，表示在等本人；没有时也不发文字。具体内容（发现了什么、有哪些选项、为什么失败）用 `needs_you` 直接交给本人。\n" +
	"- 完成的工作结果，以及本人在这个会话里提出的问题的答案，照常用 `reply` 在会话里回复。\n" +
	"- 一条消息是结果、是问题的答案，还是卡住或失败，由你判断；拿不准时按卡住处理。\n"

// ProjectFilesAndIndex are the facts Foundry writes into every workspace the
// assistant runs in, its home and each message channel's workspace: the
// project index and one summary file per project. The content is the same in
// each (already filtered by the permission package); only .foundry/ holds it.
func ProjectFilesAndIndex(in Input) []personalagent.WorkspaceFile {
	files := []personalagent.WorkspaceFile{{Path: ProjectIndexPath, Content: ProjectIndexFile(in)}}
	return append(files, in.ProjectFiles...)
}

// RunFiles are the files Foundry supplies before an assistant run. The skill
// contents have one canonical copy; the Worker links each directory into
// .claude/skills and .agents/skills for native runtime discovery.
func RunFiles(in Input) []personalagent.WorkspaceFile {
	files := []personalagent.WorkspaceFile{
		{Path: "AGENTS.md", Content: ManagedBlock(in), ManagedBlock: true, Seed: DefaultInstructions(), Whole: AgentsFile(in)},
		{Path: ExamplesPath, Content: ExamplesFile(in)},
	}
	files = append(files, ProjectFilesAndIndex(in)...)
	if in.Upkeep != "" {
		files = append(files, personalagent.WorkspaceFile{Path: UpkeepPath, Content: in.Upkeep})
	}
	for _, skill := range assistantSkills {
		files = append(files, personalagent.WorkspaceFile{
			Path:    AssistantSkillPath(skill.Name),
			Content: skill.Content,
		})
	}
	return files
}

// Computers is what list_computers answers: one line per computer the
// person owns, with what the assistant may do there and what it has.
func Computers(in Input) string {
	var out strings.Builder
	writeDevices(&out, in)
	return out.String()
}

// filled is system.md with its placeholders filled from the settings.
func filled(in Input) string {
	location := timeLocation(in)
	language := in.Settings.Language
	if language == "" {
		language = in.AccountLanguage
	}
	name := in.Settings.AssistantName
	if name == "" {
		name = defaultNameEN
		if strings.HasPrefix(strings.ToLower(language), "zh") {
			name = defaultNameZH
		}
	}
	person := strings.TrimSpace(in.PersonName)
	if person == "" {
		person = "the person who owns this account"
	}
	return strings.NewReplacer(
		"{{assistant_name}}", name,
		"{{person_name}}", person,
		"{{timezone}}", location.String(),
		"{{language}}", languageName(language),
		"{{speaking_style}}", speakingStyle(in.Settings.SpeakingStyle),
		"{{verbosity}}", verbosity(in.Settings.Verbosity),
	).Replace(system)
}

// TurnContextStart and TurnContextEnd enclose TurnContext's block.
const (
	TurnContextStart = "[Context from Foundry for this turn: not the person's words]"
	TurnContextEnd   = "[End of context from Foundry]"
)

// TurnContext is what Foundry adds to each turn's input of an assistant
// session, which the runtime does not know: the time now in the person's
// zone, the computer the assistant runs on and where the person last
// chatted themselves (recentComputers). They are facts, never guidance;
// the caller may add the input's receipt before TurnContextEnd.
func TurnContext(in Input) string {
	location := timeLocation(in)
	var out strings.Builder
	fmt.Fprintf(&out, "%s\nNow: %s (%s).\n", TurnContextStart, in.Now.In(location).Format(headerDateLayout+" 15:04"), location.String())
	labels := map[string]string{}
	for _, device := range in.Devices {
		labels[device.DeviceID] = cmp.Or(strings.TrimSpace(device.Label), device.DeviceID)
	}
	if home := in.HomeDeviceID; home != "" {
		if label := labels[home]; label != "" && label != home {
			fmt.Fprintf(&out, "You run on: %s (%s).\n", label, home)
		} else {
			fmt.Fprintf(&out, "You run on: %s.\n", home)
		}
	}
	fmt.Fprintf(&out, "The person's own latest chats, by computer: %s.\n", recentComputers(in, labels))
	out.WriteString(TurnContextEnd)
	return out.String()
}

// What recentComputers names.
const (
	recentComputersWindow   = 7 * 24 * time.Hour
	recentComputersMax      = 3
	recentProjectsPerDevice = 2
)

// recentComputers is where the person last chatted themselves (a Foundry
// chat they started or a native chat; WorkspaceDigest.PersonActiveAt): of
// the computers they own, the latest recentComputersMax within
// recentComputersWindow, each with when and its latest projects.
func recentComputers(in Input, labels map[string]string) string {
	type project struct {
		name string
		at   time.Time
	}
	byDevice := map[string][]project{}
	for _, workspace := range in.Workspaces {
		if workspace.Archived || workspace.Kind == store.WorkspaceKindPersonalAgent || labels[workspace.DeviceID] == "" {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, workspace.PersonActiveAt)
		if err != nil || in.Now.Sub(at) > recentComputersWindow {
			continue
		}
		byDevice[workspace.DeviceID] = append(byDevice[workspace.DeviceID], project{name: workspace.Name, at: at})
	}
	devices := make([]string, 0, len(byDevice))
	for deviceID, projects := range byDevice {
		sort.Slice(projects, func(i, j int) bool {
			if !projects[i].at.Equal(projects[j].at) {
				return projects[i].at.After(projects[j].at)
			}
			return projects[i].name < projects[j].name
		})
		devices = append(devices, deviceID)
	}
	sort.Slice(devices, func(i, j int) bool {
		a, b := byDevice[devices[i]][0].at, byDevice[devices[j]][0].at
		if !a.Equal(b) {
			return a.After(b)
		}
		return devices[i] < devices[j]
	})
	if len(devices) == 0 {
		return fmt.Sprintf("none in the last %d days", int(recentComputersWindow.Hours()/24))
	}
	parts := []string{}
	for _, deviceID := range devices[:min(len(devices), recentComputersMax)] {
		projects := byDevice[deviceID]
		names := []string{}
		for _, project := range projects[:min(len(projects), recentProjectsPerDevice)] {
			names = append(names, "『"+oneLine(project.name)+"』")
		}
		parts = append(parts, fmt.Sprintf("%s %s (%s)", labels[deviceID], ago(in.Now.Sub(projects[0].at)), strings.Join(names, ", ")))
	}
	return strings.Join(parts, "; ")
}

// ago is a duration as "3 min ago", "5 h ago" or "2 d ago".
func ago(elapsed time.Duration) string {
	switch {
	case elapsed < time.Minute:
		return "just now"
	case elapsed < time.Hour:
		return fmt.Sprintf("%d min ago", int(elapsed.Minutes()))
	case elapsed < 48*time.Hour:
		return fmt.Sprintf("%d h ago", int(elapsed.Hours()))
	default:
		return fmt.Sprintf("%d d ago", int(elapsed.Hours()/24))
	}
}

func writeMemory(out *strings.Builder, items []store.PersonalAgentMemoryItem, location *time.Location) {
	active := []store.PersonalAgentMemoryItem{}
	for _, item := range items {
		if item.Status == store.PersonalAgentMemoryActive && strings.TrimSpace(item.Content) != "" {
			active = append(active, item)
		}
	}
	if len(active) == 0 {
		out.WriteString("Nothing yet.\n")
		return
	}
	sort.SliceStable(active, func(i, j int) bool {
		if active[i].UpdatedAt != active[j].UpdatedAt {
			return active[i].UpdatedAt > active[j].UpdatedAt
		}
		return active[i].ID < active[j].ID
	})
	used, left := 0, 0
	for _, item := range active {
		content := oneLine(item.Content)
		if used+utf8.RuneCountInString(content) > aboutMaxChars {
			left++
			continue
		}
		used += utf8.RuneCountInString(content)
		fmt.Fprintf(out, "- %s (%s%s, %s) [%s]\n", content, originLabel(item.Origin), layerLabel(item.Scope), day(item.UpdatedAt, location), item.ID)
	}
	if left > 0 {
		fmt.Fprintf(out, "- …and %d older facts: read_memory.\n", left)
	}
}

func writeDevices(out *strings.Builder, in Input) {
	if len(in.Devices) == 0 {
		out.WriteString("None reported.\n")
		return
	}
	allowed := map[string]store.PersonalAgentDeviceSettings{}
	for _, device := range in.Settings.Devices {
		allowed[device.DeviceID] = device
	}
	preferred := in.Settings.PreferredDeviceID
	if preferred == "" {
		preferred = in.HomeDeviceID
	}
	devices := append([]store.DeviceDigest(nil), in.Devices...)
	sort.SliceStable(devices, func(i, j int) bool { return devices[i].Label < devices[j].Label })
	for _, device := range devices {
		parts := []string{"offline"}
		if device.Online {
			parts[0] = "online"
		}
		if device.System != "" {
			parts = append(parts, device.System)
		}
		if device.DeviceID == in.HomeDeviceID {
			parts = append(parts, "your folder is here")
		}
		setting, ok := allowed[device.DeviceID]
		if !ok {
			setting = store.PersonalAgentDeviceSettings{AllowWork: true}
		}
		if !setting.AllowWork {
			parts = append(parts, "no work here")
		}
		if setting.AllowCreate {
			if device.DeviceID == preferred {
				parts = append(parts, "may hold new projects, the default place for self-contained work")
			} else {
				parts = append(parts, "may hold new projects")
			}
		}
		if len(device.Runtimes) > 0 {
			parts = append(parts, "runs "+strings.Join(device.Runtimes, ", "))
		}
		place := in.Places[device.DeviceID]
		if len(place.Labels) > 0 {
			labels := make([]string, len(place.Labels))
			for i, label := range place.Labels {
				labels[i] = labelText(label.Key, label.Value)
			}
			parts = append(parts, "the person says it has "+strings.Join(labels, ", "))
		}
		if len(place.Facts) > 0 {
			facts := make([]string, len(place.Facts))
			for i, fact := range place.Facts {
				facts[i] = labelText(fact.Key, fact.Value)
				if fact.Source == "connector" && fact.Detail != "" {
					facts[i] += " (" + fact.Detail + ")"
				}
			}
			parts = append(parts, "Foundry found "+strings.Join(facts, ", "))
		}
		fmt.Fprintf(out, "- %s [%s]: %s\n", quote(device.Label), device.DeviceID, strings.Join(parts, "; "))
	}
}

// labelText is a label or fact as the assistant passes it in needs.
func labelText(key, value string) string {
	if value == "" {
		return key
	}
	return key + ":" + value
}

var actionLabels = map[string]string{
	store.PersonalAgentActionCreateWorkspace:    "create a project in a managed folder",
	store.PersonalAgentActionRegisterFolder:     "use a folder of theirs outside the managed folders",
	store.PersonalAgentActionRenameWorkspace:    "rename a project or restate its purpose",
	store.PersonalAgentActionAddSkill:           "add a skill to a project",
	store.PersonalAgentActionRemoveSkillCreated: "remove a skill from a project you created",
	store.PersonalAgentActionRemoveSkill:        "remove a skill from any other project",
	store.PersonalAgentActionBindConnector:      "give a project one of their accounts (first time per account and project)",
	store.PersonalAgentActionUnbindConnector:    "take one of their accounts away from a project",
	store.PersonalAgentActionArchive:            "archive a project",
	store.PersonalAgentActionRestore:            "restore an archived project",
	store.PersonalAgentActionArchiveSession:     "archive or restore up to 3 chats (a folder or more chats: the person confirms first)",
}

func decisionLabel(decision string) string {
	switch decision {
	case store.PersonalAgentAuto:
		return "you do it, then say so"
	case store.PersonalAgentAsk:
		return "the person confirms first"
	case store.PersonalAgentDeny:
		return "never"
	}
	return "Foundry decides"
}

func layerLabel(scope string) string {
	switch scope {
	case store.MemoryScopePerson:
		return ", every assistant"
	case store.MemoryScopeAssistant:
		return ", only you"
	}
	return ""
}

func originLabel(origin string) string {
	switch origin {
	case store.PersonalAgentMemoryStated:
		return "they said"
	case store.PersonalAgentMemoryEdited:
		return "they wrote it in settings"
	case store.PersonalAgentMemoryInferred:
		return "your guess"
	}
	return origin
}

func speakingStyle(style string) string {
	switch style {
	case "plain":
		return "Style: plain words always, even when the person uses technical ones."
	case "technical":
		return "Style: the person chose technical; technical words are fine, still short and clear."
	}
	return "Style: plain words; use a technical word only after the person has used it."
}

func verbosity(level string) string {
	if level == "detailed" {
		return "Length: detailed; explain steps and reasons when they help, without filler."
	}
	return "Length: brief; one to three sentences unless the person asks for more."
}

var languageNames = map[string]string{
	"zh": "Chinese", "zh-cn": "Simplified Chinese", "zh-hans": "Simplified Chinese",
	"zh-tw": "Traditional Chinese", "zh-hk": "Traditional Chinese", "zh-hant": "Traditional Chinese",
	"en": "English", "ja": "Japanese", "ko": "Korean", "fr": "French", "de": "German", "es": "Spanish",
}

func languageName(tag string) string {
	tag = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(tag), "_", "-"))
	if tag == "" {
		return "the one the person writes in"
	}
	name, ok := languageNames[tag]
	if !ok {
		base, _, _ := strings.Cut(tag, "-")
		if name, ok = languageNames[base]; !ok {
			name = tag
		}
	}
	return "the language of the person's latest message, for every reply (a message mostly in Chinese with some English words is Chinese); " + name + " when you cannot tell"
}

func timeLocation(in Input) *time.Location {
	return personalagent.Location(in.Settings, in.AccountLanguage)
}

func day(value string, location *time.Location) string {
	at, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return value
	}
	return at.In(location).Format(dateLayout)
}

func clock(value string, location *time.Location) string {
	at, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return value
	}
	return at.In(location).Format(timeLayout)
}

func quote(name string) string { return "\"" + oneLine(name) + "\"" }

func oneLine(text string) string { return strings.Join(strings.Fields(text), " ") }
