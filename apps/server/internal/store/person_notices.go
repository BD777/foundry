package store

import (
	"context"
	"time"
)

// A person notice is one message Foundry sends the person about an item
// that waits for them (DEV-294): the item's question, approval or hand-over,
// through a sink (a connector or the built-in Feishu bot). The item stays
// in Foundry; the notice is only how the person hears about it, and what
// they answer comes back as the item's answer.
const (
	// NoticeQueued waits to be sent, for the first time or after a
	// transient failure (NextAttemptAt says when).
	NoticeQueued = "queued"
	// NoticeSending is claimed by the dispatcher and in flight.
	NoticeSending = "sending"
	// NoticeSent was accepted by its sink; ProviderMessageID names it.
	NoticeSent = "sent"
	// NoticeAnswered: the person answered it (set by the reply path).
	NoticeAnswered = "answered"
	// NoticeFailed will not be sent again; ErrorReason says why.
	NoticeFailed = "failed"
	// NoticeSuperseded: the item was answered elsewhere, or closed, before
	// the notice was answered.
	NoticeSuperseded = "superseded"
)

// NoticeActiveStates are the states in which an item has a live notice:
// at most one per item (the unique index on person_notices).
var NoticeActiveStates = []string{NoticeQueued, NoticeSending, NoticeSent}

// PersonNoticeOption is one choice a notice offers. ID is the index of the
// item's option it stands for, so an answer maps back to the item.
type PersonNoticeOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// PersonNotice is what the dispatcher keeps of one notice. Times are UTC.
type PersonNotice struct {
	ID          string
	UserID      string
	AssistantID string
	ItemID      string
	Kind        string
	Title       string
	Text        string
	Options     []PersonNoticeOption
	// AllowFreeText says the person may answer with any text, not only an
	// option.
	AllowFreeText bool
	Link          string
	// SinkID names the sink that delivers the notice; Target is where
	// (the conversation the sink sends into).
	SinkID string
	Target string
	// ProviderMessageID is the id the sink reported for the sent message.
	ProviderMessageID string
	State             string
	// Attempts counts the sends started, including ones whose outcome is
	// unknown.
	Attempts      int
	NextAttemptAt time.Time
	// AmbiguousAt is when a send first failed in a way that may still have
	// reached the provider (zero when none did).
	AmbiguousAt time.Time
	// ErrorReason is the last failure's reason, kept for the person to see.
	ErrorReason string
	AnsweredBy  string
	AnswerText  string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// PersonNoticeSettlement is the outcome the dispatcher records after a send:
// the state it moves to and the fields that state carries.
type PersonNoticeSettlement struct {
	State             string
	ProviderMessageID string
	NextAttemptAt     time.Time
	AmbiguousAt       time.Time
	ErrorReason       string
	At                time.Time
}

// PersonNoticeStore keeps person notices.
type PersonNoticeStore interface {
	// CreatePersonNotice adds a queued notice, unless its item already has
	// an active one; it returns that notice instead and reports false.
	CreatePersonNotice(ctx context.Context, notice PersonNotice) (PersonNotice, bool, error)
	// DuePersonNotices returns up to limit queued notices whose next attempt
	// is at or before now, earliest first.
	DuePersonNotices(ctx context.Context, now time.Time, limit int) ([]PersonNotice, error)
	// ClaimPersonNotice moves a queued notice to sending and counts the
	// attempt. It reports false when the notice is no longer queued.
	ClaimPersonNotice(ctx context.Context, id string, at time.Time) (PersonNotice, bool, error)
	// SettlePersonNotice records the outcome of a send that was in flight.
	// It reports false when the notice is no longer sending.
	SettlePersonNotice(ctx context.Context, id string, settlement PersonNoticeSettlement) (bool, error)
	// FailPersonNotice ends a queued or sending notice with a reason.
	FailPersonNotice(ctx context.Context, id, reason string, at time.Time) (bool, error)
	// SupersedePersonNotices ends the item's active notices, as the item was
	// answered elsewhere, and returns how many.
	SupersedePersonNotices(ctx context.Context, itemID string, at time.Time) (int, error)
	// RecoverStalePersonNotices requeues the notices left sending since
	// before (a send that never reported back), marking them ambiguous.
	RecoverStalePersonNotices(ctx context.Context, before, at time.Time) (int, error)
	// AnswerPersonNotice records the person's answer to a sent notice and
	// reports whether it did: a notice no longer sent was answered already.
	AnswerPersonNotice(ctx context.Context, id, by, text string, at time.Time) (bool, error)
	// ReopenPersonNotice undoes AnswerPersonNotice when the answer did not
	// reach its item, so a later reply can settle it.
	ReopenPersonNotice(ctx context.Context, id string, at time.Time) (bool, error)
	// PersonNoticeByMessage returns the notice a sink sent with the provider
	// message id, in whatever state it is; false when no notice has it.
	PersonNoticeByMessage(ctx context.Context, sinkID, providerMessageID string) (PersonNotice, bool, error)
	// PersonNoticesOfItem returns every notice of one item, oldest first.
	PersonNoticesOfItem(ctx context.Context, itemID string) ([]PersonNotice, error)
	// PersonNoticesNeedingRefresh returns up to limit notices whose state
	// changed after their message was sent (answered, or superseded), so the
	// message still shows the state it was sent in.
	PersonNoticesNeedingRefresh(ctx context.Context, limit int) ([]PersonNotice, error)
	// ClearPersonNoticeRefresh records that the message shows the notice in
	// state. It reports false when the notice has moved on since.
	ClearPersonNoticeRefresh(ctx context.Context, id, state string) (bool, error)
	// PersonNoticeSentIDs returns the provider message ids of a sink's
	// notices that were updated since the time, so a message the sink sent
	// is recognised when the channel sees it come back.
	PersonNoticeSentIDs(ctx context.Context, sinkID string, since time.Time) ([]string, error)
}
