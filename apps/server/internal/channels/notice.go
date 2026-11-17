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
func Notice(channel store.MessageChannel, sourceLabel, contextHint, replyCommand string, decision Rollover, records []store.MessageChannelDeliveryRecord) string {
	return NoticeWithFacts(channel, sourceLabel, contextHint, replyCommand, decision, records, Facts{})
}

// NoticeWithFacts is Notice with what the source's reads said about the
// conversation and the thread.
func NoticeWithFacts(channel store.MessageChannel, sourceLabel, contextHint, replyCommand string, decision Rollover, records []store.MessageChannelDeliveryRecord, facts Facts) string {
	var out strings.Builder
	line := func(key, format string, args ...any) {
		fmt.Fprintf(&out, "%s: %s\n", key, fmt.Sprintf(format, args...))
	}
	out.WriteString(noticeHeader(records))
	line("channel", "%s %q", channel.ID, oneLine(channel.Name))
	line("source", "%s", oneLine(cmpOr(sourceLabel, channel.Source.Kind)))
	first := records[0].Envelope
	line("conversation", "%s", conversationFact(first))
	if first.Thread.ID != "" {
		line("thread", "%s", threadLine(first, facts.Thread))
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
	if replyCommand != "" {
		line("reply", "%s", fillHint(replyCommand, records[len(records)-1].Envelope))
	}
	writeMessages(&out, channel, records)
	writeThreadFacts(&out, facts.Thread)
	out.WriteString("[End of message channel]\n")
	return out.String()
}

// ContextNotice is what the assistant's session receives when other people
// write in the same conversation while its request is open: facts for the
// open request, never a request of its own.
func ContextNotice(channel store.MessageChannel, sourceLabel string, records []store.MessageChannelDeliveryRecord, facts Facts, capped bool) string {
	var out strings.Builder
	line := func(key, format string, args ...any) {
		fmt.Fprintf(&out, "%s: %s\n", key, fmt.Sprintf(format, args...))
	}
	out.WriteString("[Message channel context: messages from other people while the request is open; context for that request, not a new request]\n")
	line("channel", "%s %q", channel.ID, oneLine(channel.Name))
	line("source", "%s", oneLine(cmpOr(sourceLabel, channel.Source.Kind)))
	first := records[0].Envelope
	line("conversation", "%s", conversationFact(first))
	if first.Thread.ID != "" {
		line("thread", "%s", threadLine(first, facts.Thread))
	}
	line("context", "%d message(s) in this window%s", len(records), cappedNotice(capped))
	writeMessages(&out, channel, records)
	out.WriteString("[End of message channel context]\n")
	return out.String()
}

// cappedNotice says when a window's cap left later messages out.
func cappedNotice(capped bool) string {
	if !capped {
		return ""
	}
	return fmt.Sprintf(" (the cap of %d messages or 8 KB is reached; later ones are not delivered)", maxContextMessages)
}

// conversationFact names a conversation as what it is: a direct chat by the
// other participant, a group by its name.
func conversationFact(envelope store.MessageEnvelope) string {
	conversation := string(envelope.Conversation.Kind) + " " + envelope.Conversation.ID
	name := strings.TrimSpace(envelope.Conversation.Name)
	if name != "" {
		conversation += fmt.Sprintf(" %q", oneLine(name))
	}
	readable := ""
	switch envelope.Conversation.Kind {
	case "direct":
		if name != "" {
			readable = " (direct chat with " + oneLine(name) + ")"
		}
	case "self":
		readable = " (your own chat)"
	case "group":
		readable = " (group)"
	case "channel":
		readable = " (channel)"
	case "feed":
		readable = " (feed)"
	}
	if readable == "" {
		return conversation
	}
	return conversation + readable
}

// threadLine says which thread, and under whose message it is.
func threadLine(envelope store.MessageEnvelope, facts *ThreadFacts) string {
	thread := envelope.Thread.ID
	if envelope.Thread.IsReply {
		thread += " (reply)"
	}
	if facts != nil && facts.Root != nil {
		root := facts.Root
		thread += "; thread under " + senderFact(root.SenderName, root.SenderID, root.IsSelf)
		if root.At != "" {
			thread += " at " + factAt(root.At)
		}
	}
	return thread
}

// writeMessages writes each record's message facts.
func writeMessages(out *strings.Builder, channel store.MessageChannel, records []store.MessageChannelDeliveryRecord) {
	first := records[0].Envelope
	for i, record := range records {
		envelope := record.Envelope
		fmt.Fprintf(out, "\nmessage %d:\n", i+1)
		item := func(key, format string, args ...any) {
			fmt.Fprintf(out, "  %s: %s\n", key, fmt.Sprintf(format, args...))
		}
		item("id", "%s", cmpOr(envelope.MessageID, envelope.ID))
		item("op", "%s", envelope.Op)
		if envelope.OccurredAt != "" {
			item("at", "%s", envelope.OccurredAt)
		}
		if envelope.Thread.ID != "" && envelope.Thread.ID != first.Thread.ID {
			item("thread", "%s", envelope.Thread.ID)
		}
		item("sender", "%s", senderFact(envelope.Sender.Name, envelope.Sender.ID, envelope.Sender.IsSelf))
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
		if record.FollowUp != "" {
			item("follow-up", "%s", record.FollowUp)
		}
		// The text is carried once: as it came, or as the trigger, the
		// mentions before it and what follows it.
		if trigger != "" {
			item("trigger", "%s", trigger)
			if mentions := leadingMentions(envelope.Text); mentions != "" {
				item("mentions before trigger", "%s", mentions)
			}
			item("text without trigger", "%s", block(rest))
		} else {
			item("text", "%s", block(envelope.Text))
		}
		if envelope.TextTruncated {
			item("text cut", "yes, at 8 KB")
		}
	}
}

// senderFact names a sender and whether they are the person.
func senderFact(name, id string, isSelf bool) string {
	who := id
	switch {
	case name != "" && id != "":
		who = fmt.Sprintf("%q (%s)", oneLine(name), id)
	case name != "":
		who = fmt.Sprintf("%q", oneLine(name))
	case id == "":
		who = "unknown sender"
	}
	if isSelf {
		return who + ", the person"
	}
	return who + ", not the person"
}

// writeThreadFacts writes the thread's root and the replies before the
// trigger, as facts.
func writeThreadFacts(out *strings.Builder, facts *ThreadFacts) {
	if facts == nil {
		return
	}
	if facts.Root != nil {
		root := facts.Root
		fmt.Fprintf(out, "\nthread root:\n")
		item := func(key, format string, args ...any) {
			fmt.Fprintf(out, "  %s: %s\n", key, fmt.Sprintf(format, args...))
		}
		if root.ID != "" {
			item("id", "%s", root.ID)
		}
		item("sender", "%s", senderFact(root.SenderName, root.SenderID, root.IsSelf))
		if root.At != "" {
			item("at", "%s", factAt(root.At))
		}
		item("text", "%s", block(root.Text))
		if root.Text == "" {
			if root.Kind != "" {
				item("kind", "%s (no text)", root.Kind)
			} else {
				item("text", "(no text)")
			}
		}
		if root.Media != "" {
			item("media", "%s (the source's own media read fetches it)", root.Media)
		}
	}
	if len(facts.Replies) > 0 || facts.Skipped > 0 {
		fmt.Fprintf(out, "\nthread earlier replies: %d\n", len(facts.Replies))
		for _, reply := range facts.Replies {
			when := ""
			if reply.At != "" {
				when = factAt(reply.At) + " "
			}
			text := block(reply.Text)
			if text == "" && reply.Kind != "" {
				text = "[" + reply.Kind + "]"
			}
			fmt.Fprintf(out, "  - %s%s: %s\n", when, senderFact(reply.SenderName, reply.SenderID, reply.IsSelf), text)
		}
		if facts.Skipped > 0 {
			fmt.Fprintf(out, "  replies not shown: %d (the last %d are here)\n", facts.Skipped, maxThreadReplies)
		}
	}
}

// noticeHeader says whose words the batch's messages are.
func noticeHeader(records []store.MessageChannelDeliveryRecord) string {
	self, others := 0, 0
	for _, record := range records {
		if record.Envelope.Sender.IsSelf {
			self++
		} else {
			others++
		}
	}
	switch {
	case others == 0:
		return "[Message channel: messages from the person]\n"
	case self == 0:
		return "[Message channel: messages from other people, not the person's words]\n"
	default:
		return "[Message channel: messages from the person and from other people; only those with sender is the person: yes are the person's words]\n"
	}
}

// leadingMentions is what MatchTrigger skips before a trigger: the
// leading @mentions.
func leadingMentions(text string) string {
	return oneLine(text[:len(text)-len(withoutLeadingMentions(text))])
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
