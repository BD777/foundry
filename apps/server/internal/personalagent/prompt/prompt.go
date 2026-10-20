// Package prompt is the Personal Agent's system prompt (docs/personal-agent.md
// §12): system.md, embedded and versioned, and Fill, which turns it into the
// appended system prompt of the assistant's sessions: the prompt, the
// person's own requests, then what the assistant knows (L0). Fill's text
// changes only when one of those does: no clock, no work in progress, no
// online state, so every run of a conversation can keep its runtime and its
// prompt cache. What changes from turn to turn (the time, the work it
// follows up, which computers are online) is TurnContext, added to each
// turn's input.
//
// It does not import internal/personalagent, which builds sessions with it;
// the few limits it applies mirror defaults.go (prompt_test checks they
// agree).
package prompt

import (
	_ "embed"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

//go:embed system.md
var system string

// Version names system.md as embedded; it is stored as each assistant's
// prompt_version. Bump it whenever system.md changes (prompt_test holds the
// hash of every version).
const Version = "2026-10-20.1"

// Limits mirrored from personalagent/defaults.go.
const (
	aboutMaxChars     = 2000
	indexMaxEntries   = 40
	indexMaxTokens    = 3000
	extraMaxChars     = 2000
	listContextMax    = 20
	digestStaleAfter  = 7 * 24 * time.Hour
	defaultNameZH     = "助理"
	defaultNameEN     = "Assistant"
	timeLayout        = "2006-01-02 15:04"
	dateLayout        = "2006-01-02"
	headerDateLayout  = "Monday, 2006-01-02"
	moreProjectsLabel = "- …and %d more, less recently active; find them with find_workspace.\n"
)

// Input is everything Fill needs for one assistant session. WP-S1 fills the
// person and settings, memory and tasks from its tables; WP-S2 the digests.
// Pass records as stored: Fill picks what the snapshot shows (active
// memory, unarchived projects, unfinished tasks), orders and caps it.
type Input struct {
	// Now is when the session starts; the snapshot is as of then.
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
	// Memory is the person's pa_memory items; only active ones are shown.
	Memory []store.PersonalAgentMemoryItem
	// Workspaces are the person's workspace digests (WP-S2); the assistant's
	// own and archived ones are left out.
	Workspaces []store.WorkspaceDigest
	// Devices are the digests of the devices the person owns.
	Devices []store.DeviceDigest
	// Places are those devices' labels and detected facts, by device id.
	Places map[string]store.DevicePlacement
	// Tasks are the assistant's pa_tasks; only unfinished ones are shown.
	Tasks []store.PersonalAgentTask
	// List is the person's list (pa_items); TurnContext shows the open
	// items.
	List []store.PersonalAgentListItem
	// ConnectorsURL and SettingsURL are the Foundry pages where the person
	// connects their accounts (Feishu and other sign-ins) and changes the
	// assistant's settings. Empty: not shown.
	ConnectorsURL string
	SettingsURL   string
	// DirectChatPreviousWorkspaceID is where the person's Feishu direct chat
	// went before the assistant took it over (§14): the routing prior when
	// nothing else points elsewhere. Empty: none.
	DirectChatPreviousWorkspaceID string
}

// System is system.md as embedded, placeholders unfilled.
func System() string { return system }

// Fill renders the appended system prompt of an assistant session. It is
// the same text for the same person, settings, memory, projects and
// computers, whatever in.Now, in.Tasks, in.List, the computers' online
// state and in.DirectChatPreviousWorkspaceID are (TurnContext carries
// those); only
// the day a project's summary turns stale changes it.
func Fill(in Input) string {
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
	text := strings.NewReplacer(
		"{{assistant_name}}", name,
		"{{person_name}}", person,
		"{{timezone}}", location.String(),
		"{{language}}", languageName(language),
		"{{speaking_style}}", speakingStyle(in.Settings.SpeakingStyle),
		"{{verbosity}}", verbosity(in.Settings.Verbosity),
	).Replace(system)

	var out strings.Builder
	out.WriteString(strings.TrimRight(text, "\n"))
	out.WriteString("\n")
	if extra := strings.TrimSpace(in.Settings.ExtraInstructions); extra != "" {
		out.WriteString("\n# The person's own requests\n")
		out.WriteString("The person wrote these in your settings. Follow them, except where they conflict with Foundry's\nrules or with the privacy and safety rules above.\n\n")
		out.WriteString(cutRunes(extra, extraMaxChars))
		out.WriteString("\n")
	}
	writeSnapshot(&out, in, location)
	return out.String()
}

func writeSnapshot(out *strings.Builder, in Input, location *time.Location) {
	out.WriteString("\n# Snapshot\n")
	out.WriteString("What Foundry knew when it last changed; check anything you act on with a tool.\n")

	out.WriteString("\n## About the person\n")
	writeMemory(out, in.Memory, location)

	out.WriteString("\n## Projects\n")
	writeProjects(out, in, location)

	out.WriteString("\n## Computers\n")
	writeDevices(out, in)

	if in.ConnectorsURL != "" || in.SettingsURL != "" {
		out.WriteString("\n## Pages the person can open\n")
		if in.ConnectorsURL != "" {
			fmt.Fprintf(out, "- Connecting their accounts (Feishu and other sign-ins): %s\n", in.ConnectorsURL)
		}
		if in.SettingsURL != "" {
			fmt.Fprintf(out, "- Your settings, limits and what you remember: %s\n", in.SettingsURL)
		}
	}

	out.WriteString("\n## When Foundry asks the person first\n")
	out.WriteString("The person's current rules for your actions; Foundry enforces them, this is so you can plan.\n")
	for _, action := range store.PersonalAgentActions {
		fmt.Fprintf(out, "- %s: %s\n", actionLabels[action], decisionLabel(in.Settings.Policy[action]))
	}
	out.WriteString("- delete anything, share with other people, change a computer's settings, change a project\n  the person does not own: never\n")
}

// TurnContextStart and TurnContextEnd enclose TurnContext's block.
const (
	TurnContextStart = "[Context from Foundry for this turn: not the person's words]"
	TurnContextEnd   = "[End of context from Foundry]"
)

// TurnContext is what Foundry adds to each turn's input of an assistant
// session: the time now, which computers are online, the open items of the
// person's list, the work the assistant follows up and where the person's
// direct chat went before it. It is Foundry's, never the person's words.
func TurnContext(in Input) string {
	location := timeLocation(in)
	var out strings.Builder
	out.WriteString(TurnContextStart + "\n")
	fmt.Fprintf(&out, "Now: %s (%s).\n", in.Now.In(location).Format(headerDateLayout+" 15:04"), location.String())
	online, offline := []string{}, []string{}
	devices := append([]store.DeviceDigest(nil), in.Devices...)
	sort.SliceStable(devices, func(i, j int) bool { return devices[i].Label < devices[j].Label })
	for _, device := range devices {
		if device.Online {
			online = append(online, quote(device.Label))
		} else {
			offline = append(offline, quote(device.Label))
		}
	}
	if len(online) > 0 {
		fmt.Fprintf(&out, "Computers online now: %s.\n", strings.Join(online, ", "))
	}
	if len(offline) > 0 {
		fmt.Fprintf(&out, "Computers offline now: %s.\n", strings.Join(offline, ", "))
	}
	names := map[string]string{}
	for _, digest := range in.Workspaces {
		names[digest.WorkspaceID] = digest.Name
	}
	out.WriteString("The person's list, open (their plans; change it with update_list):\n")
	writeList(&out, in.List, location)
	out.WriteString("Work you are following up:\n")
	writeTasks(&out, in.Tasks, names, location)
	if id := in.DirectChatPreviousWorkspaceID; id != "" && names[id] != "" {
		fmt.Fprintf(&out, "Before you, the person's Feishu direct chat went to %s (%s): when nothing else points\nelsewhere, work asked for in that chat belongs there.\n", quote(names[id]), id)
	}
	out.WriteString(TurnContextEnd)
	return out.String()
}

func writeMemory(out *strings.Builder, items []store.PersonalAgentMemoryItem, location *time.Location) {
	active := []store.PersonalAgentMemoryItem{}
	for _, item := range items {
		if item.Status == store.PersonalAgentMemoryActive && strings.TrimSpace(item.Content) != "" {
			active = append(active, item)
		}
	}
	if len(active) == 0 {
		out.WriteString("Nothing yet. Learn as you go; remember what lasts.\n")
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
		fmt.Fprintf(out, "- %s (%s, %s) [%s]\n", content, originLabel(item.Origin), day(item.UpdatedAt, location), item.ID)
	}
	if left > 0 {
		fmt.Fprintf(out, "- …and %d older facts, which the person can see in your settings.\n", left)
	}
}

func writeProjects(out *strings.Builder, in Input, location *time.Location) {
	projects := []store.WorkspaceDigest{}
	for _, digest := range in.Workspaces {
		if digest.Kind == store.WorkspaceKindPersonalAgent || digest.Archived {
			continue
		}
		projects = append(projects, digest)
	}
	if len(projects) == 0 {
		out.WriteString("None yet besides your own folder. Do small things yourself; create a project when work\nneeds one (Step 3).\n")
		return
	}
	// By the day each was last active, so work today does not reorder
	// the index with every session.
	sort.SliceStable(projects, func(i, j int) bool {
		a, b := activeDay(projects[i], location), activeDay(projects[j], location)
		if a != b {
			return a > b
		}
		if projects[i].Name != projects[j].Name {
			return projects[i].Name < projects[j].Name
		}
		return projects[i].WorkspaceID < projects[j].WorkspaceID
	})
	tokens := 0
	for i, digest := range projects {
		line := projectLine(digest, in.Now, location)
		if i >= indexMaxEntries || tokens+estimateTokens(line) > indexMaxTokens {
			fmt.Fprintf(out, moreProjectsLabel, len(projects)-i)
			return
		}
		tokens += estimateTokens(line)
		out.WriteString(line)
	}
}

func projectLine(digest store.WorkspaceDigest, now time.Time, location *time.Location) string {
	about := firstNonEmpty(digest.L0, digest.Purpose, digest.Intro)
	parts := []string{}
	if about != "" {
		parts = append(parts, strings.TrimRight(cutRunes(oneLine(about), 160), ".。;；"))
	}
	if digest.DeviceLabel != "" {
		parts = append(parts, "on "+quote(digest.DeviceLabel))
	}
	switch digest.AccessRole {
	case store.WorkspaceRoleOwner:
		parts = append(parts, "theirs")
	case store.WorkspaceRoleViewer:
		parts = append(parts, "shared with them to look at only: no work, no changes")
	default:
		parts = append(parts, "shared with them: work only, no changes; others see the work")
	}
	if digest.Unavailable {
		parts = append(parts, "unavailable")
	}
	if digest.LastActivityAt != "" {
		parts = append(parts, "last active "+day(digest.LastActivityAt, location))
	}
	if stale(digest, now) {
		parts = append(parts, "stale")
	}
	return fmt.Sprintf("- %s [%s]: %s\n", quote(digest.Name), digest.WorkspaceID, strings.Join(parts, "; "))
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
		parts := []string{}
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

func writeTasks(out *strings.Builder, tasks []store.PersonalAgentTask, names map[string]string, location *time.Location) {
	open := []store.PersonalAgentTask{}
	for _, task := range tasks {
		switch task.Status {
		case store.PersonalAgentTaskQueued, store.PersonalAgentTaskRunning, store.PersonalAgentTaskAsking:
			open = append(open, task)
		}
	}
	if len(open) == 0 {
		out.WriteString("Nothing.\n")
		return
	}
	sort.SliceStable(open, func(i, j int) bool { return open[i].CreatedAt < open[j].CreatedAt })
	for _, task := range open {
		project := names[task.WorkspaceID]
		if project == "" {
			project = task.WorkspaceID
		}
		parts := []string{taskStatusLabels[task.Status]}
		if task.WaitingFor != "" {
			parts[0] = fmt.Sprintf("waiting for %s to come online; it starts by itself then", task.WaitingFor)
		}
		if task.ReadOnly {
			parts = append(parts, "read-only")
		}
		if task.StuckSince != "" {
			parts = append(parts, "possibly stuck since "+clock(task.StuckSince, location))
		} else if task.LastEventAt != "" {
			parts = append(parts, "last activity "+clock(task.LastEventAt, location))
		}
		if task.SessionID != "" {
			parts = append(parts, "helper "+task.SessionID)
		}
		fmt.Fprintf(out, "- %s in %s [%s]: %s\n", quote(task.Title), quote(project), task.ID, strings.Join(parts, "; "))
	}
}

// writeList shows the open items of the person's list, oldest first, at
// most listContextMax of them.
func writeList(out *strings.Builder, items []store.PersonalAgentListItem, location *time.Location) {
	open := []store.PersonalAgentListItem{}
	for _, item := range items {
		if item.Status == store.PersonalAgentItemOpen {
			open = append(open, item)
		}
	}
	if len(open) == 0 {
		out.WriteString("Nothing.\n")
		return
	}
	sort.SliceStable(open, func(i, j int) bool { return open[i].CreatedAt < open[j].CreatedAt })
	for i, item := range open {
		if i == listContextMax {
			fmt.Fprintf(out, "- …and %d more; read_list shows them.\n", len(open)-i)
			return
		}
		parts := []string{}
		if item.When != "" {
			parts = append(parts, quote(item.When))
		}
		if item.At != "" {
			when := clock(item.At, location)
			if item.Remind && item.RemindedAt == "" {
				when = "reminder at " + when
			} else if item.Remind {
				when = "reminded at " + when
			}
			parts = append(parts, when)
		}
		if item.TaskID != "" {
			parts = append(parts, "your task "+item.TaskID)
		}
		line := fmt.Sprintf("- %s [%s]", quote(item.Text), item.ID)
		if len(parts) > 0 {
			line += ": " + strings.Join(parts, "; ")
		}
		out.WriteString(line + "\n")
	}
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

var taskStatusLabels = map[string]string{
	store.PersonalAgentTaskQueued:  "waiting for the project's current work to finish",
	store.PersonalAgentTaskRunning: "running",
	store.PersonalAgentTaskAsking:  "its helper asked a question the person has not answered",
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

// stale: the project's summary is missing or older than digestStaleAfter.
// A digest's dirty mark and compile time change with every session there,
// so they stay out of the stable text; get_workspace and find_workspace
// report them.
func stale(digest store.WorkspaceDigest, now time.Time) bool {
	summarized, err := time.Parse(time.RFC3339, digest.SummarizedAt)
	return err != nil || now.Sub(summarized) > digestStaleAfter
}

// activeDay is the day the project was last active, "" when never.
func activeDay(digest store.WorkspaceDigest, location *time.Location) string {
	if digest.LastActivityAt == "" {
		return ""
	}
	return day(digest.LastActivityAt, location)
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

// estimateTokens is a deliberately high estimate: a token per four ASCII
// characters, one per other character (CJK text is about one each).
func estimateTokens(text string) int {
	ascii, other := 0, 0
	for _, r := range text {
		if r < utf8.RuneSelf {
			ascii++
		} else {
			other++
		}
	}
	return (ascii+3)/4 + other
}

func quote(name string) string { return "\"" + oneLine(name) + "\"" }

func oneLine(text string) string { return strings.Join(strings.Fields(text), " ") }

func cutRunes(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	return string([]rune(text)[:limit-1]) + "…"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
