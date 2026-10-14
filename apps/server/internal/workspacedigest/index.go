package workspacedigest

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	indexNameRunes  = 40
	indexLabelRunes = 30
)

// Index is the L0 index the assistant starts each conversation with: one
// line per device the person owns, then one per project, most recently
// active first, at most personalagent.L0IndexMaxEntries projects and
// personalagent.L0IndexMaxTokens tokens (EstimateTokens) in all; what does
// not fit is counted, for find_workspace. Archived projects and the
// assistant's own workspace are left out.
func Index(digests []store.WorkspaceDigest, devices []store.DeviceDigest, now time.Time) string {
	projects := []store.WorkspaceDigest{}
	for _, digest := range digests {
		if !digest.Archived && digest.Kind != store.WorkspaceKindPersonalAgent {
			projects = append(projects, digest)
		}
	}
	sort.SliceStable(projects, func(i, j int) bool {
		left, _ := parseTime(projects[i].LastActivityAt)
		right, _ := parseTime(projects[j].LastActivityAt)
		if !left.Equal(right) {
			return left.After(right)
		}
		return projects[i].Name < projects[j].Name
	})
	sortedDevices := append([]store.DeviceDigest{}, devices...)
	sort.SliceStable(sortedDevices, func(i, j int) bool { return sortedDevices[i].Label < sortedDevices[j].Label })

	// The closing line is reserved, so it always fits.
	budget := personalagent.L0IndexMaxTokens - EstimateTokens(moreLine(len(projects)))
	lines := []string{}
	add := func(line string) bool {
		cost := EstimateTokens(line + "\n")
		if cost > budget {
			return false
		}
		budget -= cost
		lines = append(lines, line)
		return true
	}
	add(fmt.Sprintf("Computers (%d):", len(sortedDevices)))
	for _, device := range sortedDevices {
		if !add(deviceLine(device)) {
			break
		}
	}
	add(fmt.Sprintf("Projects (%d), most recently active first:", len(projects)))
	listed := 0
	for _, project := range projects {
		if listed == personalagent.L0IndexMaxEntries || !add(projectLine(project, now)) {
			break
		}
		listed++
	}
	if listed < len(projects) {
		lines = append(lines, moreLine(len(projects)-listed))
	}
	return strings.Join(lines, "\n")
}

func moreLine(count int) string {
	return fmt.Sprintf("…and %d more projects: use find_workspace to look them up.", count)
}

func deviceLine(device store.DeviceDigest) string {
	parts := []string{fmt.Sprintf("- %s (%s)", truncateRunes(device.Label, indexLabelRunes), device.DeviceID)}
	if device.System != "" {
		parts = append(parts, device.System)
	}
	parts = append(parts, map[bool]string{true: "online", false: "offline"}[device.Online])
	if len(device.Runtimes) > 0 {
		parts = append(parts, "runs "+strings.Join(device.Runtimes, ", "))
	}
	if len(device.Resources) > 0 {
		parts = append(parts, "has "+strings.Join(device.Resources, ", "))
	}
	parts = append(parts, fmt.Sprintf("%d projects", device.WorkspaceCount))
	return strings.Join(parts, " · ")
}

func projectLine(digest store.WorkspaceDigest, now time.Time) string {
	parts := []string{fmt.Sprintf("- 『%s』 (%s)", truncateRunes(digest.Name, indexNameRunes), digest.WorkspaceID)}
	where := truncateRunes(digest.DeviceLabel, indexLabelRunes)
	switch {
	case digest.Unavailable:
		where += ", folder unavailable"
	case !digest.DeviceOnline:
		where += ", offline"
	}
	parts = append(parts, "on "+where)
	if day := dayOf(digest.LastActivityAt); day != "" {
		parts = append(parts, "active "+day)
	}
	if digest.AccessRole != "" && digest.AccessRole != store.WorkspaceRoleOwner {
		parts = append(parts, "you are "+digest.AccessRole)
	}
	verified := "verified " + dayOf(digest.CompiledAt)
	if Stale(digest, now) {
		verified += ", stale"
	}
	parts = append(parts, verified)
	line := strings.Join(parts, " · ")
	if about := L0Line(digest); about != "" {
		line += " — " + about
	}
	return line
}

// L0Line is a project's line of the index: the summary's, else its
// purpose, its intro's first sentence or its latest work, at most
// personalagent.DigestL0MaxChars characters.
func L0Line(digest store.WorkspaceDigest) string {
	line := strings.TrimSpace(digest.L0)
	if line == "" {
		line = strings.TrimSpace(digest.Purpose)
	}
	if line == "" {
		line = firstSentence(digest.Intro)
	}
	if line == "" && len(digest.RecentSessions) > 0 {
		titles := []string{}
		for _, session := range digest.RecentSessions {
			if len(titles) == 3 {
				break
			}
			titles = append(titles, session.Title)
		}
		line = "recent: " + strings.Join(titles, "; ")
	}
	return truncateRunes(strings.Join(strings.Fields(line), " "), personalagent.DigestL0MaxChars)
}

func firstSentence(text string) string {
	for i, r := range text {
		if r == '。' || r == '！' || r == '？' || ((r == '.' || r == '!' || r == '?') && (i+1 == len(text) || text[i+1] == ' ')) {
			return text[:i+len(string(r))]
		}
	}
	return text
}

func dayOf(value string) string {
	at, ok := parseTime(value)
	if !ok {
		return ""
	}
	return at.UTC().Format("2006-01-02")
}

// EstimateTokens bounds how many model tokens text takes, erring high: a
// CJK character as 1.2 tokens, any other non-ASCII character as one, ASCII
// as one per three characters.
func EstimateTokens(text string) int {
	tokens := 0.0
	for _, r := range text {
		switch {
		case isCJK(r):
			tokens += 1.2
		case r > unicode.MaxASCII:
			tokens++
		default:
			tokens += 1.0 / 3
		}
	}
	return int(math.Ceil(tokens))
}
