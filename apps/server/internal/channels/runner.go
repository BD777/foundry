package channels

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Channel states (store.MessageChannelState).
const (
	StateStarting        = "starting"
	StateRunning         = "running"
	StatePaused          = "paused"
	StateWaitingDevice   = "waiting_device"
	StateNeedsPermission = "needs_permission"
	StateUnsupported     = "unsupported"
	StateBackingOff      = "backing_off"
	StateHeld            = "held"
)

// Defaults of a new channel's limits.
const (
	DefaultPerHour     = 20
	DefaultPerDay      = 100
	DefaultConcurrency = 3
)

// ErrUnsupported is a source that cannot be read: its connector declares
// no feed, or the instance is gone.
var ErrUnsupported = errors.New("the source cannot be read")

// ErrNeedsPermission is a source the assistant may not read, or whose
// instance its home workspace does not have.
type ErrNeedsPermission struct{ Detail string }

func (e ErrNeedsPermission) Error() string { return e.Detail }

// ErrWaitingDevice is a source whose requests leave through a device that is
// not connected now.
type ErrWaitingDevice struct{ Detail string }

func (e ErrWaitingDevice) Error() string { return e.Detail }

// Inbox carries a channel's messages to the assistant: one entry per
// conversation turn (assistant.CaptureInbox), and what became of it.
type Inbox interface {
	Deliver(ctx context.Context, channel store.MessageChannelRecord, turn Turn) (inboxID string, err error)
	Status(ctx context.Context, assistantID, inboxID string) (InboxStatus, error)
}

// Turn is one hand-over to the assistant: the notice for a batch of one
// conversation's messages, the inbox channel of the conversation's current
// session, and the source's raw items (a JSON array) to attach.
type Turn struct {
	InboxChannel string
	SessionKey   string
	Segment      int
	MessageID    string
	Text         string
	Raw          []byte
}

// SessionState is what the dispatcher needs of an earlier session to decide
// whether a conversation goes on in it.
type SessionState struct {
	Running  bool
	OpenWork bool
	// Replaced: the assistant does not go on with it but starts the
	// conversation's next session: it ended without completing (failed,
	// canceled), or it is from before the channel had its own workspace.
	Replaced   bool
	LastActive time.Time
}

// InboxStatus is an inbox entry as the channel follows it.
type InboxStatus struct {
	// Status: pending, waiting, dispatching, delivered, resolved, cancelled.
	Status        string
	WaitingReason string
	SessionID     string
	// ResultStatus is the session's end: completed, failed or canceled.
	ResultStatus string
}

// Ports are what the runner reaches outside this package.
type Ports struct {
	Store store.MessageChannelStore
	// Open returns the channel's source; ErrUnsupported, ErrNeedsPermission
	// or ErrWaitingDevice when it cannot be read now.
	Open  func(ctx context.Context, channel store.MessageChannelRecord) (Source, error)
	Inbox Inbox
	// Tell gives the person an item in their needs-you list (once per key
	// while it is open).
	Tell func(ctx context.Context, channel store.MessageChannelRecord, key, title, detail string)
	// SourceLabel names the source in notices ("" falls back to its kind).
	SourceLabel func(ctx context.Context, channel store.MessageChannelRecord) string
	// ContextHint is the source's command for reading what surrounds a
	// message, a template over {message.id}, {conversation.id} and
	// {thread.id}; "" without one.
	ContextHint func(ctx context.Context, channel store.MessageChannelRecord) string
	// Session reads an earlier session of a conversation; ok false when it
	// is gone.
	Session func(ctx context.Context, sessionID string) (state SessionState, ok bool)
	Now     func() time.Time
}

// Runner keeps one poll loop per enabled channel and delivers what they keep.
type Runner struct {
	ports   Ports
	kick    chan struct{}
	mu      sync.Mutex
	running map[string]*loop
}

type loop struct{ cancel context.CancelFunc }

// NewRunner is a runner over ports.
func NewRunner(ports Ports) *Runner {
	if ports.Now == nil {
		ports.Now = time.Now
	}
	return &Runner{ports: ports, kick: make(chan struct{}, 1), running: map[string]*loop{}}
}

// Kick makes the runner look at the channels again now (one was saved).
func (r *Runner) Kick() {
	select {
	case r.kick <- struct{}{}:
	default:
	}
}

// Run starts and stops poll loops as channels are enabled, disabled or
// removed, until ctx ends.
func (r *Runner) Run(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		r.reconcile(ctx)
		select {
		case <-ctx.Done():
			r.mu.Lock()
			for _, running := range r.running {
				running.cancel()
			}
			r.mu.Unlock()
			return
		case <-ticker.C:
		case <-r.kick:
		}
	}
}

func (r *Runner) reconcile(ctx context.Context) {
	channels, err := r.ports.Store.ListAllMessageChannels(ctx)
	if err != nil {
		log.Printf("message channels: list: %v", err)
		return
	}
	enabled := map[string]bool{}
	for _, channel := range channels {
		if channel.Enabled {
			enabled[channel.ID] = true
		} else {
			r.markPaused(ctx, channel.ID)
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, running := range r.running {
		if !enabled[id] {
			running.cancel()
			delete(r.running, id)
		}
	}
	for id := range enabled {
		if _, ok := r.running[id]; ok {
			continue
		}
		loopCtx, cancel := context.WithCancel(ctx)
		running := &loop{cancel: cancel}
		r.running[id] = running
		go func() {
			r.follow(loopCtx, id)
			cancel()
			r.mu.Lock()
			if r.running[id] == running {
				delete(r.running, id)
			}
			r.mu.Unlock()
		}()
	}
}

func (r *Runner) markPaused(ctx context.Context, id string) {
	runtime, err := r.ports.Store.GetMessageChannelRuntime(ctx, id)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return
	}
	if runtime.State == StatePaused {
		return
	}
	runtime.ChannelID, runtime.State, runtime.Detail, runtime.UpdatedAt = id, StatePaused, "", ""
	_ = r.ports.Store.SaveMessageChannelRuntime(ctx, runtime)
}

// follow polls one channel until it is disabled, removed or ctx ends.
func (r *Runner) follow(ctx context.Context, id string) {
	backoff := time.Duration(0)
	for ctx.Err() == nil {
		channel, err := r.ports.Store.GetMessageChannel(ctx, id)
		if err != nil || !channel.Enabled {
			return
		}
		wait := r.pollOnce(ctx, channel, &backoff)
		if wait > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
		}
	}
}

// pollOnce reads one batch and records it; it returns how long to wait
// before the next poll.
func (r *Runner) pollOnce(ctx context.Context, channel store.MessageChannelRecord, backoff *time.Duration) time.Duration {
	runtime, err := r.ports.Store.GetMessageChannelRuntime(ctx, channel.ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return time.Minute
	}
	runtime.ChannelID = channel.ID
	setState := func(state, detail string) {
		runtime.State, runtime.Detail, runtime.UpdatedAt = state, clip(detail, 500), ""
		if err := r.ports.Store.SaveMessageChannelRuntime(ctx, runtime); err != nil && ctx.Err() == nil {
			log.Printf("message channel %s: save state: %v", channel.ID, err)
		}
	}
	source, err := r.ports.Open(ctx, channel)
	if err != nil {
		var permission ErrNeedsPermission
		var device ErrWaitingDevice
		switch {
		case errors.As(err, &permission):
			setState(StateNeedsPermission, permission.Detail)
			return time.Minute
		case errors.As(err, &device):
			setState(StateWaitingDevice, device.Detail)
			return 30 * time.Second
		case errors.Is(err, ErrUnsupported):
			setState(StateUnsupported, err.Error())
			return 5 * time.Minute
		default:
			setState(StateBackingOff, err.Error())
			return nextBackoff(backoff)
		}
	}
	started := r.ports.Now()
	batch, err := source.Poll(ctx, runtime.Cursor)
	runtime.LastPollAt = r.ports.Now().UTC().Format(time.RFC3339Nano)
	if err != nil {
		if ctx.Err() != nil {
			return 0
		}
		var busy ErrBusy
		if errors.As(err, &busy) {
			setState(StateRunning, "")
			return busy.RetryAfter
		}
		runtime.LastErrorAt = runtime.LastPollAt
		setState(StateBackingOff, err.Error())
		return nextBackoff(backoff)
	}
	*backoff = 0
	if batch.Gap != nil {
		runtime.Cursor, runtime.GapAt = batch.Gap.Reset, runtime.LastPollAt
		setState(StateRunning, "")
		if r.ports.Tell != nil {
			r.ports.Tell(ctx, channel, "gap", fmt.Sprintf("Messages may be missing from channel %q", channel.Name),
				"The source no longer had the channel's position ("+cmpOr(batch.Gap.Reason, "gap")+"); messages between the last one read and now were not delivered.")
		}
		return 0
	}
	records, held := r.decide(ctx, channel, batch.Envelopes, batch.Raw)
	stored, err := r.ports.Store.RecordMessageChannelBatch(ctx, channel.ID, records, batch.Cursor)
	if err != nil {
		setState(StateBackingOff, "could not record the batch: "+err.Error())
		return nextBackoff(backoff)
	}
	runtime.Cursor = batch.Cursor
	if len(batch.Envelopes) > 0 {
		runtime.LastEventAt = runtime.LastPollAt
	}
	state := StateRunning
	if held > 0 {
		state = StateHeld
	}
	detail := ""
	if batch.Invalid > 0 {
		detail = fmt.Sprintf("%d item(s) of the last batch could not be read", batch.Invalid)
	}
	setState(state, detail)
	if held > 0 && len(stored) > 0 && r.ports.Tell != nil {
		r.ports.Tell(ctx, channel, "held", fmt.Sprintf("Channel %q reached its delivery limit", channel.Name),
			fmt.Sprintf("Messages over %d per hour or %d per day are held, not delivered. Release them or raise the limit in the channel's settings.", channel.Limits.PerHour, channel.Limits.PerDay))
	}
	if batch.More {
		return 0
	}
	// A feed that answered at once with nothing does not wait on its side.
	if len(batch.Envelopes) == 0 && r.ports.Now().Sub(started) < time.Second {
		return 2 * time.Second
	}
	return 0
}

func nextBackoff(backoff *time.Duration) time.Duration {
	switch {
	case *backoff == 0:
		*backoff = 2 * time.Second
	case *backoff < 5*time.Minute:
		*backoff = min(*backoff*2, 5*time.Minute)
	}
	return *backoff
}

// OpNew is the envelope op of a message that was just posted; adapters
// map their own name for it to this.
const OpNew = "new"

// decide filters a batch and applies the channel's limits: records to
// store, and how many matched messages were held.
func (r *Runner) decide(ctx context.Context, channel store.MessageChannelRecord, envelopes []store.MessageEnvelope, raw []string) ([]store.MessageChannelDeliveryRecord, int) {
	if len(envelopes) == 0 {
		return nil, 0
	}
	now := r.ports.Now().UTC()
	stages := []Stage{Rules(channel.Filters.Rules)}
	hour, _ := r.ports.Store.CountMessageChannelDeliveries(ctx, channel.ID, now.Add(-time.Hour).Format(time.RFC3339Nano))
	day, _ := r.ports.Store.CountMessageChannelDeliveries(ctx, channel.ID, now.Add(-24*time.Hour).Format(time.RFC3339Nano))
	inHour, inDay := hour.Matched-hour.Held, day.Matched-day.Held
	held := 0
	records := make([]store.MessageChannelDeliveryRecord, 0, len(envelopes))
	for i, envelope := range envelopes {
		if envelope.Op != OpNew {
			// v1 hands over new messages only; an edit or a thread change
			// of one already seen would otherwise start another turn.
			continue
		}
		record := store.MessageChannelDeliveryRecord{UserID: channel.UserID, AssistantID: channel.AssistantID}
		record.SessionKey = SessionKey(channel.MessageChannel, envelope)
		record.ID = DeliveryID(channel.ID, envelope.ID)
		record.ChannelID = channel.ID
		record.CreatedAt = now.Add(time.Duration(i) * time.Microsecond).Format(time.RFC3339Nano)
		record.Envelope = envelope
		decision := Decide(stages, envelope)
		if decision.Keep && i < len(raw) && len(raw[i]) <= 64*1024 {
			record.RawJSON = raw[i]
		}
		switch {
		case !decision.Keep:
			record.Status, record.Reason = store.MessageDeliveryDropped, decision.Reason
			// A filtered-out message keeps no text: other people's words
			// stay only where they were meant to go. Its metadata goes
			// after a day.
			record.Envelope.Text, record.Envelope.TextTruncated = "", false
		case limitReached(channel.Limits.PerHour, inHour) || limitReached(channel.Limits.PerDay, inDay):
			record.Status, record.Rule, record.Reason = store.MessageDeliveryHeld, decision.Rule, "limit"
			held++
		default:
			record.Status, record.Rule = store.MessageDeliveryQueued, decision.Rule
			inHour++
			inDay++
		}
		records = append(records, record)
	}
	return records, held
}

func limitReached(limit, count int) bool { return limit > 0 && count >= limit }

// DeliveryID is the stable id of a channel's record of one envelope.
func DeliveryID(channelID, envelopeID string) string {
	sum := sha256.Sum256([]byte(channelID + "\x00" + envelopeID))
	return "dlv_" + hex.EncodeToString(sum[:12])
}

// SessionKey is the conversation a message belongs to: one assistant
// session per key.
func SessionKey(channel store.MessageChannel, envelope store.MessageEnvelope) string {
	key := "c:" + envelope.Conversation.ID
	if channel.SessionKey != "conversation" && envelope.Thread.ID != "" {
		key += "|t:" + envelope.Thread.ID
	}
	return key
}

// InboxChannel is the assistant inbox channel of one conversation key.
func InboxChannel(channelID, key string) string {
	sum := sha256.Sum256([]byte(key))
	return "mc:" + channelID + ":" + hex.EncodeToString(sum[:8])
}

func cmpOr(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

// sortRecords orders records oldest first.
func sortRecords(records []store.MessageChannelDeliveryRecord) {
	sort.SliceStable(records, func(i, j int) bool { return records[i].CreatedAt < records[j].CreatedAt })
}
