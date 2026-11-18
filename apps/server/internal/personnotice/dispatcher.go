package personnotice

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	// MaxAttempts caps the sends of one notice, the first one included.
	MaxAttempts = 4
	// AmbiguousLimit is how old an ambiguous failure may be before the
	// notice ends instead of being sent again: the provider may hold it.
	AmbiguousLimit = time.Hour
	// sendTimeout bounds one Send call. staleAfter must be longer, so a live
	// send is never taken for a lost one.
	sendTimeout = time.Minute
	staleAfter  = 5 * time.Minute
	pumpBatch   = 50
	// refreshGiveUp is how long after a notice changed its sent message is
	// still refreshed; a refresh failing past it is dropped.
	refreshGiveUp = time.Hour
)

// retryDelays are the waits before the second, third and later attempts.
// The spec's fourth wait (1h) would need a fifth attempt, past MaxAttempts.
var retryDelays = []time.Duration{30 * time.Second, 2 * time.Minute, 10 * time.Minute}

// Dispatcher queues notices, sends them through their sinks and settles
// what the sinks report. Every state change is a store write, so a restart
// picks up where the last one stopped.
type Dispatcher struct {
	notices store.PersonNoticeStore
	now     func() time.Time
	newID   func() string

	mu    sync.RWMutex
	sinks map[string]Sink
	// resolve supplies the sinks that are not registered by id: one per
	// connector instance, named ext:<instanceId>. Nil when there are none.
	resolve func(id string) (Sink, bool)
}

// New returns a dispatcher with no sinks. Sinks register before Pump runs.
func New(notices store.PersonNoticeStore) *Dispatcher {
	return &Dispatcher{
		notices: notices,
		now:     func() time.Time { return time.Now().UTC() },
		newID:   uuid.NewString,
		sinks:   map[string]Sink{},
	}
}

// RegisterSink makes a sink deliverable under id.
func (d *Dispatcher) RegisterSink(id string, sink Sink) error {
	if id == "" || sink == nil {
		return errors.New("a notice sink needs an id and a sink")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, exists := d.sinks[id]; exists {
		return fmt.Errorf("notice sink %q is already registered", id)
	}
	d.sinks[id] = sink
	return nil
}

// SetSinkResolver makes sinks available on demand: a notice names its sink
// by id, and an id that is not registered is passed to resolve.
func (d *Dispatcher) SetSinkResolver(resolve func(id string) (Sink, bool)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.resolve = resolve
}

func (d *Dispatcher) sink(id string) (Sink, bool) {
	d.mu.RLock()
	sink, ok := d.sinks[id]
	resolve := d.resolve
	d.mu.RUnlock()
	if ok || resolve == nil {
		return sink, ok
	}
	return resolve(id)
}

// Route is where a notice goes, what kind of question it asks, and what it
// says. An empty Title, Text or Options takes the item's own; Link is the
// Web address the notice opens.
type Route struct {
	SinkID        string
	Target        string
	Kind          string
	AllowFreeText bool
	Title         string
	Text          string
	Options       []string
	Link          string
}

// EnqueueNotice queues the notice that asks the person about an item. It
// returns the item's live notice and false when the item already has one,
// and nothing at all, with false, when the item is no longer open.
func (d *Dispatcher) EnqueueNotice(ctx context.Context, item store.PendingItem, route Route) (store.PersonNotice, bool, error) {
	if route.SinkID == "" || route.Kind == "" {
		return store.PersonNotice{}, false, errors.New("a notice needs a sink and a kind")
	}
	if item.State != store.PendingOpen {
		return store.PersonNotice{}, false, nil
	}
	now := d.now()
	options := item.Options
	if route.Options != nil {
		options = route.Options
	}
	return d.notices.CreatePersonNotice(ctx, store.PersonNotice{
		ID:            d.newID(),
		UserID:        item.UserID,
		AssistantID:   item.AssistantID,
		ItemID:        item.ID,
		Kind:          route.Kind,
		Title:         cmp.Or(route.Title, item.Title),
		Text:          cmp.Or(route.Text, item.Excerpt),
		Options:       noticeOptions(options),
		AllowFreeText: route.AllowFreeText,
		Link:          route.Link,
		SinkID:        route.SinkID,
		Target:        route.Target,
		State:         store.NoticeQueued,
		NextAttemptAt: now,
		CreatedAt:     now,
		UpdatedAt:     now,
	})
}

// Supersede ends the item's live notices, for an item answered elsewhere. A
// notice still queued is never sent.
func (d *Dispatcher) Supersede(ctx context.Context, itemID string) error {
	_, err := d.notices.SupersedePersonNotices(ctx, itemID, d.now())
	return err
}

// Pump sends the due notices and settles what their sinks report. One
// notice's failure does not stop the others; the error joins them all.
func (d *Dispatcher) Pump(ctx context.Context) error {
	now := d.now()
	if _, err := d.notices.RecoverStalePersonNotices(ctx, now.Add(-staleAfter), now); err != nil {
		return err
	}
	due, err := d.notices.DuePersonNotices(ctx, now, pumpBatch)
	if err != nil {
		return err
	}
	var failures []error
	for _, notice := range due {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(failures, err)...)
		}
		if err := d.deliver(ctx, notice); err != nil {
			failures = append(failures, fmt.Errorf("notice %s: %w", notice.ID, err))
		}
	}
	return errors.Join(append(failures, d.refreshStale(ctx))...)
}

// refreshStale brings the sent messages whose notice changed since they were
// sent (answered, or superseded with the item) up to the notice's state.
func (d *Dispatcher) refreshStale(ctx context.Context) error {
	stale, err := d.notices.PersonNoticesNeedingRefresh(ctx, pumpBatch)
	if err != nil {
		return err
	}
	var failures []error
	for _, notice := range stale {
		if err := d.refresh(ctx, notice); err != nil {
			failures = append(failures, fmt.Errorf("refresh notice %s: %w", notice.ID, err))
		}
	}
	return errors.Join(failures...)
}

// refresh shows a notice's state on its sent message. A refresh that fails is
// retried on the next pump until refreshGiveUp after the change, then dropped.
func (d *Dispatcher) refresh(ctx context.Context, notice store.PersonNotice) error {
	var refreshErr error
	if sink, ok := d.sink(notice.SinkID); ok {
		if refresher, ok := sink.(Refresher); ok && notice.ProviderMessageID != "" {
			refreshErr = refresher.Refresh(ctx, notice)
		}
	}
	if refreshErr != nil && d.now().Sub(notice.UpdatedAt) < refreshGiveUp {
		return refreshErr
	}
	if _, err := d.notices.ClearPersonNoticeRefresh(ctx, notice.ID, notice.State); err != nil {
		return errors.Join(refreshErr, err)
	}
	return refreshErr
}

func (d *Dispatcher) deliver(ctx context.Context, due store.PersonNotice) error {
	if reason := giveUpReason(due, d.now()); reason != "" {
		_, err := d.notices.FailPersonNotice(ctx, due.ID, reason, d.now())
		return err
	}
	notice, claimed, err := d.notices.ClaimPersonNotice(ctx, due.ID, d.now())
	if err != nil || !claimed {
		return err
	}
	sink, ok := d.sink(notice.SinkID)
	if !ok {
		_, err := d.notices.FailPersonNotice(ctx, notice.ID, fmt.Sprintf("notice sink %q is not registered", notice.SinkID), d.now())
		return err
	}
	sendCtx, cancel := context.WithTimeout(ctx, sendTimeout)
	result, sendErr := sink.Send(sendCtx, notice)
	cancel()
	// Recording the outcome outlives a shutdown that interrupted the send.
	settleCtx := context.WithoutCancel(ctx)
	if sendErr == nil {
		_, err := d.notices.SettlePersonNotice(settleCtx, notice.ID, store.PersonNoticeSettlement{
			State:             store.NoticeSent,
			ProviderMessageID: result.ProviderMessageID,
			At:                d.now(),
		})
		return err
	}
	if ctx.Err() != nil {
		// Left sending: RecoverStalePersonNotices requeues it as ambiguous.
		return ctx.Err()
	}
	return d.settleFailure(settleCtx, notice, sendErr)
}

func (d *Dispatcher) settleFailure(ctx context.Context, notice store.PersonNotice, sendErr error) error {
	at := d.now()
	reason := sendErr.Error()
	transient, ambiguous := Classify(sendErr)
	if !transient {
		_, err := d.notices.FailPersonNotice(ctx, notice.ID, reason, at)
		return err
	}
	if notice.Attempts >= MaxAttempts {
		_, err := d.notices.FailPersonNotice(ctx, notice.ID, giveUpMessage(notice.Attempts, reason), at)
		return err
	}
	ambiguousAt := notice.AmbiguousAt
	if ambiguous && ambiguousAt.IsZero() {
		ambiguousAt = at
	}
	_, err := d.notices.SettlePersonNotice(ctx, notice.ID, store.PersonNoticeSettlement{
		State:         store.NoticeQueued,
		NextAttemptAt: at.Add(retryDelay(notice.Attempts)),
		AmbiguousAt:   ambiguousAt,
		ErrorReason:   reason,
		At:            at,
	})
	return err
}

// giveUpReason says why a queued notice must end without another send, or
// is empty when it may be sent.
func giveUpReason(notice store.PersonNotice, now time.Time) string {
	if notice.Attempts >= MaxAttempts {
		return giveUpMessage(notice.Attempts, notice.ErrorReason)
	}
	if !notice.AmbiguousAt.IsZero() && now.Sub(notice.AmbiguousAt) > AmbiguousLimit {
		return "an ambiguous failure over an hour old is not resent, the provider may already hold it: " + notice.ErrorReason
	}
	return ""
}

func giveUpMessage(attempts int, reason string) string {
	return fmt.Sprintf("gave up after %d attempts: %s", attempts, reason)
}

// retryDelay is the wait after the attempt-th failed send.
func retryDelay(attempts int) time.Duration {
	return retryDelays[min(attempts, len(retryDelays))-1]
}

func noticeOptions(options []string) []store.PersonNoticeOption {
	if len(options) == 0 {
		return nil
	}
	notice := make([]store.PersonNoticeOption, len(options))
	for index, label := range options {
		notice[index] = store.PersonNoticeOption{ID: strconv.Itoa(index), Label: label}
	}
	return notice
}
