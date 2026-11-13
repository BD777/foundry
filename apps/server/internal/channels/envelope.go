// Package channels brings messages from a connector's event feed to an
// assistant (DEV-203, docs/devlog/DEV-203-message-channels.md): a Source
// reads batches of envelopes from the feed, the channel's filter keeps the
// messages meant for the assistant, and the dispatcher hands them, as a
// short factual notice, to one assistant session per source conversation.
// What the assistant then does (reply, react, do nothing, start a helper) is
// its own decision with its own tools; Foundry only bounds what those
// sessions may use and records what happened.
//
// Nothing here knows a particular product: a feed is described by the
// connector's descriptor (store.ConnectorEventsSpec), and the envelope's
// fields are generic.
package channels

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Limits of what one envelope keeps.
const (
	maxEnvelopeText    = 8 * 1024
	maxEnvelopeID      = 512
	maxEnvelopeValue   = 512
	maxAttributes      = 16
	maxAttributeLength = 256
)

// conversationKinds are the generic kinds an envelope's conversation has.
var conversationKinds = map[string]bool{"direct": true, "self": true, "group": true, "channel": true, "feed": true, "other": true}

// EnvelopeFields are the keys a descriptor's envelope mapping may set;
// attributes.<name> is also allowed.
var EnvelopeFields = []string{
	"id", "kind", "op", "occurredAt", "conversation.id", "conversation.kind", "conversation.name",
	"thread.id", "thread.isReply", "message.id", "text", "sender.id", "sender.name", "sender.isSelf",
	"sender.isBot", "mentionsMe",
}

// ValidEnvelopeField reports whether a mapping may set key.
func ValidEnvelopeField(key string) bool {
	if name, ok := strings.CutPrefix(key, "attributes."); ok {
		return name != "" && len(name) <= 64 && !strings.ContainsAny(name, " ./")
	}
	for _, field := range EnvelopeFields {
		if field == key {
			return true
		}
	}
	return false
}

// MapItem turns one feed item into an envelope with the descriptor's
// mapping; skip is true when a skipWhen condition matches. An item without
// an id is an error: the channel could not tell it from the next one.
func MapItem(spec store.ConnectorEventsEnvelope, item any) (envelope store.MessageEnvelope, skip bool, err error) {
	for _, condition := range spec.SkipWhen {
		if conditionHolds(item, condition) {
			return envelope, true, nil
		}
	}
	envelope.Kind, envelope.Op = "message", OpNew
	envelope.Conversation.Kind = "other"
	for key, field := range spec.Fields {
		value, present := fieldValue(field, item)
		if !present {
			continue
		}
		if err := setEnvelopeField(&envelope, key, value, field.Unit); err != nil {
			return envelope, false, err
		}
	}
	if envelope.ID == "" {
		return envelope, false, fmt.Errorf("a feed item has no id")
	}
	if !conversationKinds[envelope.Conversation.Kind] {
		envelope.Conversation.Kind = "other"
	}
	return envelope, false, nil
}

// conditionHolds reports whether the value at the condition's pointer is
// present and equals its text or the (non-empty) value at equalsPointer.
func conditionHolds(item any, condition store.ConnectorEventsCondition) bool {
	raw, ok := Pointer(item, condition.Pointer)
	if !ok {
		return false
	}
	value := scalar(raw)
	if condition.EqualsPointer != "" {
		other, ok := Pointer(item, condition.EqualsPointer)
		return ok && value != "" && value == scalar(other)
	}
	return value == condition.Equals
}

func fieldValue(field store.ConnectorEventsValue, item any) (string, bool) {
	for _, next := range field.Cases {
		holds := len(next.When) > 0
		for _, condition := range next.When {
			holds = holds && conditionHolds(item, condition)
		}
		if holds {
			return next.Value, true
		}
	}
	var value string
	switch {
	case field.Template != "":
		value = renderPointers(field.Template, item)
	case field.Pointer != "":
		raw, ok := Pointer(item, field.Pointer)
		if !ok || raw == nil {
			if field.Otherwise != "" && len(field.Map) > 0 {
				return field.Otherwise, true
			}
			return "", false
		}
		value = scalar(raw)
	default:
		return "", false
	}
	if len(field.Map) > 0 {
		if mapped, ok := field.Map[value]; ok {
			return mapped, true
		}
		if field.Otherwise != "" {
			return field.Otherwise, true
		}
	}
	return value, true
}

func setEnvelopeField(envelope *store.MessageEnvelope, key, value, unit string) error {
	short := clip(value, maxEnvelopeValue)
	switch key {
	case "id":
		envelope.ID = clip(value, maxEnvelopeID)
	case "kind":
		envelope.Kind = short
	case "op":
		envelope.Op = short
	case "occurredAt":
		at, ok := readTime(value, unit)
		if ok {
			envelope.OccurredAt = at
		}
	case "conversation.id":
		envelope.Conversation.ID = short
	case "conversation.kind":
		envelope.Conversation.Kind = short
	case "conversation.name":
		envelope.Conversation.Name = short
	case "thread.id":
		envelope.Thread.ID = short
	case "thread.isReply":
		envelope.Thread.IsReply = value == "true"
	case "message.id":
		envelope.MessageID = short
	case "text":
		envelope.Text = clip(value, maxEnvelopeText)
		envelope.TextTruncated = len(envelope.Text) < len(value)
	case "sender.id":
		envelope.Sender.ID = short
	case "sender.name":
		envelope.Sender.Name = short
	case "sender.isSelf":
		envelope.Sender.IsSelf = value == "true"
	case "sender.isBot":
		envelope.Sender.IsBot = value == "true"
	case "mentionsMe":
		envelope.MentionsMe = value == "true"
	default:
		name, ok := strings.CutPrefix(key, "attributes.")
		if !ok {
			return fmt.Errorf("envelope field %q is unknown", key)
		}
		if value == "" {
			return nil
		}
		if envelope.Attributes == nil {
			envelope.Attributes = map[string]string{}
		}
		if len(envelope.Attributes) < maxAttributes {
			envelope.Attributes[name] = clip(value, maxAttributeLength)
		}
	}
	return nil
}

func readTime(value, unit string) (string, bool) {
	switch unit {
	case "ms", "s":
		number, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return "", false
		}
		if unit == "s" {
			number *= 1000
		}
		return time.UnixMilli(int64(number)).UTC().Format(time.RFC3339Nano), true
	default:
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			return "", false
		}
		return parsed.UTC().Format(time.RFC3339Nano), true
	}
}

// Pointer is the value at an RFC 6901 JSON pointer of document.
func Pointer(document any, pointer string) (any, bool) {
	if pointer == "" {
		return document, true
	}
	if !strings.HasPrefix(pointer, "/") {
		return nil, false
	}
	current := document
	for _, token := range strings.Split(pointer[1:], "/") {
		token = strings.ReplaceAll(strings.ReplaceAll(token, "~1", "/"), "~0", "~")
		switch value := current.(type) {
		case map[string]any:
			next, ok := value[token]
			if !ok {
				return nil, false
			}
			current = next
		case []any:
			index, err := strconv.Atoi(token)
			if err != nil || index < 0 || index >= len(value) {
				return nil, false
			}
			current = value[index]
		default:
			return nil, false
		}
	}
	return current, true
}

// renderPointers fills `{/pointer}` parts of template from item.
func renderPointers(template string, item any) string {
	var out strings.Builder
	for {
		start := strings.Index(template, "{/")
		if start < 0 {
			out.WriteString(template)
			return out.String()
		}
		end := strings.Index(template[start:], "}")
		if end < 0 {
			out.WriteString(template)
			return out.String()
		}
		out.WriteString(template[:start])
		if value, ok := Pointer(item, template[start+1:start+end]); ok {
			out.WriteString(scalar(value))
		}
		template = template[start+end+1:]
	}
}

func scalar(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case json.Number:
		return v.String()
	default:
		raw, _ := json.Marshal(v)
		return string(raw)
	}
}

// clip cuts s to at most limit bytes on a rune boundary.
func clip(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
