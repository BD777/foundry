package httpapi

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Signals waiting on an item (DEV-324, assistant.SignalTarget): a helper's
// signal no session following its item could take is kept on the item, and
// goes out, in order, into the inbox of the next session that follows it:
// one that claims the item (at once), or the assistant's conversation once
// one is reachable again (itemSignalPumpInterval). From the inbox on it is
// delivered like any other message.

const itemSignalPumpInterval = 5 * time.Second

// queueItemSignal keeps item (a signal for no session yet) on the item
// target names; a newer one with the same mergeKey replaces it.
func (s *Server) queueItemSignal(ctx context.Context, target assistant.SignalTarget, item store.SessionInboxItem, mergeKey string) {
	created, err := s.store.QueuePersonalAgentItemSignal(ctx, store.PersonalAgentItemSignal{
		ID: item.InputID, AssistantID: target.AssistantID, ItemID: target.ItemID, SenderSessionID: item.SenderSessionID,
		Prompt: item.Prompt, Delivery: item.RequestedDelivery, Source: item.InputSource, MergeKey: mergeKey,
	})
	if err != nil {
		log.Printf("signal of %s: keep on item %s: %v", item.SenderSessionID, target.ItemID, err)
		return
	}
	if created {
		log.Printf("signal of %s waits on item %s: no session follows it (input=%s)", item.SenderSessionID, target.ItemID, item.InputID)
	}
}

// sendWaitingItemSignals puts the signals waiting on target's item in the
// inbox of the session target names, oldest first, before a newer signal
// goes there.
func (s *Server) sendWaitingItemSignals(ctx context.Context, target assistant.SignalTarget) {
	if target.ItemID == "" || target.SessionID == "" {
		return
	}
	signals, err := s.store.WaitingPersonalAgentItemSignals(ctx, target.AssistantID, target.ItemID)
	if err != nil {
		log.Printf("item %s: list waiting signals: %v", target.ItemID, err)
		return
	}
	sent := false
	for _, signal := range signals {
		item := store.SessionInboxItem{
			SessionID: target.SessionID, InputID: signal.ID, SenderSessionID: signal.SenderSessionID,
			Prompt: signal.Prompt + fmt.Sprintf("\n(Foundry kept this on item %s from %s, while no session followed the item.)",
				signal.ItemID, signal.CreatedAt.UTC().Format(time.RFC3339)),
			RequestedDelivery: signal.Delivery, InputSource: signal.Source,
		}
		admission, err := s.store.AdmitSessionInboxItem(ctx, item, store.SessionInboxRules{Now: time.Now().UTC()})
		if err != nil {
			log.Printf("item %s: send waiting signal %s to %s: %v", target.ItemID, signal.ID, target.SessionID, err)
			return
		}
		if err := s.store.MarkPersonalAgentItemSignalSent(ctx, signal.ID, target.SessionID, time.Now()); err != nil {
			log.Printf("item %s: mark signal %s sent: %v", target.ItemID, signal.ID, err)
			return
		}
		sessions.LogInboxItem("admitted", admission.Item)
		sent = true
	}
	if sent {
		s.sessionService.WakeInbox()
	}
}

// itemClaimed sends what waited on an item to the session that just
// claimed it.
func (s *Server) itemClaimed(assistantID, itemID string) {
	ctx := context.Background()
	s.sendWaitingItemSignals(ctx, s.assistant.ItemSignalTarget(ctx, store.PersonalAgentItemRef{AssistantID: assistantID, ItemID: itemID}))
}

// pumpItemSignals sends the signals waiting on each item whose holder or
// assistant conversation is reachable now.
func (s *Server) pumpItemSignals(ctx context.Context) {
	refs, err := s.store.ItemsWithWaitingSignals(ctx, 100)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("item signals: list waiting: %v", err)
		}
		return
	}
	for _, ref := range refs {
		if ctx.Err() != nil {
			return
		}
		s.sendWaitingItemSignals(ctx, s.assistant.ItemSignalTarget(ctx, ref))
	}
}
