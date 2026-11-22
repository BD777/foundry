package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// itemWaitEntries are the person's item_wait entries in the given states.
func itemWaitEntries(t *testing.T, f assistantFixture, states ...string) []store.PendingItem {
	t.Helper()
	items, err := f.server.store.ListPendingItems(context.Background(), f.aliceID, states, "", 500)
	if err != nil {
		t.Fatal(err)
	}
	var waits []store.PendingItem
	for _, item := range items {
		if item.Source == store.PendingSourceItemWait {
			waits = append(waits, item)
		}
	}
	return waits
}

// eventsOfKind are an item's timeline events of one kind.
func eventsOfKind(t *testing.T, f assistantFixture, assistantID, itemID, kind string) []store.PersonalAgentItemEvent {
	t.Helper()
	var out []store.PersonalAgentItemEvent
	for _, event := range f.itemEvents(t, assistantID, itemID) {
		if event.Kind == kind {
			out = append(out, event)
		}
	}
	return out
}

const itemWaitWords = "ask me which batch before you rerun anything"

// waitingPlan is a plan that waits on the person for what.
func waitingPlan(what string) map[string]any {
	return map[string]any{"mode": "record", "progress": "waiting", "waitingOn": "person", "waitingFor": what}
}

// An item a workspace session keeps, marked as waiting on the person, is a
// request in their Needs you, named by the item and recorded on its timeline.
// The item cannot be closed while it is unanswered. The person's answer goes to
// the item's holder as their own words, the timeline records them, and the
// request is not asked again; a new question is a new request, and a plan that
// no longer waits withdraws it, after which the item closes.
func TestAnItemWaitingOnThePersonIsARequestAnsweredToItsHolder(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	session := f.startSession(t, "ws_alice", "", itemWaitWords)
	token := f.mint(t, session.ID)
	added, text, failed := f.updateItem(t, token, "add", map[string]any{"text": "Rerun the batch", "quote": "which batch before you rerun"})
	if failed {
		t.Fatalf("add: %s", text)
	}
	id := added.Item.ID
	if _, text, failed := f.updateItem(t, token, "claim", map[string]any{"id": id}); failed {
		t.Fatalf("claim: %s", text)
	}
	update := func(fields map[string]any) (itemToolAnswer, string, bool) {
		t.Helper()
		current, err := f.server.store.GetPersonalAgentItem(ctx, agent.ID, id)
		if err != nil {
			t.Fatal(err)
		}
		fields["id"], fields["revision"], fields["quote"] = id, current.Revision, "which batch before you rerun"
		return f.updateItem(t, token, "update", fields)
	}
	if _, text, failed := update(map[string]any{"plan": map[string]any{"mode": "record", "progress": "waiting", "waitingOn": "someone"}}); !failed || !strings.Contains(text, "plan.waitingOn") {
		t.Fatalf("an unknown waitingOn was accepted: %s", text)
	}
	if _, text, failed := update(map[string]any{"plan": waitingPlan("Batch A (17) or batch B (9)?")}); failed {
		t.Fatalf("mark waiting: %s", text)
	}

	f.server.reconcileItemWaits(ctx, f.aliceID)
	open := itemWaitEntries(t, f, store.PendingOpen)
	if len(open) != 1 || open[0].WaitItemID != id || open[0].Title != "Batch A (17) or batch B (9)?" || open[0].Context != "Rerun the batch" || open[0].AssistantID != agent.ID {
		t.Fatalf("open item waits = %+v, want one for the item", open)
	}
	entry := open[0]
	if opened := eventsOfKind(t, f, agent.ID, id, store.PersonalAgentItemEventNeedsYouOpened); len(opened) != 1 || opened[0].Detail == nil || opened[0].Detail.NeedsYouID != entry.ID {
		t.Fatalf("needs_you_opened events = %+v", opened)
	}
	byItem, err := f.server.needsYouByItem(ctx, f.aliceID)
	if err != nil || len(byItem[id]) != 1 || byItem[id][0].ID != entry.ID {
		t.Fatalf("the item's waiting-on-you = %+v (%v)", byItem[id], err)
	}
	f.server.reconcileItemWaits(ctx, f.aliceID)
	if again := itemWaitEntries(t, f, store.PendingOpen); len(again) != 1 || again[0].ID != entry.ID {
		t.Fatalf("a second reconcile changed the waits: %+v", again)
	}

	if _, text, failed := update(map[string]any{"status": "dropped"}); !failed || !strings.Contains(text, "1 unanswered request") {
		t.Fatalf("an item waiting on the person was closed: %s", text)
	}

	answered, err := f.server.answerItemWait(ctx, entry, "Batch A")
	if err != nil || answered.State != store.PendingDone || answered.Outcome != store.PendingOutcomePersonAnswered || answered.Answer != "Batch A" {
		t.Fatalf("answered = %+v (%v)", answered, err)
	}
	inbox, err := f.server.store.SessionInboxItems(ctx, session.ID, time.Now().Add(-time.Hour), 50)
	if err != nil {
		t.Fatal(err)
	}
	var delivered *store.SessionInboxItem
	for i := range inbox {
		if strings.Contains(inbox[i].Prompt, "waits on them for") {
			delivered = &inbox[i]
		}
	}
	if delivered == nil || !strings.HasSuffix(delivered.Prompt, "Their answer:\nBatch A") || !strings.Contains(delivered.Prompt, id) ||
		delivered.InputSource == nil || delivered.InputSource.NoticeKind != store.NoticeKindQuestionAnswer {
		t.Fatalf("the holder's inbox = %+v, want the person's answer", inbox)
	}
	if said := eventsOfKind(t, f, agent.ID, id, store.PersonalAgentItemEventNeedsYouAnswered); len(said) != 1 || said[0].Actor != store.PersonalAgentActorPerson || said[0].Detail == nil || said[0].Detail.Quote != "Batch A" {
		t.Fatalf("needs_you_answered events = %+v", said)
	}
	f.server.reconcileItemWaits(ctx, f.aliceID)
	if reopened := itemWaitEntries(t, f, store.PendingOpen); len(reopened) != 0 {
		t.Fatalf("an answered request was asked again: %+v", reopened)
	}
	if _, err := f.server.answerItemWait(ctx, entry, "Batch B"); err == nil {
		t.Fatal("a second answer to the same request was taken")
	}

	if _, text, failed := update(map[string]any{"plan": waitingPlan("Rerun tonight or tomorrow?")}); failed {
		t.Fatalf("ask again: %s", text)
	}
	f.server.reconcileItemWaits(ctx, f.aliceID)
	second := itemWaitEntries(t, f, store.PendingOpen)
	if len(second) != 1 || second[0].ID == entry.ID || second[0].Title != "Rerun tonight or tomorrow?" {
		t.Fatalf("a new question = %+v, want a new request", second)
	}
	if _, text, failed := update(map[string]any{"plan": map[string]any{"mode": "record", "progress": "working"}}); failed {
		t.Fatalf("withdraw: %s", text)
	}
	f.server.reconcileItemWaits(ctx, f.aliceID)
	if left := itemWaitEntries(t, f, store.PendingOpen); len(left) != 0 {
		t.Fatalf("a withdrawn request is still open: %+v", left)
	}
	if withdrawn, err := f.server.store.GetPendingItem(ctx, f.aliceID, second[0].ID); err != nil || withdrawn.State != store.PendingSuperseded {
		t.Fatalf("the withdrawn request = %+v (%v), want superseded", withdrawn, err)
	}
	if _, text, failed := update(map[string]any{"status": "dropped"}); failed {
		t.Fatalf("an item with nothing waiting could not close: %s", text)
	}
}

// With no session following the item, the person's answer waits on the item
// for the next session that claims it.
func TestAnItemWaitAnswerWaitsForTheNextHolder(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	session := f.startSession(t, "ws_alice", "", itemWaitWords)
	token := f.mint(t, session.ID)
	added, text, failed := f.updateItem(t, token, "add", map[string]any{"text": "Rerun the batch", "quote": "which batch before you rerun",
		"plan": waitingPlan("Batch A or B?")})
	if failed {
		t.Fatalf("add: %s", text)
	}
	f.server.reconcileItemWaits(ctx, f.aliceID)
	open := itemWaitEntries(t, f, store.PendingOpen)
	if len(open) != 1 {
		t.Fatalf("open item waits = %+v", open)
	}
	// Neither the session nor any conversation of the assistant follows it.
	archiveSession(t, f.server, session)
	ref := store.PersonalAgentItemRef{AssistantID: agent.ID, ItemID: added.Item.ID}
	for range 3 {
		target := f.server.assistant.ItemSignalTarget(ctx, ref)
		if target.SessionID == "" {
			break
		}
		conversation, err := f.server.store.GetAgentSessionSummary(ctx, target.SessionID)
		if err != nil {
			t.Fatal(err)
		}
		archiveSession(t, f.server, conversation)
	}
	if target := f.server.assistant.ItemSignalTarget(ctx, ref); target.SessionID != "" || !target.Queued() {
		t.Fatalf("the item still has a follower: %+v", target)
	}
	if _, err := f.server.answerItemWait(ctx, open[0], "Batch B"); err != nil {
		t.Fatalf("answer: %v", err)
	}
	waiting, err := f.server.store.WaitingPersonalAgentItemSignals(ctx, agent.ID, added.Item.ID)
	if err != nil || len(waiting) != 1 || !strings.HasSuffix(waiting[0].Prompt, "Their answer:\nBatch B") {
		t.Fatalf("signals waiting on the item = %+v (%v), want the answer", waiting, err)
	}
}
