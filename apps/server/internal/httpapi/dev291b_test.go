package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A message channel's item is noticed to its assistant once, in the channel's
// conversation: a repeated poll for the same item does not notice it again.
func TestChannelItemIsNoticedOnceInTheChannelsConversation(t *testing.T) {
	f := newChannelSessionFixture(t)
	ctx := context.Background()
	f.server.tellAboutMessageChannel(ctx, f.channel, "held-1", "A held message", "held text")
	if item := openItemsOf(t, f.needsYouFixture)["A held message"]; item.NotifiedAt != "" {
		t.Fatalf("noticed before the sweep: %q", item.NotifiedAt)
	}
	f.server.maintainNeedsYou(ctx, time.Now().UTC())
	first := openItemsOf(t, f.needsYouFixture)["A held message"]
	if first.NotifiedAt == "" {
		t.Fatal("the channel item was not noticed to its assistant")
	}
	f.server.tellAboutMessageChannel(ctx, f.channel, "held-1", "A held message", "held text")
	f.server.maintainNeedsYou(ctx, time.Now().UTC().Add(time.Minute))
	if again := openItemsOf(t, f.needsYouFixture)["A held message"]; again.NotifiedAt != first.NotifiedAt {
		t.Fatalf("a repeated poll re-noticed the item: %q, then %q", first.NotifiedAt, again.NotifiedAt)
	}
}

// Stopped, an assistant is not told of a channel item; resuming tells it once
// again of the items it was told of and that are still open, and an item not
// yet told waits for the sweep.
func TestChannelItemNoticeOnResumeIsOncePerOpenItem(t *testing.T) {
	f := newChannelSessionFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	f.server.tellAboutMessageChannel(ctx, f.channel, "held-1", "A held message", "held text")
	f.server.maintainNeedsYou(ctx, time.Now().UTC())
	if _, err := f.db.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	f.server.tellAboutMessageChannel(ctx, f.channel, "gap-1", "A gap in messages", "gap text")
	f.server.maintainNeedsYou(ctx, time.Now().UTC())
	if item := openItemsOf(t, f.needsYouFixture)["A gap in messages"]; item.NotifiedAt != "" {
		t.Fatalf("a stopped assistant was noticed: %q", item.NotifiedAt)
	}
	if _, err := f.db.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentActive); err != nil {
		t.Fatal(err)
	}
	if queued := f.server.noticeChannelItemsOnResume(ctx, agent); queued != 1 {
		t.Fatalf("resume queued %d notices, want the one still-open notified item", queued)
	}
	f.server.maintainNeedsYou(ctx, time.Now().UTC())
	if item := openItemsOf(t, f.needsYouFixture)["A gap in messages"]; item.NotifiedAt == "" {
		t.Fatal("the item not yet told was not noticed by the sweep after resume")
	}
}

// An answer aimed at one item lands on that item's question, not on the
// helper's newest one, and settles only that item.
func TestAnswerToAnItemWrapsTheItemsOwnQuestion(t *testing.T) {
	f := newNeedsYouFixture(t)
	f.ask(t, f.helper, "qa", "Which format?")
	f.ask(t, f.helper, "qb", "Which size?")
	older := openItemsOf(t, f)["Which format?"]
	if text, failed := f.needsYou(t, map[string]any{"op": "resolve", "itemId": older.ID, "answer": "csv"}); failed {
		t.Fatalf("resolve with answer to an item: %s", text)
	}
	sent := helperInbox(t, f)
	if len(sent) != 1 || !strings.Contains(sent[0].Prompt, "msg_qa") || strings.Contains(sent[0].Prompt, "msg_qb") || !strings.Contains(sent[0].Prompt, "csv") {
		t.Fatalf("the answer did not target the item's question: %+v", sent)
	}
	open := openItemsOf(t, f)
	if _, ok := open["Which size?"]; !ok || len(open) != 1 {
		t.Fatalf("the newer question was settled by an answer to an older item: %+v", open)
	}
}
