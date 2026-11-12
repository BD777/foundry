package channels

import (
	"slices"
	"strings"
	"unicode"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Decision is what a channel's filter decided about one envelope.
type Decision struct {
	Keep bool
	// Rule is the id of the rule that kept it.
	Rule string
	// Reason says why nothing kept it.
	Reason string
}

// Stage is one step of a channel's filter. A message goes on only while
// every stage keeps it. v1 has one kind, Rules; a program and an
// agent-runtime triage step fit the same interface.
type Stage interface {
	Decide(envelope store.MessageEnvelope) Decision
}

// Rules keeps a message when any enabled rule matches it.
type Rules []store.MessageChannelRule

func (rules Rules) Decide(envelope store.MessageEnvelope) Decision {
	enabled := 0
	for _, rule := range rules {
		if !rule.Enabled {
			continue
		}
		enabled++
		if RuleMatches(rule, envelope) {
			return Decision{Keep: true, Rule: rule.ID}
		}
	}
	if enabled == 0 {
		return Decision{Reason: "no_rules"}
	}
	return Decision{Reason: "no_rule_matched"}
}

// Decide runs the stages in order.
func Decide(stages []Stage, envelope store.MessageEnvelope) Decision {
	decision := Decision{Keep: true}
	for _, stage := range stages {
		next := stage.Decide(envelope)
		if !next.Keep {
			return next
		}
		if next.Rule != "" {
			decision.Rule = next.Rule
		}
	}
	return decision
}

// RuleMatches reports whether every condition of rule holds for envelope.
func RuleMatches(rule store.MessageChannelRule, envelope store.MessageEnvelope) bool {
	if len(rule.ConversationKinds) > 0 && !slices.Contains(rule.ConversationKinds, envelope.Conversation.Kind) {
		return false
	}
	if !triState(rule.MentionsMe, envelope.MentionsMe) || !triState(rule.FromSelf, envelope.Sender.IsSelf) {
		return false
	}
	if len(rule.ConversationIDs) > 0 && !slices.Contains(rule.ConversationIDs, envelope.Conversation.ID) {
		return false
	}
	if slices.Contains(rule.ExcludeConversationIDs, envelope.Conversation.ID) {
		return false
	}
	if len(rule.SenderIDs) > 0 && !slices.Contains(rule.SenderIDs, envelope.Sender.ID) {
		return false
	}
	if slices.Contains(rule.ExcludeSenderIDs, envelope.Sender.ID) {
		return false
	}
	return hasPrefix(envelope.Text, rule.TextPrefixes, rule.CaseSensitive)
}

func triState(condition string, value bool) bool {
	switch condition {
	case "yes":
		return value
	case "no":
		return !value
	default:
		return true
	}
}

// mentionWords is how many words after an "@" may still belong to the name
// it mentions ("@Ada Lovelace /ask …").
const mentionWords = 3

// hasPrefix reports whether text starts with one of prefixes, once leading
// mentions are set aside. A mention is "@" and a name of up to mentionWords
// words, so the prefix may also start at any of those words. Without
// prefixes any text matches.
func hasPrefix(text string, prefixes []string, caseSensitive bool) bool {
	wanted := make([]string, 0, len(prefixes))
	for _, prefix := range prefixes {
		if prefix = strings.TrimSpace(prefix); prefix != "" {
			if !caseSensitive {
				prefix = strings.ToLower(prefix)
			}
			wanted = append(wanted, prefix)
		}
	}
	if len(wanted) == 0 {
		return true
	}
	if !caseSensitive {
		text = strings.ToLower(text)
	}
	for _, start := range prefixStarts(text) {
		for _, prefix := range wanted {
			if strings.HasPrefix(text[start:], prefix) {
				return true
			}
		}
	}
	return false
}

// prefixStarts are where a prefix may begin in text: its first word, and
// while the text opens with mentions, each of the mentionWords words after
// a mention.
func prefixStarts(text string) []int {
	words := wordStarts(text)
	if len(words) == 0 {
		return nil
	}
	starts := []int{words[0]}
	sinceMention := -1
	for _, at := range words {
		if text[at] == '@' {
			sinceMention = 0
		} else if sinceMention < 0 || sinceMention >= mentionWords {
			break
		} else {
			sinceMention++
		}
		if at != starts[len(starts)-1] {
			starts = append(starts, at)
		}
	}
	return starts
}

func wordStarts(text string) []int {
	var starts []int
	inWord := false
	for i, r := range text {
		if unicode.IsSpace(r) {
			inWord = false
			continue
		}
		if !inWord {
			starts = append(starts, i)
			inWord = true
		}
	}
	return starts
}
