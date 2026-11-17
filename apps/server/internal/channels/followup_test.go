package channels

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A message the assistant wrote itself never continues a conversation, and
// the from setting decides who else may.
func TestFollowUpsIgnoreOwnWritesAndRespectFrom(t *testing.T) {
	channel := store.MessageChannel{SessionKey: "conversation"}
	index := newFollowUpIndex()
	index.conversations["c:oc_1"] = &followUpBinding{SessionKey: "c:oc_1", FirstSenderID: "ou_peer", Since: "2026-11-13T09:00:00Z"}
	index.threads[threadBindingKey("oc_1", "th_1")] = &followUpBinding{SessionKey: "c:oc_1", FirstSenderID: "ou_peer", Since: "2026-11-13T09:00:00Z"}
	index.quotes["m1"] = followUpQuote{SenderID: "ou_peer", Since: "2026-11-13T09:00:00Z"}
	envelope := store.MessageEnvelope{
		ID: "new:2", MessageID: "2", Conversation: store.MessageEnvelopeConversation{ID: "oc_1", Kind: "group"},
		Thread: store.MessageEnvelopeThread{ID: "th_1"}, Sender: store.MessageEnvelopeSender{ID: "ou_peer"}, Text: "接着说",
	}
	sameSender := FollowUpConfig{Enabled: true, From: FollowUpSameSender, EndCommands: []string{"/end"}}
	if fact, ok := index.followUp(channel, sameSender, envelope); !ok ||
		fact != "thread th_1 (since 2026-11-13T09:00:00Z) by ou_peer, not the person" {
		t.Fatalf("same sender: %q %v", fact, ok)
	}
	own := envelope
	own.Sender.IsOwnWrite = true
	if _, ok := index.followUp(channel, sameSender, own); ok {
		t.Fatal("the assistant's own write continued the thread")
	}
	bot := envelope
	bot.Sender.IsBot = true
	if _, ok := index.followUp(channel, sameSender, bot); ok {
		t.Fatal("a bot message continued the thread")
	}
	other := envelope
	other.Sender.ID = "ou_other"
	if _, ok := index.followUp(channel, sameSender, other); ok {
		t.Fatal("another sender continued a same-sender thread")
	}
	// Thread participants: anyone in a thread continues it, while a quote
	// outside a thread stays the first sender's (DEV-268).
	threadParticipants := FollowUpConfig{Enabled: true, From: FollowUpThreadParticipants, EndCommands: []string{"/end"}}
	if fact, ok := index.followUp(channel, threadParticipants, other); !ok ||
		fact != "thread th_1 (since 2026-11-13T09:00:00Z) by ou_other, not the person" {
		t.Fatalf("thread participant: %q %v", fact, ok)
	}
	if _, ok := index.followUp(channel, threadParticipants, own); ok {
		t.Fatal("the assistant's own write continued a thread of participants")
	}
	quote := envelope
	quote.Thread = store.MessageEnvelopeThread{}
	quote.Attributes = map[string]string{"replyTo": "m1"}
	quote.Sender = store.MessageEnvelopeSender{ID: "ou_other"}
	if _, ok := index.followUp(channel, threadParticipants, quote); ok {
		t.Fatal("another sender continued a quote outside a thread")
	}
	quote.Sender = store.MessageEnvelopeSender{ID: "ou_peer"}
	if _, ok := index.followUp(channel, threadParticipants, quote); !ok {
		t.Fatal("the first sender continued a quote outside a thread")
	}
	if _, ok := index.followUpEnd(channel, threadParticipants, store.MessageEnvelope{
		Conversation: envelope.Conversation, Thread: envelope.Thread, Sender: other.Sender, Text: "/end",
	}); !ok {
		t.Fatal("thread participants may end the follow-up")
	}
	if _, ok := index.followUp(channel, FollowUpConfig{Enabled: true, From: FollowUpAnyone, EndCommands: []string{"/end"}}, other); !ok {
		t.Fatal("anyone may continue an anyone thread")
	}
	person := other
	person.Sender.IsSelf = true
	if _, ok := index.followUp(channel, FollowUpConfig{Enabled: true, From: FollowUpPerson, EndCommands: []string{"/end"}}, person); !ok {
		t.Fatal("the person may continue a person thread")
	}
	// Off stays off.
	if _, ok := index.followUp(channel, FollowUpConfig{Enabled: false, From: FollowUpAnyone}, envelope); ok {
		t.Fatal("follow-ups are off")
	}
	// An end command comes from the same allowed sender and needs a binding.
	if key, ok := index.followUpEnd(channel, sameSender, store.MessageEnvelope{
		Conversation: envelope.Conversation, Thread: envelope.Thread, Sender: envelope.Sender, Text: "/end",
	}); !ok || key != "c:oc_1" {
		t.Fatalf("end command: %q %v", key, ok)
	}
	if _, ok := index.followUpEnd(channel, sameSender, store.MessageEnvelope{
		Conversation: envelope.Conversation, Thread: envelope.Thread, Sender: store.MessageEnvelopeSender{ID: "ou_other"}, Text: "/end",
	}); ok {
		t.Fatal("another sender ended a same-sender thread")
	}
}

// A quote of a delivered message continues a chat without threads.
func TestFollowUpsMatchAQuoteWithoutThreads(t *testing.T) {
	channel := store.MessageChannel{SessionKey: "conversation"}
	index := newFollowUpIndex()
	index.conversations["c:oc_1"] = &followUpBinding{SessionKey: "c:oc_1", FirstSenderID: "ou_peer", Since: "2026-11-13T09:00:00Z"}
	index.quotes["m1"] = followUpQuote{SenderID: "ou_peer", Since: "2026-11-13T09:00:00Z"}
	config := FollowUpConfig{Enabled: true, From: FollowUpSameSender}
	quote := store.MessageEnvelope{
		ID: "new:2", MessageID: "2", Conversation: store.MessageEnvelopeConversation{ID: "oc_1", Kind: "direct"},
		Sender: store.MessageEnvelopeSender{ID: "ou_peer"}, Text: "引用",
		Attributes: map[string]string{"replyTo": "m1"},
	}
	if fact, ok := index.followUp(channel, config, quote); !ok ||
		fact != "quote m1 (since 2026-11-13T09:00:00Z) by ou_peer, not the person" {
		t.Fatalf("quote: %q %v", fact, ok)
	}
	// A plain message of a chat without threads stays out.
	plain := quote
	plain.Attributes = nil
	if _, ok := index.followUp(channel, config, plain); ok {
		t.Fatal("a plain message continued a chat without threads")
	}
	// A reply to a message the assistant wrote continues the chat.
	index.ownWrites = map[string]bool{"a1": true}
	toAssistant := plain
	toAssistant.Attributes = map[string]string{"replyTo": "a1", "replyToMe": "true"}
	if _, ok := index.followUp(channel, config, toAssistant); !ok {
		t.Fatal("a reply to the assistant did not continue the chat")
	}
	// On the person's own account replyToMe also marks a reply to the
	// person's own message: the person answering their own message to
	// someone else is not talking to the assistant.
	toOwnMessage := plain
	toOwnMessage.Sender = store.MessageEnvelopeSender{ID: "ou_me", IsSelf: true}
	toOwnMessage.Attributes = map[string]string{"replyTo": "p1", "replyToMe": "true"}
	if _, ok := index.followUp(channel, FollowUpConfig{Enabled: true, From: FollowUpAnyone}, toOwnMessage); ok {
		t.Fatal("a reply to the person's own message went to the assistant")
	}
}

func TestFollowUpRuleDefaults(t *testing.T) {
	config := FollowUpRule(store.MessageChannel{})
	if !config.Enabled || config.From != FollowUpThreadParticipants || len(config.EndCommands) != 1 || config.EndCommands[0] != "/end" {
		t.Fatalf("defaults: %+v", config)
	}
	empty := FollowUpRule(store.MessageChannel{FollowUps: &store.MessageChannelFollowUps{Enabled: false, EndCommands: []string{}}})
	if empty.Enabled || empty.From != FollowUpThreadParticipants || len(empty.EndCommands) != 0 {
		t.Fatalf("a saved rule: %+v", empty)
	}
}

// A failed session ends the conversation's binding; the next trigger starts
// a new one, not a follow-up.
func TestFollowUpBindingEndsOnSessionFailure(t *testing.T) {
	st, err := sqlitestore.Open(filepath.Join(t.TempDir(), "foundry.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()
	channel := store.MessageChannelRecord{UserID: "u1", MessageChannel: store.MessageChannel{
		ID: "mch_test", AssistantID: "asst_1", Name: "Lark", Enabled: true, SessionKey: "thread",
		Source: store.MessageChannelSource{Kind: "openlark", AccountID: "xacc_1"},
		Limits: store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3}, CreatedAt: "2026-11-13T00:00:00Z", UpdatedAt: "2026-11-13T00:00:00Z",
	}}
	if err := st.SaveMessageChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	runner := NewRunner(Ports{Store: st, Now: time.Now})
	record := store.MessageChannelDeliveryRecord{UserID: "u1", AssistantID: "asst_1", InboxID: "inbox_1",
		MessageChannelDelivery: store.MessageChannelDelivery{ID: "dlv_1", ChannelID: channel.ID, Status: store.MessageDeliveryDone,
			Rule: "dm", SessionKey: "c:oc_1", Segment: 0, SessionID: "sess_1", CreatedAt: "2026-11-13T09:00:00Z"}}
	record.Envelope = store.MessageEnvelope{ID: "new:1", MessageID: "1", Kind: "message", Op: "new",
		OccurredAt: "2026-11-13T09:00:00Z", Conversation: store.MessageEnvelopeConversation{ID: "oc_1", Kind: "direct"},
		Thread: store.MessageEnvelopeThread{ID: "th_1"}, Sender: store.MessageEnvelopeSender{ID: "ou_peer"}, Text: "/fd hi"}
	if _, err := st.RecordMessageChannelBatch(ctx, channel.ID, []store.MessageChannelDeliveryRecord{record}, "c1"); err != nil {
		t.Fatal(err)
	}
	if index := runner.followUps(ctx, channel.MessageChannel); index.conversations["c:oc_1"] == nil || index.threads[threadBindingKey("oc_1", "th_1")] == nil {
		t.Fatalf("the delivered turn is a binding: %+v", index.threads)
	}
	record.Status, record.Reason = store.MessageDeliveryFailed, "execution_failed"
	if err := st.SaveMessageChannelDelivery(ctx, record); err != nil {
		t.Fatal(err)
	}
	if index := runner.followUps(ctx, channel.MessageChannel); index.conversations["c:oc_1"] != nil || index.threads[threadBindingKey("oc_1", "th_1")] != nil {
		t.Fatal("a failed session still accepts follow-ups")
	}
}
