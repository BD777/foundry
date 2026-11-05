package sessions

import (
	"context"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Messages between turns wait in two cases instead of starting a turn at
// once (DEV-119):
//
//   - A turn_end message a child sends its idle parent waits for the turn
//     the child sent it in to end, at most InboxTurnEndFlush: the progress
//     note then arrives together with that turn's report, and a child's
//     several notes start one parent turn, not one each. Messages down to
//     a child, or between sessions not so related, go as before.
//   - A turn that failed before its model answered (its provider or runtime
//     is failing) did not deliver the messages it carried: they are held
//     again. While the session's last turn ended that way, messages wait
//     before they start another turn, longer after each failed turn that
//     carried them, so a failing provider does not take one turn per
//     message. A turn that runs meanwhile (the person's) takes them.

const (
	// inboxReasonSenderTurn: a child's turn_end message to its idle parent
	// waits for the child's turn.
	inboxReasonSenderTurn = "sender_turn"
	// inboxReasonTurnFailed: the session's last turn failed before its
	// model answered; the message waits to start (or join) the next one.
	inboxReasonTurnFailed = "turn_failed"
	failedTurnRetryMax    = 30 * time.Minute
	// turnAnswerWindow is how many of a session's newest events are read
	// to tell whether its last turn's model answered.
	turnAnswerWindow = 200
)

// FailedTurnRetryBase is how long messages wait after the first failed
// turn; each failed turn that carried them doubles it, up to 30 minutes.
var FailedTurnRetryBase = time.Minute

// failedTurnRetryDelay is how long after a failed turn messages wait,
// given how many failed turns carried them already.
func failedTurnRetryDelay(attempts int) time.Duration {
	return min(FailedTurnRetryBase<<min(attempts, 5), failedTurnRetryMax)
}

// withoutWaitingInboxItems returns those of due (indexes into items, the
// idle session's pending messages) that may start its next turn now; the
// held ones that wait say why.
func (s *Service) withoutWaitingInboxItems(ctx context.Context, session store.AgentSession, items []store.SessionInboxItem, due []int, now time.Time) []int {
	if s.failedTurnWaits(ctx, session, items, due, now) {
		for _, index := range due {
			items[index] = s.holdInboxItemFor(ctx, items[index], inboxReasonTurnFailed)
		}
		return nil
	}
	senders := map[string]store.AgentSession{}
	ready := due[:0]
	for _, index := range due {
		if s.waitsForSenderTurn(ctx, session, items[index], senders, now) {
			items[index] = s.holdInboxItemFor(ctx, items[index], inboxReasonSenderTurn)
			continue
		}
		ready = append(ready, index)
	}
	return ready
}

func (s *Service) holdInboxItemFor(ctx context.Context, item store.SessionInboxItem, reason string) store.SessionInboxItem {
	if item.State != store.InboxHeld || item.Reason == reason {
		return item
	}
	return s.ChangeInboxItem(ctx, item, store.SessionInboxChange{From: []string{store.InboxHeld}, State: store.InboxHeld, Reason: reason})
}

// waitsForSenderTurn: item is a turn_end message to session from a child
// of it that is still in the turn it sent it from, or ended it less than
// ChildReportGather ago, and it has not waited InboxTurnEndFlush yet.
func (s *Service) waitsForSenderTurn(ctx context.Context, session store.AgentSession, item store.SessionInboxItem, senders map[string]store.AgentSession, now time.Time) bool {
	if item.State != store.InboxHeld || item.Delivery != store.DeliveryTurnEnd || item.SenderSessionID == "" || now.Sub(item.CreatedAt) >= InboxTurnEndFlush {
		return false
	}
	sender, known := senders[item.SenderSessionID]
	if !known {
		var err error
		if sender, err = s.store.GetAgentSessionSummary(ctx, item.SenderSessionID); err != nil {
			return false
		}
		senders[item.SenderSessionID] = sender
	}
	if sender.ParentSessionID != session.ID {
		return false
	}
	if sender.Status == "running" || sender.Status == "blocked" {
		started, err := time.Parse(time.RFC3339Nano, sender.StartedAt)
		return err == nil && !started.After(item.CreatedAt)
	}
	// Its turn just ended: the report of that turn is on its way (the
	// pump wakes before it is admitted), and the two start one turn.
	ended, err := time.Parse(time.RFC3339Nano, sender.CompletedAt)
	return err == nil && ended.After(item.CreatedAt) && now.Sub(ended) < ChildReportGather
}

// failedTurnWaits: the session's last turn failed before its model
// answered, and the messages have not waited their retry delay since.
func (s *Service) failedTurnWaits(ctx context.Context, session store.AgentSession, items []store.SessionInboxItem, due []int, now time.Time) bool {
	if session.Status != "failed" {
		return false
	}
	ended, err := time.Parse(time.RFC3339Nano, session.CompletedAt)
	if err != nil {
		return false
	}
	if now.Sub(ended) >= failedTurnRetryMax || s.turnAnswered(ctx, session) {
		return false
	}
	// The wait grows with the failed turns any of its messages went in,
	// not only those placed now: a new message alone must not cut it short.
	attempts := 0
	for _, index := range due {
		if items[index].Reason == inboxReasonTurnFailed {
			attempts = max(attempts, items[index].Attempts)
		}
	}
	if pending, err := s.store.SessionInboxItems(ctx, session.ID, now.Add(-24*time.Hour), 200); err == nil {
		for _, item := range pending {
			if item.State == store.InboxHeld && item.Reason == inboxReasonTurnFailed {
				attempts = max(attempts, item.Attempts)
			}
		}
	}
	return now.Sub(ended) < failedTurnRetryDelay(attempts)
}

// reopenFailedTurnInbox holds again the messages a turn that failed before
// its model answered carried, as its input or steered into it: they never
// reached the model.
func (s *Service) reopenFailedTurnInbox(ctx context.Context, session store.AgentSession) {
	if session.Status != "failed" || session.Input.ID == "" || s.turnAnswered(ctx, session) {
		return
	}
	started, err := time.Parse(time.RFC3339Nano, session.StartedAt)
	if err != nil {
		started = time.Now()
	}
	items, err := s.store.SessionInboxItems(ctx, session.ID, time.Now().Add(-24*time.Hour), 200)
	if err != nil {
		return
	}
	for _, item := range items {
		carried := item.DeliveredAs == "turn" && item.DeliveredInputID == session.Input.ID
		steered := item.DeliveredAs == "steer" && item.DeliveredAt != nil && !item.DeliveredAt.Before(started)
		if carried || steered {
			s.ChangeInboxItem(ctx, item, store.SessionInboxChange{
				From: []string{store.InboxDelivered, store.InboxConsumed}, State: store.InboxHeld,
				Reason: inboxReasonTurnFailed, Reopen: true, CountAttempt: true,
			})
		}
	}
}

// turnAnswered reports whether the model of the session's current input
// produced anything: an answer, commentary, reasoning or a tool call. A
// turn that cannot be read counts as answered, so nothing waits on a guess.
func (s *Service) turnAnswered(ctx context.Context, session store.AgentSession) bool {
	key := session.ID + "\x00" + session.Input.ID
	if answered, known := s.inbox.answeredTurn(key); known {
		return answered
	}
	events, _, err := s.store.AgentSessionEventWindow(ctx, session.ID, "", turnAnswerWindow)
	if err != nil {
		return true
	}
	answered := true // its start lies beyond the window: it ran long enough
	start := store.SessionInputEventID(session.Input.ID)
	for index := len(events) - 1; index >= 0; index-- {
		event := events[index]
		if event.ID == start {
			answered = false
			break
		}
		if modelSpoke(event) {
			break
		}
	}
	s.inbox.rememberTurn(key, answered)
	return answered
}

func modelSpoke(event store.AgentSessionEvent) bool {
	if event.Label == store.EventLabelResponseStream {
		return true
	}
	if event.Message == nil {
		return false
	}
	switch event.Message.Kind {
	case "assistant", "reasoning", "commentary", "tool":
		return true
	}
	return false
}
