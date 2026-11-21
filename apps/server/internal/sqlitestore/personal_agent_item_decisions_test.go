package sqlitestore

import (
	"context"
	"errors"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A decision is appended to the item's timeline with the person's words and
// moves the item's revision, so a save read before it is refused. A later
// decision supersedes an earlier one of the same item only; nothing edits or
// removes the earlier one.
func TestPersonalAgentItemDecisionsAppendAndSupersede(t *testing.T) {
	db, ctx := newTestStore(t), context.Background()
	item, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Item ledger"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := db.AddPersonalAgentItem(ctx, store.PersonalAgentActorAssistant, store.PersonalAgentListItem{UserID: "user_a", AssistantID: "asst_a", Text: "Something else"})
	if err != nil {
		t.Fatal(err)
	}
	first, firstID, err := db.DecidePersonalAgentItem(ctx, store.PersonalAgentActorSession, "asst_a", item.ID,
		store.PersonalAgentItemEventDetail{Decision: "React with an emoji only", Quote: "用表情"})
	if err != nil || firstID == "" {
		t.Fatalf("decide = %q (%v)", firstID, err)
	}
	if first.Revision != item.Revision+1 {
		t.Fatalf("a decision moves the revision: %d after %d", first.Revision, item.Revision)
	}
	stale := item
	stale.Summary = "written before the decision"
	if _, err := db.SavePersonalAgentItem(ctx, store.PersonalAgentActorSession, stale); !errors.Is(err, store.ErrPersonalAgentRevision) {
		t.Fatalf("a save read before the decision = %v, want a revision conflict", err)
	}
	_, secondID, err := db.DecidePersonalAgentItem(ctx, store.PersonalAgentActorSession, "asst_a", item.ID,
		store.PersonalAgentItemEventDetail{Decision: "Emoji, and a Feishu card to the person", Quote: "细节经飞书卡片", Supersedes: firstID})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := db.DecidePersonalAgentItem(ctx, store.PersonalAgentActorSession, "asst_a", other.ID,
		store.PersonalAgentItemEventDetail{Decision: "x", Quote: "y", Supersedes: secondID}); !errors.Is(err, store.ErrPersonalAgentItemInvalid) {
		t.Fatalf("superseding another item's decision = %v, want refused", err)
	}
	if _, _, err := db.DecidePersonalAgentItem(ctx, store.PersonalAgentActorSession, "asst_a", item.ID,
		store.PersonalAgentItemEventDetail{Decision: "no words"}); !errors.Is(err, store.ErrPersonalAgentItemInvalid) {
		t.Fatalf("a decision without the person's words = %v, want refused", err)
	}
	events, err := db.ListPersonalAgentItemEvents(ctx, "asst_a", item.ID)
	if err != nil {
		t.Fatal(err)
	}
	var decided []store.PersonalAgentItemEvent
	for _, event := range events {
		if event.Kind == store.PersonalAgentItemEventDecided {
			decided = append(decided, event)
		}
	}
	if len(decided) != 2 || decided[0].ID != firstID || decided[0].Actor != store.PersonalAgentActorSession ||
		decided[0].Detail == nil || decided[0].Detail.Quote != "用表情" || decided[1].Detail.Supersedes != firstID {
		t.Fatalf("decided events = %+v", decided)
	}
}
