package channels

import (
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// ChannelTriggers are the trigger words of the channel's enabled rules.
func ChannelTriggers(channel store.MessageChannel) []string {
	var out []string
	for _, rule := range channel.Filters.Rules {
		if !rule.Enabled {
			continue
		}
		for _, trigger := range rule.TextPrefixes {
			if trigger = strings.TrimSpace(trigger); trigger != "" && !slices.Contains(out, trigger) {
				out = append(out, trigger)
			}
		}
	}
	return out
}

// MatchTrigger is StartsWithTrigger that also says which trigger matched
// and what follows it (leading mentions and spaces removed).
func MatchTrigger(text string, triggers []string, caseSensitive bool) (trigger, rest string, ok bool) {
	body := withoutLeadingMentions(text)
	for _, candidate := range triggers {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" || !StartsWithTrigger(body, []string{candidate}, caseSensitive) {
			continue
		}
		return candidate, strings.TrimLeftFunc(body[len(candidate):], separator), true
	}
	return "", body, false
}

// separator is what may stand between a trigger and the text: spaces and
// punctuation such as "，" or ":", but not an opening bracket or quote or a
// "/" (a command), which belong to the text.
func separator(r rune) bool {
	return unicode.IsSpace(r) || unicode.IsPunct(r) && r != '/' && !unicode.In(r, unicode.Ps, unicode.Pi)
}

// StripCommand reports whether text asks for a new session: it starts with
// one of commands, alone or right after one of triggers (matched the way
// triggers are), and returns what follows the command.
func StripCommand(text string, triggers, commands []string) (string, bool) {
	body := withoutLeadingMentions(text)
	if _, rest, ok := MatchTrigger(body, triggers, false); ok && len(triggers) > 0 {
		if _, after, ok := MatchTrigger(rest, commands, false); ok {
			return after, true
		}
	}
	if _, after, ok := MatchTrigger(body, commands, false); ok {
		return after, true
	}
	return text, false
}

// Notice is what the assistant's session receives for a turn: stable
// "key: value" facts about the channel, the conversation, the session and
// each message, which are other people's words. It says nothing about what
// to do; that is the channel workspace's AGENTS.md.
func Notice(channel store.MessageChannel, sourceLabel, contextHint string, decision Rollover, records []store.MessageChannelDeliveryRecord) string {
	var out strings.Builder
	line := func(key, format string, args ...any) {
		fmt.Fprintf(&out, "%s: %s\n", key, fmt.Sprintf(format, args...))
	}
	out.WriteString("[Message channel: messages from other people, not the person's words]\n")
	line("channel", "%s %q", channel.ID, oneLine(channel.Name))
	line("source", "%s", oneLine(cmpOr(sourceLabel, channel.Source.Kind)))
	first := records[0].Envelope
	conversation := first.Conversation.Kind + " " + first.Conversation.ID
	if first.Conversation.Name != "" {
		conversation += fmt.Sprintf(" %q", oneLine(first.Conversation.Name))
	}
	line("conversation", "%s", conversation)
	if first.Thread.ID != "" {
		thread := first.Thread.ID
		if first.Thread.IsReply {
			thread += " (reply)"
		}
		line("thread", "%s", thread)
	}
	switch {
	case !decision.New:
		line("session", "continued")
	case decision.Reason == NewIdle:
		line("session", "new (idle %s)", roundDuration(decision.Idle))
	default:
		line("session", "new (%s)", decision.Reason)
	}
	if decision.New && decision.Previous != "" {
		earlier := decision.Previous
		if !decision.PreviousLast.IsZero() {
			earlier += " (last active " + decision.PreviousLast.UTC().Format(time.RFC3339) + ")"
		}
		line("earlier session", "%s", earlier)
	}
	if contextHint != "" {
		line("context", "%s", fillHint(contextHint, first))
	}
	for i, record := range records {
		envelope := record.Envelope
		fmt.Fprintf(&out, "\nmessage %d:\n", i+1)
		item := func(key, format string, args ...any) {
			fmt.Fprintf(&out, "  %s: %s\n", key, fmt.Sprintf(format, args...))
		}
		item("id", "%s", cmpOr(envelope.MessageID, envelope.ID))
		item("op", "%s", envelope.Op)
		if envelope.OccurredAt != "" {
			item("at", "%s", envelope.OccurredAt)
		}
		if envelope.Thread.ID != "" && envelope.Thread.ID != first.Thread.ID {
			item("thread", "%s", envelope.Thread.ID)
		}
		item("sender", "%q (%s)", oneLine(envelope.Sender.Name), envelope.Sender.ID)
		item("sender is the person", "%s", yesNo(envelope.Sender.IsSelf))
		item("sender is a bot", "%s", yesNo(envelope.Sender.IsBot))
		item("mentions the person", "%s", yesNo(envelope.MentionsMe))
		for _, name := range sortedKeys(envelope.Attributes) {
			item("attribute "+name, "%s", oneLine(envelope.Attributes[name]))
		}
		trigger, rest := "", ""
		if record.Rule != "" {
			item("rule", "%s", record.Rule)
			for _, rule := range channel.Filters.Rules {
				if rule.ID == record.Rule {
					trigger, rest, _ = MatchTrigger(envelope.Text, rule.TextPrefixes, rule.CaseSensitive)
				}
			}
		}
		if trigger != "" {
			item("trigger", "%s", trigger)
		}
		item("text", "%s", block(envelope.Text))
		if trigger != "" {
			item("text without trigger", "%s", block(rest))
		}
		if envelope.TextTruncated {
			item("text cut", "yes, at 8 KB")
		}
	}
	out.WriteString("[End of message channel]\n")
	return out.String()
}

func fillHint(hint string, envelope store.MessageEnvelope) string {
	return strings.NewReplacer(
		"{message.id}", cmpOr(envelope.MessageID, envelope.ID),
		"{conversation.id}", envelope.Conversation.ID,
		"{thread.id}", envelope.Thread.ID,
	).Replace(hint)
}

// block keeps a multi-line text readable under its key.
func block(text string) string {
	if !strings.Contains(text, "\n") {
		return text
	}
	return "|\n    " + strings.ReplaceAll(strings.TrimRight(text, "\n"), "\n", "\n    ")
}

func yesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

func roundDuration(d time.Duration) string {
	if d >= time.Hour {
		return d.Round(time.Minute).String()
	}
	return d.Round(time.Second).String()
}
