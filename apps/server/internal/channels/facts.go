package channels

import (
	"context"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A turn's surroundings (DEV-268), read through the source's declared reads:
// the conversation's readable name, and the thread's root message and earlier
// replies. Best effort: a read that fails leaves the envelope's facts as they
// are, and the turn goes on.

// maxThreadReplies bounds the thread replies one notice carries.
const maxThreadReplies = 20

// Facts are what the source's reads say about a batch.
type Facts struct {
	// ConversationName is the conversation's readable name (a direct chat's
	// other participant, a group's name); "" when the feed's name stands.
	ConversationName string
	// Thread is the thread's root and earlier replies; nil outside a thread.
	Thread *ThreadFacts
}

// ThreadFacts are a thread's root message and the replies before the batch.
type ThreadFacts struct {
	Root    *MessageFact
	Replies []MessageFact
	// Skipped counts replies over the cap.
	Skipped int
}

// MessageFact is one message as the source's read describes it.
type MessageFact struct {
	ID         string
	SenderID   string
	SenderName string
	IsSelf     bool
	At         string
	Text       string
	// Kind is the part kind of a message without text (image, card, file…).
	Kind string
	// Media is a media part's key, for the source's own media read.
	Media string
}

// readFacts gathers a batch's facts with the source's declared reads.
func readFacts(ctx context.Context, source Source, records []store.MessageChannelDeliveryRecord) Facts {
	var facts Facts
	if len(records) == 0 {
		return facts
	}
	first := records[0].Envelope
	read := ReadFacts(first.Conversation.ID, cmpOr(first.MessageID, first.ID), first.Thread.ID)
	if name := conversationName(ctx, source, first, records, read); name != "" {
		facts.ConversationName = name
	}
	if first.Thread.ID != "" {
		facts.Thread = threadFacts(ctx, source, first, read)
	}
	return facts
}

// conversationName reads the conversation's name when the feed's own name is
// not the other participant's: a direct (or own) chat. A conversation the
// source cannot name falls back to its members.
func conversationName(ctx context.Context, source Source, first store.MessageEnvelope, records []store.MessageChannelDeliveryRecord, read map[string]string) string {
	kind := first.Conversation.Kind
	if kind != "direct" && kind != "self" && first.Conversation.Name != "" {
		return ""
	}
	answer, err := source.Read(ctx, "conversation", read)
	if err == nil {
		if name := strings.TrimSpace(answer.Fields["name"]); name != "" {
			return name
		}
	}
	if kind != "direct" && kind != "self" {
		return ""
	}
	// A direct chat the conversation read leaves generic: its members name
	// the participant who is not the person.
	self := ""
	for _, record := range records {
		if record.Envelope.Sender.IsSelf {
			self = record.Envelope.Sender.ID
			break
		}
	}
	members, err := source.Read(ctx, "members", read)
	if err != nil || len(members.Items) == 0 {
		return ""
	}
	if self != "" {
		for _, member := range members.Items {
			if id := member["id"]; id != "" && id != self && strings.TrimSpace(member["name"]) != "" {
				return strings.TrimSpace(member["name"])
			}
		}
		return ""
	}
	if len(members.Items) == 1 {
		return strings.TrimSpace(members.Items[0]["name"])
	}
	return ""
}

// threadFacts reads the thread's root and the replies that came before the
// trigger, oldest first.
func threadFacts(ctx context.Context, source Source, first store.MessageEnvelope, read map[string]string) *ThreadFacts {
	facts := &ThreadFacts{}
	if first.Thread.IsReply {
		rootRead := ReadFacts(first.Conversation.ID, first.Thread.ID, first.Thread.ID)
		if answer, err := source.Read(ctx, "message", rootRead); err == nil {
			if fact := messageFact(answer.Fields); fact.ID != "" || fact.Text != "" || fact.Kind != "" {
				facts.Root = &fact
			}
		}
	}
	answer, err := source.Read(ctx, "thread", read)
	if err != nil {
		return facts
	}
	at := first.OccurredAt
	seen := map[string]bool{first.Thread.ID: true}
	for _, item := range answer.Items {
		fact := messageFact(item)
		if fact.ID == "" || seen[fact.ID] || fact.ID == cmpOr(first.MessageID, first.ID) {
			continue
		}
		if at != "" && fact.At != "" && fact.At > at {
			continue
		}
		seen[fact.ID] = true
		facts.Replies = append(facts.Replies, fact)
	}
	if len(facts.Replies) > maxThreadReplies {
		facts.Skipped = len(facts.Replies) - maxThreadReplies
		facts.Replies = facts.Replies[len(facts.Replies)-maxThreadReplies:]
	}
	return facts
}

// messageFact is one read answer as a message: the text it says, or a title
// for a card, or the kind of part that has no words.
func messageFact(fields map[string]string) MessageFact {
	fact := MessageFact{
		ID: fields["id"], SenderID: fields["senderId"], SenderName: strings.TrimSpace(fields["sender"]),
		IsSelf: fields["isMine"] == "true", At: fields["at"], Media: fields["media"],
	}
	if fact.ID == "" {
		fact.ID = fields["messageId"]
	}
	text := cmpOr(strings.TrimSpace(fields["text"]), strings.TrimSpace(fields["partText"]))
	if text == "" {
		text = strings.TrimSpace(fields["title"])
	}
	fact.Text = text
	fact.Kind = strings.TrimSpace(fields["partKind"])
	if fact.Kind == "text" || fact.Kind == "table" || fact.Kind == "code" {
		fact.Kind = ""
	}
	return fact
}

// factAt is a fact's time for a notice, as it reads.
func factAt(at string) string {
	if parsed, err := time.Parse(time.RFC3339Nano, at); err == nil {
		return parsed.UTC().Format(time.RFC3339)
	}
	return at
}
