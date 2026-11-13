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
}

// The states of a delivery record (MessageChannelDeliveryStatus).
const (
	MessageDeliveryDropped   = "dropped"
	MessageDeliveryHeld      = "held"
	MessageDeliveryQueued    = "queued"
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
	GetMessageChannelKey(ctx context.Context, channelID, sessionKey string) (MessageChannelKeyState, error)
	SaveMessageChannelKey(ctx context.Context, state MessageChannelKeyState) error
	// RecordMessageChannelSession ties a session to its channel segment
	// (once; later calls for the same session change nothing).
	RecordMessageChannelSession(ctx context.Context, session MessageChannelSession) error
	GetMessageChannelSession(ctx context.Context, sessionID string) (MessageChannelSession, error)
	// The saved revisions of a channel workspace's AGENTS.md, newest first.
	ListMessageChannelInstructionRevisions(ctx context.Context, channelID string, limit int) ([]MessageChannelInstructionsRevision, error)
	GetMessageChannelInstructionRevision(ctx context.Context, channelID, id string) (MessageChannelInstructionsRevision, string, error)
	AddMessageChannelInstructionRevision(ctx context.Context, channelID string, revision MessageChannelInstructionsRevision, content string) error
	// PruneMessageChannelDeliveries removes dropped records created before
	// droppedBefore and clears the text of the others created before
	// keptBefore.
	PruneMessageChannelDeliveries(ctx context.Context, droppedBefore, keptBefore string) error
}
