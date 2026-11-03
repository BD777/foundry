package sessions

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Messages sessions send each other (DEV-057). Each is admitted to the
// recipient's inbox first, then placed in its conversation the way its
// delivery asks: an interrupt steers the running turn at once, a boundary
// waits for the turn's next completed step, a turn_end for the turn to end.
// One the session cannot take now (it is queued, finishing, between turns,
// or its device is away) stays held and goes out as soon as it can: Foundry
// never drops it, and its sender reads where it stands from the receipt.

const (
	// InboxDedupWindow: the same text from the same sender to the same
	// session within it is the earlier message again.
	InboxDedupWindow = 10 * time.Minute
	// An interrupt past its sender's allowance waits for a boundary.
	inboxInterruptLimit  = 2
	inboxInterruptWindow = 30 * time.Minute
	// InboxTurnEndFlush: a turn_end message older than this goes into the
	// running turn at its next boundary instead of waiting longer.
	InboxTurnEndFlush = 10 * time.Minute
	// InboxBoundaryLimitMs is the longest a device holds a boundary message
	// for its turn's next step before it steers it in anyway.
	InboxBoundaryLimitMs = int64(15 * time.Minute / time.Millisecond)
	// InboxPumpInterval is how often held messages are tried again; a
	// change of a session's state tries at once.
	InboxPumpInterval = 3 * time.Second
	// inboxSettleGrace: a message the device took is redelivered after the
	// turn ended only once its own report had time to arrive.
	inboxSettleGrace = 5 * time.Second
	// inboxAttemptLimit: a message its session keeps refusing for another
	// reason than being busy fails after this many tries.
	inboxAttemptLimit = 12
)

// inboxRuntime wakes the inbox pump; mu runs one placement at a time.
type inboxRuntime struct {
	once sync.Once
	kick chan struct{}
	mu   sync.Mutex
}

func (r *inboxRuntime) kicks() chan struct{} {
	r.once.Do(func() { r.kick = make(chan struct{}, 1) })
	return r.kick
}

func (r *inboxRuntime) wake() {
	select {
	case r.kicks() <- struct{}{}:
	default:
	}
}

// Receipt is what a sender learns about its message.
type Receipt struct {
	InputID           string `json:"inputId"`
	Delivery          string `json:"delivery"`
	RequestedDelivery string `json:"requestedDelivery,omitempty"`
	State             string `json:"state"`
	// DeliverAt is when it reaches the model: now, next_boundary,
	// turn_end, turn_start (the session has not started its turn),
	// when_steerable, unconfirmed (its device did not answer), or empty
	// once delivered.
	DeliverAt string `json:"deliverAt,omitempty"`
	Reason    string `json:"reason,omitempty"`
	// Downgraded says why Delivery is not what the sender asked.
	Downgraded string `json:"downgraded,omitempty"`
	Duplicate  bool   `json:"duplicate,omitempty"`
	Note       string `json:"note"`
	// RecentToRecipient counts what this sender sent the recipient in the
	// last hour, this message included (DEV-090).
	RecentToRecipient *RecentMessages `json:"recentToRecipient,omitempty"`
}

func receiptFor(item store.SessionInboxItem, duplicate bool, provider string) Receipt {
	receipt := Receipt{InputID: item.InputID, Delivery: item.Delivery, State: item.State, Reason: item.Reason, Duplicate: duplicate}
	if item.RequestedDelivery != item.Delivery {
		receipt.RequestedDelivery = item.RequestedDelivery
		receipt.Downgraded = fmt.Sprintf("this sender used its %d interrupts per %s; it waits for the turn's next boundary", inboxInterruptLimit, inboxInterruptWindow)
	}
	switch item.State {
	case store.InboxAccepted:
		if item.Delivery == store.DeliveryInterrupt && provider == "codex" {
			receipt.DeliverAt = "now"
		} else {
			receipt.DeliverAt = "next_boundary"
		}
		receipt.Note = "The session's device has it and puts it in the running turn; do not send it again."
	case store.InboxHeld:
		switch {
		case item.Delivery == store.DeliveryTurnEnd:
			receipt.DeliverAt = "turn_end"
		case item.Reason == "queued":
			receipt.DeliverAt = "turn_start"
		default:
			receipt.DeliverAt = "when_steerable"
		}
		receipt.Note = "Foundry holds it and delivers it as soon as the session can take it; do not send it again."
	case store.InboxUnknown:
		receipt.DeliverAt = "unconfirmed"
		receipt.Note = "The session's device did not confirm it in time and may already have it. Foundry settles it from the device's record; do not send it again."
	case store.InboxDelivered:
		receipt.Note = "It is in the session's conversation."
	case store.InboxConsumed:
		receipt.Note = "The session's model has read it."
	case store.InboxFailed:
		receipt.Note = "It cannot reach the session: " + item.Reason
	}
	if duplicate {
		receipt.Note = "This repeats a message already sent (same inputId, or the same text within 10 minutes); nothing new was sent. " + receipt.Note
	}
	return receipt
}

// SendInboxMessage admits a message from senderSessionID to target and
// tries to deliver it at once; it returns the session and the receipt.
// publish, when set, hands the message's files over once it is admitted.
func (s *Service) SendInboxMessage(ctx context.Context, target store.AgentSession, inputID, senderSessionID, delivery, prompt string, attachments []store.ChatAttachment, publish func(context.Context, store.AgentSession) error) (store.AgentSession, Receipt, error) {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" && len(attachments) == 0 {
		return store.AgentSession{}, Receipt{}, &Refusal{400, errors.New("message is required")}
	}
	if target.Role != "" {
		return store.AgentSession{}, Receipt{}, &Refusal{409, store.ErrSessionControlledByIssue}
	}
	if inputID == "" {
		inputID = uuid.NewString()
	}
	admission, err := s.store.AdmitSessionInboxItem(ctx, store.SessionInboxItem{
		SessionID: target.ID, InputID: inputID, SenderSessionID: senderSessionID,
		Prompt: prompt, Attachments: store.NormalizeChatAttachments(attachments), RequestedDelivery: delivery,
	}, store.SessionInboxRules{
		Now: time.Now().UTC(), DedupWindow: InboxDedupWindow,
		InterruptLimit: inboxInterruptLimit, InterruptWindow: inboxInterruptWindow,
	})
	if err != nil {
		return store.AgentSession{}, Receipt{}, err
	}
	item := admission.Item
	LogInboxItem("admitted", item)
	if !admission.Duplicate {
		if publish != nil {
			if err := publish(ctx, target); err != nil {
				s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: []string{store.InboxHeld}, State: store.InboxFailed, Reason: err.Error()})
				return store.AgentSession{}, Receipt{}, &Refusal{409, err}
			}
		}
		item = s.placeInboxItems(ctx, target.ID, []store.SessionInboxItem{item})[0]
		// Held only for what passes: a refusal of the message itself
		// (the workspace is not served, the assistant's allowance, its
		// skills) goes back to the sender, as a direct send's would.
		if item.State == store.InboxHeld && !holdableReason(item.Reason) {
			reason := item.Reason
			s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: []string{store.InboxHeld}, State: store.InboxFailed, Reason: reason})
			return store.AgentSession{}, Receipt{}, &Refusal{409, errors.New(reason)}
		}
	}
	session, err := s.store.GetAgentSessionRecord(ctx, target.ID)
	if err != nil {
		session = target
	}
	receipt := receiptFor(item, admission.Duplicate, session.Provider)
	receipt.RecentToRecipient = s.RecentToRecipient(ctx, target.ID, senderSessionID)
	return session, receipt, nil
}

// PumpInbox tries every pending message once, a session at a time.
func (s *Service) PumpInbox(ctx context.Context) {
	items, err := s.store.PendingSessionInboxItems(ctx)
	if err != nil {
		log.Printf("list held session messages: %v", err)
		return
	}
	var order []string
	bySession := map[string][]store.SessionInboxItem{}
	for _, item := range items {
		if _, seen := bySession[item.SessionID]; !seen {
			order = append(order, item.SessionID)
		}
		bySession[item.SessionID] = append(bySession[item.SessionID], item)
	}
	for _, sessionID := range order {
		if ctx.Err() != nil {
			return
		}
		s.placeInboxItems(ctx, sessionID, bySession[sessionID])
	}
}

// placeInboxItems delivers what of items (a session's pending messages,
// oldest first) the session can take now, and returns them as they are.
// One placement runs at a time, so a message is never placed twice.
func (s *Service) placeInboxItems(ctx context.Context, sessionID string, items []store.SessionInboxItem) []store.SessionInboxItem {
	s.inbox.mu.Lock()
	defer s.inbox.mu.Unlock()
	// Read again under the lock: another placement may have moved them.
	for index, item := range items {
		if current, ok, err := s.store.SessionInboxItem(ctx, item.SessionID, item.InputID); err == nil && ok {
			items[index] = current
		}
	}
	session, err := s.store.GetAgentSessionRecord(ctx, sessionID)
	if errors.Is(err, store.ErrNotFound) {
		return s.failInboxItems(ctx, items, "the session no longer exists")
	}
	if err != nil {
		log.Printf("read session %s for held messages: %v", sessionID, err)
		return items
	}
	if session.ArchivedAt != "" {
		return s.failInboxItems(ctx, items, "the session is archived")
	}
	if session.Role != "" {
		return s.failInboxItems(ctx, items, store.ErrSessionControlledByIssue.Error())
	}
	now := time.Now().UTC()
	switch session.Status {
	case "queued":
		// Its turn has not started: held messages go with the turn's start.
		for index, item := range items {
			if item.State == store.InboxHeld && item.Reason != "queued" && item.Delivery != store.DeliveryTurnEnd {
				items[index] = s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: []string{store.InboxHeld}, State: store.InboxHeld, Reason: "queued"})
			}
		}
		return items
	case "running", "blocked":
		for index, item := range items {
			if item.State != store.InboxHeld {
				continue
			}
			delivery := item.Delivery
			if delivery == store.DeliveryTurnEnd {
				if now.Sub(item.CreatedAt) < InboxTurnEndFlush {
					if item.Reason != "turn_end" {
						items[index] = s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: []string{store.InboxHeld}, State: store.InboxHeld, Reason: "turn_end"})
					}
					continue
				}
				delivery = store.DeliveryBoundary
			}
			if item.Attempts > 0 && now.Sub(item.UpdatedAt) < inboxRetryDelay(item.Attempts) {
				continue
			}
			items[index] = s.steerInboxItem(ctx, session, item, delivery)
		}
		return items
	default:
		// Between turns: everything still pending starts the next turn,
		// together. A message the device took, or may have taken, whose
		// turn ended without its report has not reached the conversation.
		var due []int
		for index, item := range items {
			if (item.State == store.InboxAccepted || item.State == store.InboxUnknown) && now.Sub(item.UpdatedAt) < inboxSettleGrace {
				continue
			}
			due = append(due, index)
		}
		if len(due) == 0 || childReportsGathering(items, due, now) {
			return items
		}
		batch := make([]store.SessionInboxItem, 0, len(due))
		for _, index := range due {
			batch = append(batch, items[index])
		}
		placed := s.startTurnWithInboxItems(ctx, session, batch)
		for position, index := range due {
			items[index] = placed[position]
		}
		return items
	}
}

// holdableReason reports a reason a message waits for, not one it is
// refused for.
func holdableReason(reason string) bool {
	switch reason {
	case "", "queued", "turn_end", "not_steerable", "device_offline", "device_unconfirmed":
		return true
	}
	return false
}

func inboxRetryDelay(attempts int) time.Duration {
	delay := time.Second << min(attempts, 6)
	return min(delay, time.Minute)
}

// steerInboxItem steers one message into the session's running turn.
func (s *Service) steerInboxItem(ctx context.Context, session store.AgentSession, item store.SessionInboxItem, delivery string) store.SessionInboxItem {
	pending := []string{store.InboxHeld}
	if s.WaitsForDevice(session) || !s.devices.Connected(session.DeviceID) {
		return s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: pending, State: store.InboxHeld, Reason: "device_offline", CountAttempt: true})
	}
	if err := s.policy.AdmitAssistantTurn(ctx, session); err != nil {
		return s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: pending, State: store.InboxHeld, Reason: err.Error(), CountAttempt: true})
	}
	input := store.SendAgentSessionInput{InputID: item.InputID, SentBySessionID: item.SenderSessionID}
	if err := s.RecordSteerSender(ctx, session.ID, &input); err != nil {
		log.Printf("record sender of held message %s: %v", item.InputID, err)
		return item
	}
	steerCtx, cancel := context.WithTimeout(ctx, ControlTimeout)
	defer cancel()
	err := s.devices.Steer(steerCtx, session, Steer{
		SentBySessionID: item.SenderSessionID, SessionID: session.ID, Message: item.Prompt,
		Attachments: item.Attachments, InputID: item.InputID, Delivery: delivery, BoundaryLimitMs: InboxBoundaryLimitMs,
	})
	switch {
	case err == nil:
		return s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: pending, State: store.InboxAccepted, DeliveredAs: "steer"})
	case errors.Is(err, ErrNotSteerable):
		return s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: pending, State: store.InboxHeld, Reason: "not_steerable"})
	case errors.Is(err, ErrLocalDaemonNotConnected):
		return s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: pending, State: store.InboxHeld, Reason: "device_offline", CountAttempt: true})
	case s.devices.NoAnswer(err):
		return s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: pending, State: store.InboxUnknown, Reason: "device_unconfirmed", DeliveredAs: "steer"})
	default:
		if item.Attempts+1 >= inboxAttemptLimit {
			return s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: pending, State: store.InboxFailed, Reason: err.Error(), CountAttempt: true})
		}
		return s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: pending, State: store.InboxHeld, Reason: err.Error(), CountAttempt: true})
	}
}

// startTurnWithInboxItems starts the idle session's next turn with items,
// one input for all of them.
func (s *Service) startTurnWithInboxItems(ctx context.Context, session store.AgentSession, items []store.SessionInboxItem) []store.SessionInboxItem {
	from := []string{store.InboxHeld, store.InboxUnknown, store.InboxAccepted}
	inputID := uuid.NewString()
	prompt, attachments, sender := mergedInboxInput(items)
	_, err := s.Send(ctx, session.ID, store.SendAgentSessionInput{
		Prompt: prompt, Attachments: attachments, InputID: inputID, SentBySessionID: sender, RequireIdle: true,
	}, nil)
	placed := make([]store.SessionInboxItem, len(items))
	for index, item := range items {
		switch {
		case err == nil:
			reason := ""
			if item.State == store.InboxAccepted || item.State == store.InboxUnknown {
				reason = "turn_ended_before_delivery"
			}
			placed[index] = s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: from, State: store.InboxDelivered, Reason: reason, DeliveredAs: "turn", DeliveredInputID: inputID})
		case errors.Is(err, store.ErrAgentSessionActive):
			// It started meanwhile: the next pass steers it.
			placed[index] = item
		case errors.Is(err, store.ErrSessionArchived):
			placed[index] = s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: from, State: store.InboxFailed, Reason: "the session is archived"})
		default:
			if item.Attempts+1 >= inboxAttemptLimit {
				placed[index] = s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: from, State: store.InboxFailed, Reason: err.Error(), CountAttempt: true})
			} else {
				placed[index] = s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: from, State: store.InboxHeld, Reason: err.Error(), CountAttempt: true})
			}
		}
	}
	return placed
}

// mergedInboxInput is one turn's input for messages that waited for it. A
// single message goes as it was sent.
func mergedInboxInput(items []store.SessionInboxItem) (string, []store.ChatAttachment, string) {
	var attachments []store.ChatAttachment
	for _, item := range items {
		attachments = append(attachments, item.Attachments...)
	}
	if len(items) == 1 {
		return items[0].Prompt, attachments, items[0].SenderSessionID
	}
	var builder strings.Builder
	fmt.Fprintf(&builder, "Foundry held %d messages from other sessions while this session could not take them. They follow in the order they were sent.\n", len(items))
	for index, item := range items {
		fmt.Fprintf(&builder, "\n--- Message %d of %d, from session %s, sent %s (%s) ---\n%s\n",
			index+1, len(items), item.SenderSessionID, item.CreatedAt.UTC().Format(time.RFC3339), item.Delivery, item.Prompt)
	}
	return builder.String(), store.NormalizeChatAttachments(attachments), items[0].SenderSessionID
}

func (s *Service) failInboxItems(ctx context.Context, items []store.SessionInboxItem, reason string) []store.SessionInboxItem {
	for index, item := range items {
		if item.Pending() {
			items[index] = s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: []string{store.InboxHeld, store.InboxUnknown, store.InboxAccepted}, State: store.InboxFailed, Reason: reason})
		}
	}
	return items
}

func (s *Service) ChangeInboxItem(ctx context.Context, item store.SessionInboxItem, change store.SessionInboxChange) store.SessionInboxItem {
	next, changed, err := s.store.ChangeSessionInboxItem(ctx, item.SessionID, item.InputID, change)
	if err != nil {
		log.Printf("update held message %s of %s: %v", item.InputID, item.SessionID, err)
		return item
	}
	if changed && (next.State != item.State || next.Reason != item.Reason) {
		LogInboxItem("moved", next)
	}
	if next.InputID == "" {
		return item
	}
	return next
}

// logInboxItem is the delivery metric: one line per change, with how long
// the message has waited.
func LogInboxItem(what string, item store.SessionInboxItem) {
	log.Printf("session message %s: session=%s input=%s sender=%s delivery=%s requested=%s state=%s reason=%q waited=%s attempts=%d",
		what, item.SessionID, item.InputID, item.SenderSessionID, item.Delivery, item.RequestedDelivery, item.State, item.Reason,
		time.Since(item.CreatedAt).Round(time.Millisecond), item.Attempts)
}

// inboxReactions settles messages from what their session reports
// and wakes the pump when a session can take held ones.
type inboxReactions struct{ s *Service }

func (r inboxReactions) SessionChanged(ctx context.Context, change Change, session store.AgentSession) {
	if change == Started && session.Input.ID != "" {
		r.s.markInboxTurnConsumed(ctx, session)
	}
	r.s.inbox.wake()
}

func (r inboxReactions) SessionEventRecorded(ctx context.Context, event store.AgentSessionEvent) {
	inputID, named := store.SessionInputIDOfEvent(event.ID)
	if event.Label != store.EventLabelSteeredIntoTurn || !named {
		return
	}
	item, found, err := r.s.store.SessionInboxItem(ctx, event.SessionID, inputID)
	if err != nil || !found {
		return
	}
	r.s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: []string{store.InboxHeld, store.InboxUnknown, store.InboxAccepted}, State: store.InboxDelivered, DeliveredAs: "steer"})
}

// markInboxTurnConsumed settles the messages a starting turn's input
// carries: the model reads its input first.
func (s *Service) markInboxTurnConsumed(ctx context.Context, session store.AgentSession) {
	items, err := s.store.SessionInboxItems(ctx, session.ID, time.Now().Add(-24*time.Hour), 200)
	if err != nil {
		return
	}
	for _, item := range items {
		if item.DeliveredInputID == session.Input.ID && item.State == store.InboxDelivered {
			s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: []string{store.InboxDelivered}, State: store.InboxConsumed})
		}
	}
}

// ObserveInboxConsumed settles a steered message its worker reports read.
// It reports whether event was that report, which is not transcript.
func (s *Service) ObserveInboxConsumed(ctx context.Context, event store.AgentSessionEvent) bool {
	if event.Label != store.EventLabelSteerConsumed {
		return false
	}
	inputID := strings.TrimSpace(event.Detail)
	if inputID == "" {
		return true
	}
	item, found, err := s.store.SessionInboxItem(ctx, event.SessionID, inputID)
	if err == nil && found {
		s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: []string{store.InboxHeld, store.InboxUnknown, store.InboxAccepted, store.InboxDelivered}, State: store.InboxConsumed})
	}
	return true
}

// InboxSummary is what get_session shows of a session's messages: those
// still pending, and how the last day's went.
type InboxSummary struct {
	Pending []Receipt `json:"pending,omitempty"`
	// LastDay counts the last 24 hours' messages by delivery and state.
	LastDay map[string]map[string]int `json:"lastDay,omitempty"`
}

func (s *Service) InboxSummary(ctx context.Context, session store.AgentSession) *InboxSummary {
	items, err := s.store.SessionInboxItems(ctx, session.ID, time.Now().Add(-24*time.Hour), 500)
	if err != nil || len(items) == 0 {
		return nil
	}
	summary := &InboxSummary{LastDay: map[string]map[string]int{}}
	for _, item := range items {
		if summary.LastDay[item.Delivery] == nil {
			summary.LastDay[item.Delivery] = map[string]int{}
		}
		summary.LastDay[item.Delivery][item.State]++
		if item.Pending() {
			summary.Pending = append(summary.Pending, receiptFor(item, false, session.Provider))
		}
	}
	return summary
}

// InboxObserver is what of the inbox follows sessions: their changes and
// their transcripts' events (Service.InboxObserver).
type InboxObserver interface {
	ChangeObserver
	EventObserver
}

// InboxObserver settles messages from what their session reports and
// wakes the pump when a session can take held ones.
func (s *Service) InboxObserver() InboxObserver { return inboxReactions{s} }

// InboxKicks fires when held messages should be tried again at once;
// InboxPumpInterval tries them anyway (PumpInbox).
func (s *Service) InboxKicks() <-chan struct{} { return s.inbox.kicks() }

// WakeInbox tries held messages again soon.
func (s *Service) WakeInbox() { s.inbox.wake() }

// Child reports (httpapi's child_reports.go) are messages Foundry puts in a
// parent's inbox when a session it created ends a turn.
// ChildReportPrefix opens every report.
const ChildReportPrefix = "Foundry report:"

// ChildReportGather: a report to a parent between turns waits this long
// for its siblings, so children that end together start one parent turn.
var ChildReportGather = 10 * time.Second

// childReportsGathering reports whether the due messages of a session
// between turns wait for more reports: one of them is a report younger than
// ChildReportGather.
func childReportsGathering(items []store.SessionInboxItem, due []int, now time.Time) bool {
	for _, index := range due {
		item := items[index]
		if strings.HasPrefix(item.Prompt, ChildReportPrefix) && now.Sub(item.CreatedAt) < ChildReportGather {
			return true
		}
	}
	return false
}

// RecentMessages is what a sender sent one recipient in the last hour.
type RecentMessages struct {
	LastHour int `json:"lastHour"`
	// BoundaryOrInterrupt of them reached, or reach, a running turn.
	BoundaryOrInterrupt int `json:"boundaryOrInterrupt"`
}

// RecentToRecipient counts the sender's messages to the session in the
// last hour, this one included; Foundry's reports are not the sender's.
func (s *Service) RecentToRecipient(ctx context.Context, sessionID, senderSessionID string) *RecentMessages {
	items, err := s.store.SessionInboxItems(ctx, sessionID, time.Now().Add(-time.Hour), 500)
	if err != nil {
		return nil
	}
	recent := &RecentMessages{}
	for _, item := range items {
		if item.SenderSessionID != senderSessionID || strings.HasPrefix(item.Prompt, ChildReportPrefix) {
			continue
		}
		recent.LastHour++
		if item.Delivery == store.DeliveryBoundary || item.Delivery == store.DeliveryInterrupt {
			recent.BoundaryOrInterrupt++
		}
	}
	return recent
}

// SettleInboxItem admits item as already consumed, with reason: its
// recipient read it another way. It runs under the placement lock, so the
// item is not placed meanwhile.
func (s *Service) SettleInboxItem(ctx context.Context, item store.SessionInboxItem, reason string) {
	s.inbox.mu.Lock()
	defer s.inbox.mu.Unlock()
	admission, err := s.store.AdmitSessionInboxItem(ctx, item, store.SessionInboxRules{Now: time.Now().UTC()})
	if err != nil || admission.Item.InputID != item.InputID {
		return
	}
	s.ChangeInboxItem(ctx, admission.Item, store.SessionInboxChange{From: []string{store.InboxHeld}, State: store.InboxConsumed, Reason: reason})
}
