package store

import "context"

// Message channels (DEV-203): a connector's event feed that brings messages
// to one assistant. The channel itself (MessageChannel) is what the person
// sets; the runtime row keeps the feed's cursor and state; every message the
// feed hands over becomes one delivery record, the channel's audit trail.

// MessageChannelRecord is a channel with the person it belongs to.
type MessageChannelRecord struct {
	UserID string
	MessageChannel
}

// MessageChannelRuntime is a channel's feed position and state.
type MessageChannelRuntime struct {
	ChannelID   string
	Cursor      string
	State       string
	Detail      string
	LastPollAt  string
	LastEventAt string
	LastErrorAt string
	GapAt       string
	UpdatedAt   string
}

// MessageChannelDeliveryRecord is one envelope a channel read, what its
// filter decided and where it went. InboxID names the assistant inbox entry
// that carried it to SessionKey's session.
type MessageChannelDeliveryRecord struct {
	MessageChannelDelivery
	UserID      string
	AssistantID string
	InboxID     string
	// InboxChannel is the assistant inbox channel of the record's segment
	// (its session); RawJSON the source's own item, for a matched message.
	InboxChannel string
	RawJSON      string
	// FollowUp is the fact that made a follow-up continue an earlier
	// message (a thread and when it started, or a quoted message), for the
	// notice; "" otherwise.
	FollowUp string
	// AckHeld says the source's acknowledgement reaction is on this
	// message's trigger and has not come off yet: it stays while the turn,
	// every session it started, and a hand-over it left open still hold
	// (DEV-268, DEV-279).
	AckHeld bool
	// AckAddedAt and AckRemovedAt record when the reaction went on and came
	// off the message, so the channel's audit says when the assistant said
	// "on it", not only whether it did (DEV-279).
	AckAddedAt   string
	AckRemovedAt string
}

// MessageChannelKeyState is where one source conversation of a channel is:
// its current segment (one assistant session each) and a requested new
// session (ResetPending names why: command or button).
type MessageChannelKeyState struct {
	ChannelID    string
	SessionKey   string
	Segment      int
	ResetPending string
	UpdatedAt    string
}

// MessageChannelSessionEvent is one event of a channel's session.
type MessageChannelSessionEvent struct {
	SessionID string
	At        string
	Detail    string
}

// MessageChannelSession ties an assistant session to the channel
// conversation segment it was started for.
type MessageChannelSession struct {
	SessionID   string
	ChannelID   string
	AssistantID string
	SessionKey  string
	Segment     int
	CreatedAt   string
	// WorkspaceID and Title, when recording a new session, keep its title
	// from automatic naming (DEV-229).
	WorkspaceID string
	Title       string
}

// MessageChannelDeliveryFilter narrows a channel's delivery records (DEV-234).
type MessageChannelDeliveryFilter struct {
	Statuses   []string
	SessionKey string
	SessionID  string
}

// MessageChannelConversationSummary is one source conversation's newest
// activity, for paging the conversation index.
type MessageChannelConversationSummary struct {
	SessionKey string
	LastAt     string
}

// The states of a delivery record (MessageChannelDeliveryStatus).
const (
	MessageDeliveryDropped   = "dropped"
	MessageDeliveryHeld      = "held"
	MessageDeliveryQueued    = "queued"
	MessageDeliveryContext   = "context"
	MessageDeliveryDelivered = "delivered"
	MessageDeliveryDone      = "done"
	MessageDeliveryFailed    = "failed"
)

// MessageChannelStore keeps message channels, their feed state and their
// delivery records.
type MessageChannelStore interface {
	// ListMessageChannels lists a person's channels; assistantID "" means
	// all of theirs.
	ListMessageChannels(ctx context.Context, userID, assistantID string) ([]MessageChannelRecord, error)
	// ListAllMessageChannels is every channel of every person, for the runner.
	ListAllMessageChannels(ctx context.Context) ([]MessageChannelRecord, error)
	GetMessageChannel(ctx context.Context, id string) (MessageChannelRecord, error)
	SaveMessageChannel(ctx context.Context, channel MessageChannelRecord) error
	// DeleteMessageChannel removes the channel, its state and its records.
	DeleteMessageChannel(ctx context.Context, userID, id string) error

	GetMessageChannelRuntime(ctx context.Context, channelID string) (MessageChannelRuntime, error)
	SaveMessageChannelRuntime(ctx context.Context, runtime MessageChannelRuntime) error
	// RecordMessageChannelBatch stores the records whose envelope the channel
	// has not seen yet and moves the cursor, in one transaction; it returns
	// the records it stored.
	RecordMessageChannelBatch(ctx context.Context, channelID string, records []MessageChannelDeliveryRecord, cursor string) ([]MessageChannelDeliveryRecord, error)
	// ListMessageChannelDeliveries is the newest records of a channel first,
	// only those in statuses when given.
	ListMessageChannelDeliveries(ctx context.Context, channelID string, statuses []string, limit int) ([]MessageChannelDeliveryRecord, error)
	// ListMessageChannelDeliveriesPage is ListMessageChannelDeliveries with
	// filters and an opaque cursor over (createdAt, id), newest first; it also
	// returns the cursor of the next older page ("" at the end).
	ListMessageChannelDeliveriesPage(ctx context.Context, channelID string, filter MessageChannelDeliveryFilter, cursor string, limit int) ([]MessageChannelDeliveryRecord, string, error)
	// MessageChannelConversations groups a channel's records by source
	// conversation, newest activity first, at most limit; it also returns the
	// cursor of the next older page.
	MessageChannelConversations(ctx context.Context, channelID, cursor string, limit int) ([]MessageChannelConversationSummary, string, error)
	// MessageChannelConversationDeliveries are one conversation's records,
	// oldest first.
	MessageChannelConversationDeliveries(ctx context.Context, channelID, sessionKey string) ([]MessageChannelDeliveryRecord, error)
	// MessageChannelSessionDeliveries are one session's records, oldest first.
	MessageChannelSessionDeliveries(ctx context.Context, sessionID string) ([]MessageChannelDeliveryRecord, error)
	// MessageChannelInboxDeliveries are the records one hand-over (an inbox
	// entry) stored, oldest first.
	MessageChannelInboxDeliveries(ctx context.Context, assistantID, inboxID string) ([]MessageChannelDeliveryRecord, error)
	// MessageChannelPendingInboxDeliveries are the records saved for an inbox
	// channel and not yet tagged with the entry that took them, oldest first;
	// they let the origin be built even if the entry is drained first.
	MessageChannelPendingInboxDeliveries(ctx context.Context, assistantID, inboxChannel string) ([]MessageChannelDeliveryRecord, error)
	// MessageChannelSessionOrigin describes the channel turn a session
	// belongs to; ErrNotFound for a session no channel delivered to.
	MessageChannelSessionOrigin(ctx context.Context, sessionID string) (MessageChannelOriginSummary, error)
	// CountMessageChannelConversations counts the source conversations the
	// channel delivered a message from since (the retention window).
	CountMessageChannelConversations(ctx context.Context, channelID, since string) (int, error)
	SaveMessageChannelDelivery(ctx context.Context, record MessageChannelDeliveryRecord) error
	// CountMessageChannelDeliveries counts a channel's records created since.
	CountMessageChannelDeliveries(ctx context.Context, channelID, since string) (MessageChannelCounts, error)
	// MessageChannelOfSession is the channel whose message a session was
	// started or continued for; ErrNotFound for any other session.
	MessageChannelOfSession(ctx context.Context, sessionID string) (MessageChannelRecord, error)
	// MessageChannelSessions lists the sessions a channel's messages went
	// to; channelID "" means every channel of the assistant.
	MessageChannelSessions(ctx context.Context, assistantID, channelID string) ([]string, error)
	// MessageChannelSessionEvents are the events of the sessions with this
	// label, newest first.
	MessageChannelSessionEvents(ctx context.Context, sessionIDs []string, label string, limit int) ([]MessageChannelSessionEvent, error)
	// MessageChannelGatewayActions are the account's connector requests by
	// these sessions since then that wrote or were refused, newest first.
	MessageChannelGatewayActions(ctx context.Context, accountID string, sessionIDs []string, since string, limit int) ([]ExternalAccountEvent, error)
	GetMessageChannelKey(ctx context.Context, channelID, sessionKey string) (MessageChannelKeyState, error)
	SaveMessageChannelKey(ctx context.Context, state MessageChannelKeyState) error
	// RecordMessageChannelSession ties a session to its channel segment
	// (once; later calls for the same session change nothing).
	RecordMessageChannelSession(ctx context.Context, session MessageChannelSession) error
	GetMessageChannelSession(ctx context.Context, sessionID string) (MessageChannelSession, error)
	// PruneMessageChannelDeliveries removes dropped records created before
	// droppedBefore and clears the text of the others created before
	// keptBefore.
	PruneMessageChannelDeliveries(ctx context.Context, droppedBefore, keptBefore string) error
}
