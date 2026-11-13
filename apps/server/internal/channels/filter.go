package channels

import (
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

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
	return RuleMiss(rule, envelope) == ""
}

// Why a rule does not match a message, the first condition that fails.
const (
	MissPlace        = "place"
	MissMention      = "mention"
	MissSelf         = "self"
	MissConversation = "conversation"
	MissSender       = "sender"
	MissTrigger      = "trigger"
)

// RuleMiss is the first of rule's conditions that envelope fails, "" when
// it matches.
func RuleMiss(rule store.MessageChannelRule, envelope store.MessageEnvelope) string {
	switch {
	case len(rule.ConversationKinds) > 0 && !kindListed(rule.ConversationKinds, envelope.Conversation.Kind):
		return MissPlace
	case !triState(rule.MentionsMe, envelope.MentionsMe):
		return MissMention
	case !triState(rule.FromSelf, envelope.Sender.IsSelf):
		return MissSelf
	case len(rule.ConversationIDs) > 0 && !slices.Contains(rule.ConversationIDs, envelope.Conversation.ID),
		slices.Contains(rule.ExcludeConversationIDs, envelope.Conversation.ID):
		return MissConversation
	case len(rule.SenderIDs) > 0 && !slices.Contains(rule.SenderIDs, envelope.Sender.ID),
		slices.Contains(rule.ExcludeSenderIDs, envelope.Sender.ID):
		return MissSender
	case !StartsWithTrigger(envelope.Text, rule.TextPrefixes, rule.CaseSensitive):
		return MissTrigger
	}
	return ""
}

// kindListed reports whether kinds takes a conversation of kind; a chat
// with oneself is also a direct chat, so rules written for direct chats
// keep taking it.
func kindListed(kinds []string, kind string) bool {
	return slices.Contains(kinds, kind) || kind == "self" && slices.Contains(kinds, "direct")
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

// StartsWithTrigger is the trigger match the channel settings describe to
// the person: leading mentions ("@name", one word each) and spaces are
// skipped, then the text must begin with one of the triggers, ignoring case
// unless caseSensitive. A trigger that ends in an ASCII letter or digit must
// not run on into another one: "/ai" matches "/ai help", "/ai，帮我" and
// "/ai帮我", not "/aix". Without triggers any text matches.
func StartsWithTrigger(text string, triggers []string, caseSensitive bool) bool {
	fold := func(s string) string {
		if caseSensitive {
			return s
		}
		return strings.ToLower(s)
	}
	text = fold(withoutLeadingMentions(text))
	any := false
	for _, trigger := range triggers {
		trigger = fold(strings.TrimSpace(trigger))
		if trigger == "" {
			continue
		}
		any = true
		rest, ok := strings.CutPrefix(text, trigger)
		if !ok {
			continue
		}
		last, _ := utf8.DecodeLastRuneInString(trigger)
		next, _ := utf8.DecodeRuneInString(rest)
		if rest == "" || !asciiWord(last) || !asciiWord(next) {
			return true
		}
	}
	return !any
}

func asciiWord(r rune) bool {
	return r < utf8.RuneSelf && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_')
}

// withoutLeadingMentions drops leading "@name" words and the spaces around
// them.
func withoutLeadingMentions(text string) string {
	text = strings.TrimLeftFunc(text, unicode.IsSpace)
	for strings.HasPrefix(text, "@") {
		end := strings.IndexFunc(text, unicode.IsSpace)
		if end < 0 {
			return ""
		}
		text = strings.TrimLeftFunc(text[end:], unicode.IsSpace)
	}
	return text
}

// RuleCheck is one enabled rule's verdict on a message: Miss is "" when it
// matches, else the first condition it fails.
type RuleCheck struct {
	RuleID string
	Miss   string
}

// Explain is Rules.Decide with every enabled rule's verdict, for showing
// the person why a message would or would not come through.
func Explain(rules []store.MessageChannelRule, envelope store.MessageEnvelope) (Decision, []RuleCheck) {
	checks := []RuleCheck{}
	for _, rule := range rules {
		if rule.Enabled {
			checks = append(checks, RuleCheck{RuleID: rule.ID, Miss: RuleMiss(rule, envelope)})
		}
	}
	return Rules(rules).Decide(envelope), checks
}

// Capabilities are what a feed's envelope mapping can tell apart: the
// conversation kinds it produces (nil: it does not say), and whether it
// marks mentions of the person and the person's own messages.
func Capabilities(spec store.ConnectorEventsEnvelope) store.MessageChannelCapabilities {
	capabilities := store.MessageChannelCapabilities{ConversationKinds: []string{}}
	if field, ok := spec.Fields["conversation.kind"]; ok {
		seen := map[string]bool{}
		values := []string{field.Otherwise}
		for _, value := range field.Map {
			values = append(values, value)
		}
		for _, next := range field.Cases {
			values = append(values, next.Value)
		}
		for _, value := range values {
			if conversationKinds[value] && value != "other" && !seen[value] {
				seen[value] = true
				capabilities.ConversationKinds = append(capabilities.ConversationKinds, value)
			}
		}
		slices.Sort(capabilities.ConversationKinds)
	}
	_, capabilities.MentionsMe = spec.Fields["mentionsMe"]
	_, capabilities.FromSelf = spec.Fields["sender.isSelf"]
	return capabilities
}
