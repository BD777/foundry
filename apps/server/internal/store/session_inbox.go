package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"
)

// How a message one session sends another reaches it (DEV-057). A person's
// message keeps its runtime's own way; these are for agent senders.
const (
	// DeliveryInterrupt steers the running turn at once: Codex preempts
	// the response it is generating; Claude takes it after the tool calls
	// running now, its earliest point that loses no work.
	DeliveryInterrupt = "interrupt"
	// DeliveryBoundary waits for the turn's next completed step: Codex
	// while a tool runs (the model reads it with the tool's result), Claude
	// between tool rounds. A turn that ends first takes it as its next input.
	DeliveryBoundary = "boundary"
	// DeliveryTurnEnd waits for the turn to end and starts the next with
	// every such message, unless the turn runs past the flush limit.
	DeliveryTurnEnd = "turn_end"
)

// ValidDelivery reports whether delivery is one of the three.
func ValidDelivery(delivery string) bool {
	return delivery == DeliveryInterrupt || delivery == DeliveryBoundary || delivery == DeliveryTurnEnd
}

// Where a message stands. Held and unknown are Foundry's to deliver; it
// never drops one.
const (
	// InboxHeld: Foundry keeps it until the session can take it.
	InboxHeld = "held"
	// InboxUnknown: its device did not answer in time; it may hold the
	// message. Foundry settles it from the device's record of it, never by
	// sending it a second time while the turn runs.
	InboxUnknown = "unknown"
	// InboxAccepted: the device took it and puts it in the turn at its
	// delivery's point.
	InboxAccepted = "accepted"
	// InboxDelivered: it is in the session's conversation.
	InboxDelivered = "delivered"
	// InboxConsumed: the model read it.
	InboxConsumed = "consumed"
	// InboxFailed: it cannot reach the session (archived, controlled by
	// its Issue, refused by its skills); Reason says why.
	InboxFailed = "failed"
)

// SessionInboxItem is a message from one session to another, as Foundry
// delivers it.
type SessionInboxItem struct {
	SessionID       string           `json:"sessionId"`
	InputID         string           `json:"inputId"`
	SenderSessionID string           `json:"senderSessionId"`
	Prompt          string           `json:"-"`
	Attachments     []ChatAttachment `json:"-"`
	// RequestedDelivery is what the sender asked; Delivery what Foundry
	// applies (an interrupt past its sender's allowance waits for a
	// boundary instead).
	RequestedDelivery string `json:"requestedDelivery"`
	Delivery          string `json:"delivery"`
	State             string `json:"state"`
	Reason            string `json:"reason,omitempty"`
	// DeliveredAs is how it reached the session: "steer" into a running
	// turn, or "turn" as (part of) the input of a turn it started.
	DeliveredAs string `json:"deliveredAs,omitempty"`
	// DeliveredInputID is the input of that turn.
	DeliveredInputID string     `json:"deliveredInputId,omitempty"`
	TextHash         string     `json:"-"`
	Attempts         int        `json:"attempts,omitempty"`
	CreatedAt        time.Time  `json:"createdAt"`
	UpdatedAt        time.Time  `json:"updatedAt"`
	DeliveredAt      *time.Time `json:"deliveredAt,omitempty"`
	ConsumedAt       *time.Time `json:"consumedAt,omitempty"`
}

// Pending reports whether Foundry still has to place the message.
func (i SessionInboxItem) Pending() bool {
	return i.State == InboxHeld || i.State == InboxUnknown || i.State == InboxAccepted
}

// SessionInboxRules are the limits a new message is admitted under.
type SessionInboxRules struct {
	Now time.Time
	// DedupWindow: the same text from the same sender to the same session
	// within it is the earlier message again.
	DedupWindow time.Duration
	// InterruptLimit interrupts per sender per InterruptWindow; more wait
	// for a boundary.
	InterruptLimit  int
	InterruptWindow time.Duration
}

// SessionInboxAdmission is a send's message: the one admitted, or the
// earlier one it repeats (Duplicate).
type SessionInboxAdmission struct {
	Item      SessionInboxItem
	Duplicate bool
}

// SessionInboxChange moves a message on from the states From lists (any,
// when empty); a message in another state is left as it is.
type SessionInboxChange struct {
	From             []string
	State            string
	Reason           string
	DeliveredAs      string
	DeliveredInputID string
	CountAttempt     bool
	At               time.Time
}

// SessionInboxStore keeps the messages sessions send each other until they
// reach their session.
type SessionInboxStore interface {
	AdmitSessionInboxItem(ctx context.Context, item SessionInboxItem, rules SessionInboxRules) (SessionInboxAdmission, error)
	ChangeSessionInboxItem(ctx context.Context, sessionID, inputID string, change SessionInboxChange) (SessionInboxItem, bool, error)
	SessionInboxItem(ctx context.Context, sessionID, inputID string) (SessionInboxItem, bool, error)
	// PendingSessionInboxItems lists held, unknown and accepted messages,
	// oldest first.
	PendingSessionInboxItems(ctx context.Context) ([]SessionInboxItem, error)
	// SessionInboxItems lists a session's messages since since, newest
	// first, at most limit.
	SessionInboxItems(ctx context.Context, sessionID string, since time.Time, limit int) ([]SessionInboxItem, error)
}

// InboxTextHash identifies a message's content for repeat detection.
func InboxTextHash(prompt string, attachments []ChatAttachment) string {
	hash := sha256.New()
	hash.Write([]byte(strings.TrimSpace(prompt)))
	for _, attachment := range attachments {
		hash.Write([]byte{0})
		hash.Write([]byte(attachment.ID))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

// ChildReportStore keeps which sessions asked Foundry not to report their
// turns to the session that created them (create_session reportBack:
// false). Every other child reports (DEV-090).
type ChildReportStore interface {
	SetChildReportBack(ctx context.Context, sessionID string, reportBack bool) error
	ChildReportBack(ctx context.Context, sessionID string) (bool, error)
}
