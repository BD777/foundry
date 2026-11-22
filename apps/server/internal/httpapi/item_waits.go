package httpapi

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// An item that waits on the person (store.ItemWaitsOnPerson) is a request in
// their Needs you, as the session keeping the item wrote it with update_list.
// Foundry reads only the plan's structured fields, never its words: an item
// begins waiting, its entry opens (with its notice and a needs_you_opened
// event); it stops waiting or closes, the entry closes; the person answers,
// the answer goes where the item's signals go and the item's timeline records
// their words. Whether to ask, and what the answer means, is the Agent's.

// itemWaitDelay lets an item change commit before its waits are read again.
const itemWaitDelay = time.Second

// itemWaitAnswerSpace names the inbox ids of answers to item waits.
var itemWaitAnswerSpace = uuid.MustParse("5d2f9a61-0c4b-4e7a-b3f8-61a9c2e47d05")

// errItemWaitGone refuses an answer to an item that no longer waits for it.
var errItemWaitGone = errors.New("the item no longer waits on the person for this")

// itemWaitWatch gathers the assistants whose items changed, so each is
// reconciled once after itemWaitDelay.
type itemWaitWatch struct {
	mu      sync.Mutex
	pending map[string]bool
}

// itemChangedForWaits notes an item change. The store calls it inside the
// change's transaction, so it only takes note; the reconcile runs after.
func (s *Server) itemChangedForWaits(change store.PersonalAgentItemChange) {
	w := &s.itemWaits
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.pending == nil {
		w.pending = map[string]bool{}
	}
	if w.pending[change.AssistantID] {
		return
	}
	w.pending[change.AssistantID] = true
	assistantID := change.AssistantID
	time.AfterFunc(itemWaitDelay, func() {
		w.mu.Lock()
		delete(w.pending, assistantID)
		w.mu.Unlock()
		ctx := context.Background()
		agent, err := s.store.GetAssistant(ctx, assistantID)
		if err != nil {
			log.Printf("item waits of assistant %s: %v", assistantID, err)
			return
		}
		s.reconcileItemWaits(ctx, agent.UserID)
	})
}

// reconcileItemWaits makes the person's item_wait entries match their items:
// one open entry per item that waits on them, unless the person already
// answered that same request; an entry whose item stopped waiting closes.
func (s *Server) reconcileItemWaits(ctx context.Context, userID string) {
	wanted := map[string]store.PersonalAgentListItem{}
	filter := store.PersonalAgentItemFilter{UserID: userID, View: store.PersonalAgentItemViewOpen, Limit: store.PersonalAgentItemPageMax}
	for {
		page, err := s.store.ListPersonalAgentItemPage(ctx, "", filter)
		if err != nil {
			log.Printf("item waits of %s: list open items: %v", userID, err)
			return
		}
		for _, item := range page.Items {
			if store.ItemWaitsOnPerson(item) {
				wanted[store.ItemWaitKey(item.ID, item.Plan.WaitingFor)] = item
			}
		}
		if page.NextOffset == 0 {
			break
		}
		filter.Offset = page.NextOffset
	}
	entries, err := s.store.ListPendingItems(ctx, userID, []string{store.PendingOpen, store.PendingDone}, "", 500)
	if err != nil {
		log.Printf("item waits of %s: list entries: %v", userID, err)
		return
	}
	open, answered := map[string]bool{}, map[string]bool{}
	for _, entry := range entries {
		if entry.Source != store.PendingSourceItemWait {
			continue
		}
		switch {
		case entry.State == store.PendingOpen:
			if _, still := wanted[entry.Key]; !still {
				s.closeItemWait(ctx, entry.Key, "item_no_longer_waits")
				continue
			}
			open[entry.Key] = true
		case entry.Outcome == store.PendingOutcomePersonAnswered:
			answered[entry.Key] = true
		}
	}
	for key, item := range wanted {
		if open[key] || answered[key] {
			continue
		}
		s.openItemWait(ctx, key, item)
	}
}

// openItemWait records the item's wait as an entry for the person, with its
// notice, and the needs_you_opened event on the item.
func (s *Server) openItemWait(ctx context.Context, key string, item store.PersonalAgentListItem) {
	workspaceID := item.HomeWorkspaceID
	if workspaceID == "" {
		agent, err := s.store.GetAssistant(ctx, item.AssistantID)
		if err != nil {
			log.Printf("item wait of %s: read its assistant: %v", item.ID, err)
			return
		}
		workspaceID = agent.WorkspaceID
	}
	waitingFor := strings.TrimSpace(item.Plan.WaitingFor)
	entry, changed, err := s.recordPendingItem(ctx, store.PendingItem{
		UserID: item.UserID, AssistantID: item.AssistantID, WorkspaceID: workspaceID, WaitItemID: item.ID,
		Source: store.PendingSourceItemWait, Key: key, EventID: key + "@" + item.UpdatedAt,
		Title: pendingTitle(waitingFor), Excerpt: textcut.Excerpt(waitingFor, pendingExcerptLimit),
		Context: textcut.Excerpt(item.Text, pendingContextLimit), Handler: store.PendingHandlerPerson,
	})
	if err != nil {
		log.Printf("item wait of %s: record: %v", item.ID, err)
		return
	}
	if !changed {
		return
	}
	if err := s.store.RecordPersonalAgentItemNeedsYouEvent(ctx, store.PersonalAgentActorFoundry, item.AssistantID, item.ID,
		store.PersonalAgentItemEventNeedsYouOpened, store.PersonalAgentItemEventDetail{NeedsYouID: entry.ID, Title: textcut.Excerpt(waitingFor, store.PersonalAgentItemDecisionMaxLength)}); err != nil {
		log.Printf("item wait of %s: record its opening: %v", item.ID, err)
	}
}

// closeItemWait closes an open item_wait entry whose item no longer waits;
// its card shows that in place.
func (s *Server) closeItemWait(ctx context.Context, key, detail string) {
	if _, err := s.store.ResolvePendingItems(ctx, store.PendingResolution{
		Key: key, Sources: []string{store.PendingSourceItemWait}, State: store.PendingSuperseded,
		ResolutionReason: store.PendingResolutionAutoResolved, ResolutionDetail: detail,
	}); err != nil {
		log.Printf("item wait %s: close: %v", key, err)
	}
}

// answerItemWait gives the person's answer to what an item waits for to the
// session that follows the item (ItemSignalTarget: its holder, else the
// assistant's latest conversation, else it waits on the item for the next
// one), records their words on the item's timeline, and closes the entry as
// answered by the person. An item that no longer waits for it is refused and
// its entry closed.
func (s *Server) answerItemWait(ctx context.Context, entry store.PendingItem, answer string) (store.PendingItem, error) {
	current, err := s.store.GetPendingItem(ctx, entry.UserID, entry.ID)
	if err != nil {
		return store.PendingItem{}, err
	}
	if current.State != store.PendingOpen {
		return store.PendingItem{}, fmt.Errorf("%w: it is already %s", errItemWaitGone, current.State)
	}
	entry = current
	item, err := s.store.GetPersonalAgentItem(ctx, entry.AssistantID, entry.WaitItemID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return store.PendingItem{}, err
	}
	if err != nil || !store.ItemWaitsOnPerson(item) || store.ItemWaitKey(item.ID, item.Plan.WaitingFor) != entry.Key {
		s.closeItemWait(ctx, entry.Key, "item_no_longer_waits")
		return store.PendingItem{}, errItemWaitGone
	}
	ref := store.PersonalAgentItemRef{AssistantID: item.AssistantID, ItemID: item.ID}
	target := s.assistant.ItemSignalTarget(ctx, ref)
	inbox := store.SessionInboxItem{
		SessionID: target.SessionID, SenderSessionID: target.SessionID,
		InputID:           uuid.NewSHA1(itemWaitAnswerSpace, []byte(entry.ID)).String(),
		Prompt:            personalagent.ItemAnswerFrame(item.ID, item.Plan.WaitingFor, answer),
		RequestedDelivery: store.DeliveryBoundary,
		InputSource:       &store.AgentSessionInputSource{Kind: "foundry_notice", NoticeKind: store.NoticeKindQuestionAnswer},
	}
	if target.SessionID == "" {
		// No session follows the item now: the answer waits on it for the next
		// one, sent as by the session that kept it last.
		inbox.SenderSessionID = cmp.Or(item.HolderSessionID, item.SourceSessionID)
		if inbox.SenderSessionID == "" {
			return store.PendingItem{}, fmt.Errorf("item %s has no session to send the answer as", item.ID)
		}
		s.queueItemSignal(ctx, target, inbox, "")
	} else {
		admission, err := s.store.AdmitSessionInboxItem(ctx, inbox, store.SessionInboxRules{Now: time.Now().UTC(), DedupWindow: sessions.InboxDedupWindow})
		if err != nil {
			return store.PendingItem{}, fmt.Errorf("deliver the answer to session %s: %w", target.SessionID, err)
		}
		if !admission.Duplicate {
			s.sessionService.WakeInbox()
		}
	}
	if err := s.store.RecordPersonalAgentItemNeedsYouEvent(ctx, store.PersonalAgentActorPerson, item.AssistantID, item.ID,
		store.PersonalAgentItemEventNeedsYouAnswered, store.PersonalAgentItemEventDetail{NeedsYouID: entry.ID, Quote: textcut.Excerpt(strings.TrimSpace(answer), store.PersonalAgentItemDecisionMaxLength)}); err != nil {
		log.Printf("item wait of %s: record the answer: %v", item.ID, err)
	}
	return s.store.ResolvePendingItem(ctx, entry.UserID, entry.ID, store.PendingDone, store.PendingOutcomePersonAnswered,
		store.PendingAnswer{Text: answer, By: store.PendingAnsweredByPerson})
}
