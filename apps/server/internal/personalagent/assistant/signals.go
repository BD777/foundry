package assistant

import (
	"context"
	"errors"
	"log"

	"github.com/google/uuid"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Signals by item (DEV-324). Every signal a session sends the side that
// sent it work (the report of an ended turn, a relayed question, an alert,
// a supervision fact) goes where SignalTarget says. A session tied to an item
// (its task's item, or a workspace session's helper link) reports to whoever
// follows the item, in this order:
//
//  1. the item's holder, while it is live (not archived, not stopped);
//  2. the assistant conversation following its task: the one that handed it
//     off, or took it over since (AdoptTask);
//  3. the session the signal's own rule names: its creator for a report or
//     a question, the sender of its turn for an alert;
//  4. the assistant's latest conversation;
//  5. else the signal waits on the item (store.PersonalAgentItemSignal)
//     until a session claims the item or a conversation of the assistant is
//     reachable again.
//
// A session tied to no item keeps the rule of its signal, but for step 2.

// Steps of SignalTarget, in SignalTarget.Via.
const (
	SignalViaHolder    = "holder"
	SignalViaTask      = "task"
	SignalViaFollower  = "follower"
	SignalViaAssistant = "assistant"
)

// SignalTarget is where a session's signal goes.
type SignalTarget struct {
	// SessionID takes the signal now. "" with an item set: the signal waits
	// on the item. "" without: the signal's own rule names no one.
	SessionID string
	// Via is the step that chose SessionID.
	Via string
	// AssistantID and ItemID name the item the session works on, if any.
	AssistantID string
	ItemID      string
}

// Queued reports whether the signal waits on its item.
func (t SignalTarget) Queued() bool { return t.SessionID == "" && t.ItemID != "" }

// SignalTarget is where a signal of session goes; follower is the session
// the signal's own rule names (step 3), which the caller checks itself when
// the session works on no item.
func (s *Service) SignalTarget(ctx context.Context, session store.AgentSession, follower string) SignalTarget {
	_, task, isTask := s.TaskOf(ctx, session)
	var ref store.PersonalAgentItemRef
	if isTask && task.ItemID != "" {
		ref = store.PersonalAgentItemRef{AssistantID: task.AssistantID, ItemID: task.ItemID}
	} else if linked, err := s.store.PersonalAgentItemOfHelper(ctx, session.ID); err == nil {
		ref = linked
	} else if !errors.Is(err, store.ErrNotFound) {
		log.Printf("signal of %s: read its item: %v", session.ID, err)
	}
	item, onItem := s.liveItem(ctx, ref)
	if onItem && s.liveFollower(ctx, item.HolderSessionID, session.ID) {
		return SignalTarget{SessionID: item.HolderSessionID, Via: SignalViaHolder, AssistantID: item.AssistantID, ItemID: item.ID}
	}
	target := SignalTarget{}
	if onItem {
		target.AssistantID, target.ItemID = item.AssistantID, item.ID
	}
	switch {
	case isTask && task.ConversationSessionID != "" && s.liveFollower(ctx, task.ConversationSessionID, session.ID):
		target.SessionID, target.Via = task.ConversationSessionID, SignalViaTask
	case !onItem:
		target.SessionID, target.Via = follower, SignalViaFollower
	case s.liveFollower(ctx, follower, session.ID):
		target.SessionID, target.Via = follower, SignalViaFollower
	default:
		if conversation := s.itemConversation(ctx, item.AssistantID, session.ID); conversation != "" {
			target.SessionID, target.Via = conversation, SignalViaAssistant
		}
	}
	return target
}

// ItemSignalTarget is where an item's waiting signals go: its live holder,
// else the assistant's latest conversation; "" while neither is reachable.
func (s *Service) ItemSignalTarget(ctx context.Context, ref store.PersonalAgentItemRef) SignalTarget {
	target := SignalTarget{AssistantID: ref.AssistantID, ItemID: ref.ItemID}
	item, err := s.store.GetPersonalAgentItem(ctx, ref.AssistantID, ref.ItemID)
	if err != nil {
		return target
	}
	if s.liveFollower(ctx, item.HolderSessionID, "") {
		target.SessionID, target.Via = item.HolderSessionID, SignalViaHolder
	} else if conversation := s.itemConversation(ctx, item.AssistantID, ""); conversation != "" {
		target.SessionID, target.Via = conversation, SignalViaAssistant
	}
	return target
}

// liveItem is the item ref names, unless it was deleted.
func (s *Service) liveItem(ctx context.Context, ref store.PersonalAgentItemRef) (store.PersonalAgentListItem, bool) {
	if ref.ItemID == "" {
		return store.PersonalAgentListItem{}, false
	}
	item, err := s.store.GetPersonalAgentItem(ctx, ref.AssistantID, ref.ItemID)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			log.Printf("signal: read item %s: %v", ref.ItemID, err)
		}
		return item, false
	}
	return item, item.Text != ""
}

// liveFollower reports whether sessionID can take a signal from another
// session (not self): it exists, is not archived or stopped, and no Issue
// controls it.
func (s *Service) liveFollower(ctx context.Context, sessionID, self string) bool {
	if sessionID == "" || sessionID == self {
		return false
	}
	session, err := s.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil {
		return false
	}
	return session.ArchivedAt == "" && session.Status != "canceled" &&
		(session.Role == "" || session.Role == store.AgentSessionRolePersonalAgent)
}

// itemConversation is the latest conversation of the assistant whose list
// holds an item, when one is live.
func (s *Service) itemConversation(ctx context.Context, assistantID, self string) string {
	agent, err := s.store.GetAssistant(ctx, assistantID)
	if err != nil {
		return ""
	}
	if conversation := s.latestConversation(ctx, agent); s.liveFollower(ctx, conversation, self) {
		return conversation
	}
	return ""
}

// queueNotice keeps a Foundry notice of sender's on the item target names,
// for the session that follows the item next; a newer notice with the same
// key replaces it. It reports whether the notice is kept.
func (s *Service) queueNotice(ctx context.Context, target SignalTarget, sender, noticeKind, text, key string) bool {
	_, err := s.store.QueuePersonalAgentItemSignal(ctx, store.PersonalAgentItemSignal{
		ID: uuid.NewString(), AssistantID: target.AssistantID, ItemID: target.ItemID, SenderSessionID: sender,
		Prompt: personalagent.Notice(text), Delivery: store.DeliveryTurnEnd, MergeKey: key,
		Source: &store.AgentSessionInputSource{Kind: "foundry_notice", NoticeKind: noticeKind},
	})
	if err != nil {
		log.Printf("signal of %s: keep %s notice on item %s: %v", sender, noticeKind, target.ItemID, err)
		return false
	}
	log.Printf("signal of %s: %s notice waits on item %s: no session follows it", sender, noticeKind, target.ItemID)
	return true
}
