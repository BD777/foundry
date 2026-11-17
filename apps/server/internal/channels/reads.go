package channels

import (
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Declared reads (DEV-268): facts the feed's items do not carry — the
// conversation's readable name, a message's text and card title, a thread's
// replies — come from read routes the connector's descriptor declares
// (serverHeld.events.reads). The runner asks the source; the source fills the
// route's parameters from the turn's facts and maps the answer.

// ReadAnswer is one declared read's answer: the named fields, and the named
// fields of each item when the read names a list.
type ReadAnswer struct {
	Fields map[string]string
	Items  []map[string]string
}

// readAnswer maps a read's answer with its declared fields.
func readAnswer(document any, spec store.ConnectorEventsRead) ReadAnswer {
	answer := ReadAnswer{Fields: map[string]string{}}
	readFields(document, spec.Fields, answer.Fields)
	if spec.Items != "" {
		items, _ := Pointer(document, spec.Items)
		list, _ := items.([]any)
		for _, item := range list {
			fields := map[string]string{}
			readFields(item, spec.Fields, fields)
			answer.Items = append(answer.Items, fields)
		}
	}
	return answer
}

func readFields(document any, spec map[string]store.ConnectorEventsValue, out map[string]string) {
	for name, field := range spec {
		if value, ok := readValue(field, document); ok && value != "" {
			out[name] = value
		}
	}
}

// readValue is rawFieldValue with the time units applied, for a read's
// values (an envelope field keeps its own setter).
func readValue(field store.ConnectorEventsValue, document any) (string, bool) {
	value, present := rawFieldValue(field, document)
	if !present {
		return "", false
	}
	if field.Unit != "" {
		if at, ok := readTime(value, field.Unit); ok {
			return at, true
		}
		return "", false
	}
	return value, true
}

// fillReadPath fills a read's route parameters (":feedId", or "{feedId}")
// from the turn's facts, per the read's args. A parameter without a fact is
// left empty, which the caller treats as an unusable read.
func fillReadPath(path string, args map[string]string, facts map[string]string) (string, bool) {
	segments := strings.Split(path, "/")
	for i, segment := range segments {
		name := ""
		switch {
		case strings.HasPrefix(segment, ":"):
			name = segment[1:]
		case strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") && len(segment) > 2:
			name = segment[1 : len(segment)-1]
		default:
			continue
		}
		fact := args[name]
		if fact == "" {
			fact = args[":"+name]
		}
		value := facts[fact]
		if fact == "" || value == "" {
			return "", false
		}
		segments[i] = value
	}
	return strings.Join(segments, "/"), true
}

// ReadFacts are the facts a read's path parameters may be filled from.
func ReadFacts(conversationID, messageID, threadID string) map[string]string {
	return map[string]string{"conversation.id": conversationID, "message.id": messageID, "thread.id": threadID}
}
