package channels

import (
	"context"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Follow-up messages (DEV-233): once a message has matched a rule, later
// messages of the same thread, or replies and quotes of messages the channel
// delivered, continue that conversation without a trigger word. The rules
// stay a fallback: a message that still matches a rule is a new trigger.

// Who may continue a conversation without a trigger word.
const (
	FollowUpSameSender = "same-sender"
	FollowUpPerson     = "person"
	FollowUpAnyone     = "anyone"
)

const (
	// RuleFollowUp is the rule a follow-up is kept by.
	RuleFollowUp = "follow_up"
	// ReasonFollowUpEnd is why an end command was dropped.
	ReasonFollowUpEnd = "follow_up_end"
	// ReasonOwnWrite is why the assistant's own write was dropped.
	ReasonOwnWrite = "own_write"
	// NewFollowUpEnd is the key state's reason: the next trigger starts a
	// new session because the conversation's follow-ups were ended.
	NewFollowUpEnd = "ended"
)

// FollowUpConfig is the channel's follow-up rule with its defaults.
type FollowUpConfig struct {
	Enabled     bool
	From        string
	EndCommands []string
}

// FollowUpRule is the channel's follow-up rule with its defaults: enabled,
// the sender of the first message, and /end.
func FollowUpRule(channel store.MessageChannel) FollowUpConfig {
	if channel.FollowUps == nil {
		return FollowUpConfig{Enabled: true, From: FollowUpSameSender, EndCommands: []string{"/end"}}
	}
	config := FollowUpConfig{Enabled: channel.FollowUps.Enabled, From: channel.FollowUps.From}
	if config.From == "" {
		config.From = FollowUpSameSender
	}
	for _, command := range channel.FollowUps.EndCommands {
		if command = strings.TrimSpace(command); command != "" {
			config.EndCommands = append(config.EndCommands, command)
		}
	}
	return config
}

// followUpBinding is a conversation the channel already handed over: the
// thread it started in ("" when it has none), its first sender and when.
type followUpBinding struct {
	SessionKey    string
	FirstSenderID string
	Since         string
}

type followUpQuote struct {
	SenderID string
	Since    string
}

// followUpIndex answers, for the messages of one poll, whether a thread is
// bound, which delivered messages may be quoted, and which conversations
// were ended in the same batch.
type followUpIndex struct {
	conversations map[string]*followUpBinding
	threads       map[string]*followUpBinding
	quotes        map[string]followUpQuote
}

func newFollowUpIndex() followUpIndex {
	return followUpIndex{
		conversations: map[string]*followUpBinding{},
		threads:       map[string]*followUpBinding{},
		quotes:        map[string]followUpQuote{},
	}
}

func threadBindingKey(conversationID, threadID string) string {
	return conversationID + "\x00" + threadID
}

// followUps reads the channel's recent hand-overs and returns its active
// bindings and the messages a reply may quote. A failed session or an
// explicit end ends a binding; the idle rule does not (the follow-up still
// starts the next segment).
func (r *Runner) followUps(ctx context.Context, channel store.MessageChannel) followUpIndex {
	index := newFollowUpIndex()
	records, err := r.ports.Store.ListMessageChannelDeliveries(ctx, channel.ID,
		[]string{store.MessageDeliveryQueued, store.MessageDeliveryDelivered, store.MessageDeliveryDone, store.MessageDeliveryFailed}, 500)
	if err != nil {
		return index
	}
	sortRecords(records) // oldest first
	byKey := map[string][]store.MessageChannelDeliveryRecord{}
	var keys []string
	for _, record := range records {
		if _, ok := byKey[record.SessionKey]; !ok {
			keys = append(keys, record.SessionKey)
		}
		byKey[record.SessionKey] = append(byKey[record.SessionKey], record)
	}
	for _, key := range keys {
		group := byKey[key]
		latest := group[len(group)-1]
		state, err := r.ports.Store.GetMessageChannelKey(ctx, channel.ID, key)
		if err != nil || state.ResetPending != "" || latest.Status == store.MessageDeliveryFailed {
			continue
		}
		segment := latest.Segment
		if state.Segment > segment {
			segment = state.Segment
		}
		inSegment := func(record store.MessageChannelDeliveryRecord) bool {
			return record.Segment == segment || record.Segment == 0 && record.InboxID == ""
		}
		var conversation *followUpBinding
		for _, record := range group {
			if !inSegment(record) {
				continue
			}
			binding := followUpBinding{SessionKey: key, FirstSenderID: record.Envelope.Sender.ID, Since: bindingSince(record)}
			if conversation == nil {
				conversation = &binding
			}
			if thread := record.Envelope.Thread.ID; thread != "" {
				threadKey := threadBindingKey(record.Envelope.Conversation.ID, thread)
				if _, ok := index.threads[threadKey]; !ok {
					index.threads[threadKey] = &binding
				}
			}
		}
		if conversation != nil {
			index.conversations[key] = conversation
		}
	}
	for _, record := range records {
		if record.Status == store.MessageDeliveryFailed || record.Rule == "" {
			continue
		}
		quote := followUpQuote{SenderID: record.Envelope.Sender.ID, Since: bindingSince(record)}
		index.addQuote(record.Envelope.MessageID, quote)
		index.addQuote(record.Envelope.ID, quote)
	}
	return index
}

func (index followUpIndex) addQuote(id string, quote followUpQuote) {
	if id == "" {
		return
	}
	if _, ok := index.quotes[id]; !ok {
		index.quotes[id] = quote
	}
}

// add remembers a message this batch hands over, so a later message of the
// same poll can continue it before the dispatcher runs.
func (index followUpIndex) add(channel store.MessageChannel, envelope store.MessageEnvelope, createdAt string) {
	key := SessionKey(channel, envelope)
	since := cmpOr(envelope.OccurredAt, createdAt)
	if _, ok := index.conversations[key]; !ok {
		index.conversations[key] = &followUpBinding{SessionKey: key, FirstSenderID: envelope.Sender.ID, Since: since}
	}
	if thread := envelope.Thread.ID; thread != "" {
		threadKey := threadBindingKey(envelope.Conversation.ID, thread)
		if _, ok := index.threads[threadKey]; !ok {
			index.threads[threadKey] = &followUpBinding{SessionKey: key, FirstSenderID: envelope.Sender.ID, Since: since}
		}
	}
	quote := followUpQuote{SenderID: envelope.Sender.ID, Since: since}
	index.addQuote(envelope.MessageID, quote)
	index.addQuote(envelope.ID, quote)
}

// end drops the conversation's bindings after an end command.
func (index followUpIndex) end(sessionKey string) {
	delete(index.conversations, sessionKey)
	for threadKey, binding := range index.threads {
		if binding.SessionKey == sessionKey {
			delete(index.threads, threadKey)
		}
	}
}

// bindingFor is the conversation binding and the thread binding of a
// message, nil when there is none.
func (index followUpIndex) bindingFor(channel store.MessageChannel, envelope store.MessageEnvelope) (conversation, thread *followUpBinding) {
	conversation = index.conversations[SessionKey(channel, envelope)]
	thread = index.threads[threadBindingKey(envelope.Conversation.ID, envelope.Thread.ID)]
	return conversation, thread
}

// followUp reports whether envelope continues an earlier message, and the
// fact the notice states about it.
func (index followUpIndex) followUp(channel store.MessageChannel, config FollowUpConfig, envelope store.MessageEnvelope) (string, bool) {
	if !config.Enabled || envelope.Sender.IsBot || envelope.Sender.IsOwnWrite {
		return "", false
	}
	conversation, thread := index.bindingFor(channel, envelope)
	replyTo := strings.TrimSpace(envelope.Attributes["replyTo"])
	quote, quoted := index.quotes[replyTo]
	// replyToMe marks a reply to one of the assistant's own messages, which
	// the source does not name by id.
	replyToMe := envelope.Attributes["replyToMe"] == "true"
	threadActive := thread != nil
	if !threadActive && !((quoted || replyToMe) && conversation != nil) {
		return "", false
	}
	// A chat without threads continues only by replying or quoting.
	if envelope.Thread.ID == "" && !quoted && !replyToMe {
		return "", false
	}
	firstSender := ""
	switch {
	case threadActive:
		firstSender = thread.FirstSenderID
	case quoted:
		firstSender = quote.SenderID
	case conversation != nil:
		firstSender = conversation.FirstSenderID
	}
	if !followUpSenderAllowed(config.From, envelope, firstSender) {
		return "", false
	}
	if threadActive {
		return "thread " + envelope.Thread.ID + " (since " + thread.Since + ")", true
	}
	if quoted {
		return "quote " + replyTo + " (since " + quote.Since + ")", true
	}
	return "quote (since " + conversation.Since + ")", true
}

// followUpEnd reports whether envelope ends the conversation's follow-ups.
func (index followUpIndex) followUpEnd(channel store.MessageChannel, config FollowUpConfig, envelope store.MessageEnvelope) (string, bool) {
	if !config.Enabled || len(config.EndCommands) == 0 || envelope.Sender.IsBot || envelope.Sender.IsOwnWrite {
		return "", false
	}
	conversation, thread := index.bindingFor(channel, envelope)
	binding := thread
	if binding == nil {
		binding = conversation
	}
	if binding == nil {
		return "", false
	}
	if !followUpSenderAllowed(config.From, envelope, binding.FirstSenderID) {
		return "", false
	}
	if _, ok := StripCommand(envelope.Text, ChannelTriggers(channel), config.EndCommands); !ok {
		return "", false
	}
	return binding.SessionKey, true
}

func followUpSenderAllowed(from string, envelope store.MessageEnvelope, firstSenderID string) bool {
	switch from {
	case FollowUpAnyone:
		return true
	case FollowUpPerson:
		return envelope.Sender.IsSelf
	default:
		return firstSenderID != "" && envelope.Sender.ID == firstSenderID
	}
}

func bindingSince(record store.MessageChannelDeliveryRecord) string {
	return cmpOr(record.Envelope.OccurredAt, record.CreatedAt)
}
