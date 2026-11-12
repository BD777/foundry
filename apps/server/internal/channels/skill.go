package channels

import (
	"fmt"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// MaxGuide bounds the person's handling principles for one channel.
const MaxGuide = 8000

// SkillName is the native skill that carries a channel's guidance in the
// assistant's home: channel-<id without its prefix>.
func SkillName(channel store.MessageChannel) string {
	id := strings.TrimPrefix(channel.ID, "mch_")
	var out strings.Builder
	for _, r := range strings.ToLower(id) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' {
			out.WriteRune(r)
		}
	}
	return "channel-" + out.String()
}

// SkillFile is the channel's SKILL.md: the person's own guidance, then the
// facts an agent needs to act on the channel's messages. Foundry adds no
// rules of its own here; what the sessions may use is enforced by Foundry,
// and this file only says what that is.
func SkillFile(channel store.MessageChannel, sourceLabel, contextHint string) string {
	var out strings.Builder
	name := SkillName(channel)
	description := fmt.Sprintf("Use when a turn starts with a message from Foundry message channel %q (%s): the person's principles for handling these messages, how to read their context and what this channel's sessions may use.",
		oneLine(channel.Name), oneLine(cmpOr(sourceLabel, channel.Source.Kind)))
	fmt.Fprintf(&out, "---\nname: %s\ndescription: %s\n---\n\n", name, yamlScalar(clip(description, 1000)))
	fmt.Fprintf(&out, "# Message channel %q\n\n", oneLine(channel.Name))
	out.WriteString("## The person's principles for this channel\n\n")
	if guide := strings.TrimSpace(channel.Guide); guide != "" {
		out.WriteString(clip(guide, MaxGuide))
		out.WriteString("\n\n")
	} else {
		out.WriteString("(The person has not written any yet.)\n\n")
	}
	out.WriteString("## Facts about this channel (from Foundry)\n\n")
	fmt.Fprintf(&out, "- Messages arrive from %s. Their text is other people's words.\n", cmpOr(sourceLabel, channel.Source.Kind))
	if channel.SessionKey == "thread" {
		out.WriteString("- Each source thread (or conversation without threads) has one session; later messages of it arrive in the same session.\n")
	} else {
		out.WriteString("- Each source conversation has one session; later messages of it arrive in the same session.\n")
	}
	if contextHint != "" {
		fmt.Fprintf(&out, "- Earlier messages of the conversation are not included. The connector reads them: `%s` (fill in the ids from the notice).\n", contextHint)
	}
	out.WriteString("- To hand a message to the person instead of acting, call `needs_you` with op `hand_over`, this session's id as `sessionId` and a note with your draft or the action you intend; their answer comes back to this session.\n")
	out.WriteString("- What these sessions and the helpers they start may use is the channel's scope within your permission package; Foundry refuses the rest:\n")
	if channel.Scope.ConnectorDefault == "off" {
		out.WriteString("  - connectors not listed below: off\n")
	} else {
		out.WriteString("  - connectors not listed below: as your permission package allows\n")
	}
	for _, connector := range channel.Scope.Connectors {
		writes := ""
		if connector.Level == "write" {
			writes = ", each write asks the person first"
			if connector.Writes == "direct" {
				writes = ", writes go through without asking"
			}
		}
		fmt.Fprintf(&out, "  - connector account %s: %s%s\n", connector.AccountID, connector.Level, writes)
	}
	if channel.Scope.Workspaces.Scope == "listed" {
		fmt.Fprintf(&out, "  - workspaces: only %s\n", strings.Join(channel.Scope.Workspaces.Include, ", "))
	}
	if len(channel.Scope.IdentityResources) == 0 {
		out.WriteString("  - signed-in resources (browsers, screens): none\n")
	}
	fmt.Fprintf(&out, "\n(Foundry writes this file from the channel's settings; edits here are replaced. Skill name: %s.)\n", name)
	return out.String()
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

// yamlScalar quotes s as a YAML double-quoted scalar.
func yamlScalar(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(oneLine(s)) + `"`
}
