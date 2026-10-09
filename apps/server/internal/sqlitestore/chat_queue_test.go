package sqlitestore

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func enqueueForTest(t *testing.T, db *Store, workspaceID, chatID, text string) store.ChatQueue {
	t.Helper()
	queue, err := db.EnqueueChatMessage(context.Background(), workspaceID, chatID, "user_a", store.EnqueueChatMessageInput{Text: text})
	if err != nil {
		t.Fatal(err)
	}
	return queue
}

func queueTexts(queue store.ChatQueue) []string {
	texts := []string{}
	for _, item := range queue.Items {
		texts = append(texts, item.Text)
	}
	return texts
}

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func TestChatQueueEditsDeletesAndReordersWithRevisions(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	enqueueForTest(t, db, "ws_q", "chat_q", "one")
	enqueueForTest(t, db, "ws_q", "chat_q", "two")
	queue := enqueueForTest(t, db, "ws_q", "chat_q", "three")
	if !sameStrings(queueTexts(queue), []string{"one", "two", "three"}) || queue.Revision != 3 {
		t.Fatalf("queue = %v rev %d", queueTexts(queue), queue.Revision)
	}
	if _, err := db.EnqueueChatMessage(ctx, "ws_q", "chat_q", "user_a", store.EnqueueChatMessageInput{Text: "  "}); !errors.Is(err, store.ErrInvalidChatQueueMessage) {
		t.Fatalf("empty message = %v", err)
	}
	two := queue.Items[1]

	edited := "two, edited"
	stale := two.Revision - 1
	if _, err := db.EditChatQueueItem(ctx, "ws_q", "chat_q", two.ID, store.EditChatQueueItemInput{Text: &edited, ExpectedRevision: &stale}); !errors.Is(err, store.ErrChatQueueConflict) {
		t.Fatalf("stale edit = %v, want conflict", err)
	}
	queue, err := db.EditChatQueueItem(ctx, "ws_q", "chat_q", two.ID, store.EditChatQueueItemInput{Text: &edited, ExpectedRevision: &two.Revision})
	if err != nil || queue.Items[1].Text != edited || queue.Items[1].Revision != two.Revision+1 {
		t.Fatalf("edit = %+v, %v", queue.Items, err)
	}
	// The same edit made from another tab on the old revision is refused.
	if _, err := db.EditChatQueueItem(ctx, "ws_q", "chat_q", two.ID, store.EditChatQueueItemInput{Text: &edited, ExpectedRevision: &two.Revision}); !errors.Is(err, store.ErrChatQueueConflict) {
		t.Fatalf("second edit on the old revision = %v", err)
	}

	order := []string{queue.Items[2].ID, queue.Items[0].ID, queue.Items[1].ID}
	old := queue.Revision - 1
	if _, err := db.ReorderChatQueue(ctx, "ws_q", "chat_q", store.ReorderChatQueueInput{ItemIDs: order, ExpectedRevision: &old}); !errors.Is(err, store.ErrChatQueueConflict) {
		t.Fatalf("stale reorder = %v", err)
	}
	if _, err := db.ReorderChatQueue(ctx, "ws_q", "chat_q", store.ReorderChatQueueInput{ItemIDs: order[:2], ExpectedRevision: &queue.Revision}); !errors.Is(err, store.ErrChatQueueConflict) {
		t.Fatalf("reorder missing a message = %v", err)
	}
	queue, err = db.ReorderChatQueue(ctx, "ws_q", "chat_q", store.ReorderChatQueueInput{ItemIDs: order, ExpectedRevision: &queue.Revision})
	if err != nil || !sameStrings(queueTexts(queue), []string{"three", "one", edited}) {
		t.Fatalf("reorder = %v, %v", queueTexts(queue), err)
	}

	queue, err = db.DeleteChatQueueItem(ctx, "ws_q", "chat_q", queue.Items[1].ID)
	if err != nil || !sameStrings(queueTexts(queue), []string{"three", edited}) {
		t.Fatalf("delete = %v, %v", queueTexts(queue), err)
	}
	if _, err := db.DeleteChatQueueItem(ctx, "ws_q", "other_chat", queue.Items[0].ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete through another chat = %v", err)
	}
}

func TestChatQueueRefusesChangesOnceAMessageGoesOut(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	queue := enqueueForTest(t, db, "ws_q", "chat_q", "one")
	enqueueForTest(t, db, "ws_q", "chat_q", "two")
	one := queue.Items[0]
	item, claimed, err := db.ClaimChatQueueItem(ctx, "ws_q", "chat_q", one.ID, true)
	if err != nil || item.State != store.ChatQueueStateDispatching || claimed.Items[0].State != store.ChatQueueStateDispatching {
		t.Fatalf("claim = %+v %+v %v", item, claimed.Items, err)
	}
	text := "too late"
	if _, err := db.EditChatQueueItem(ctx, "ws_q", "chat_q", one.ID, store.EditChatQueueItemInput{Text: &text, ExpectedRevision: &item.Revision}); !errors.Is(err, store.ErrChatQueueItemSending) {
		t.Fatalf("edit while sending = %v", err)
	}
	if _, err := db.DeleteChatQueueItem(ctx, "ws_q", "chat_q", one.ID); !errors.Is(err, store.ErrChatQueueItemSending) {
		t.Fatalf("delete while sending = %v", err)
	}
	if _, _, err := db.ClaimChatQueueItem(ctx, "ws_q", "chat_q", claimed.Items[1].ID, false); !errors.Is(err, store.ErrChatQueueBusy) {
		t.Fatalf("second claim while one is sending = %v", err)
	}
	queue, err = db.SettleChatQueueItem(ctx, one.ID, store.ChatQueueStateSent, "sess_x", "")
	if err != nil || !sameStrings(queueTexts(queue), []string{"two"}) {
		t.Fatalf("after send = %v, %v", queueTexts(queue), err)
	}
	if _, err := db.DeleteChatQueueItem(ctx, "ws_q", "chat_q", one.ID); !errors.Is(err, store.ErrChatQueueItemSent) {
		t.Fatalf("delete after send = %v", err)
	}
	if _, _, err := db.ClaimChatQueueItem(ctx, "ws_q", "chat_q", one.ID, false); !errors.Is(err, store.ErrChatQueueItemSent) {
		t.Fatalf("claim after send = %v", err)
	}

	// A failed next message holds the queue until it is retried.
	two := queue.Items[0]
	enqueueForTest(t, db, "ws_q", "chat_q", "three")
	if _, _, err := db.ClaimChatQueueItem(ctx, "ws_q", "chat_q", two.ID, true); err != nil {
		t.Fatal(err)
	}
	queue, err = db.SettleChatQueueItem(ctx, two.ID, store.ChatQueueStateFailed, "", "device said no")
	if err != nil || queue.Items[0].State != store.ChatQueueStateFailed || queue.Items[0].Error != "device said no" {
		t.Fatalf("failed = %+v, %v", queue.Items, err)
	}
	if _, _, err := db.ClaimChatQueueItem(ctx, "ws_q", "chat_q", two.ID, true); !errors.Is(err, store.ErrChatQueuePaused) {
		t.Fatalf("claim of a failed head = %v", err)
	}
	if _, _, err := db.ClaimChatQueueItem(ctx, "ws_q", "chat_q", queue.Items[1].ID, true); !errors.Is(err, store.ErrChatQueueConflict) {
		t.Fatalf("claim past a failed head = %v", err)
	}
	queue, err = db.RetryChatQueueItem(ctx, "ws_q", "chat_q", two.ID)
	if err != nil || queue.Items[0].ID != two.ID || queue.Items[0].State != store.ChatQueueStateQueued || queue.Items[0].Error != "" {
		t.Fatalf("retry = %+v, %v", queue.Items, err)
	}
}

func TestChatQueueClaimIsExclusive(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	queue := enqueueForTest(t, db, "ws_q", "chat_q", "one")
	enqueueForTest(t, db, "ws_q", "chat_q", "two")
	var wins, losses int
	var mu sync.Mutex
	var group sync.WaitGroup
	for range 8 {
		group.Add(1)
		go func() {
			defer group.Done()
			_, _, err := db.ClaimChatQueueItem(ctx, "ws_q", "chat_q", queue.Items[0].ID, true)
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				wins++
			} else if errors.Is(err, store.ErrChatQueueBusy) {
				losses++
			} else {
				t.Errorf("claim = %v", err)
			}
		}()
	}
	group.Wait()
	if wins != 1 || losses != 7 {
		t.Fatalf("claims won %d, refused %d; want exactly one", wins, losses)
	}
}

func TestChatQueueRecoveryNeverSendsTwice(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerAgentSessionTestDaemon(t, db, "ws_q", "agent_q")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_q", AgentID: "agent_q", Provider: "codex", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CompleteAgentSession(ctx, session.ID, "answer", "native_q"); err != nil {
		t.Fatal(err)
	}
	queue := enqueueForTest(t, db, "ws_q", session.ID, "reached the session")
	enqueueForTest(t, db, "ws_q", session.ID, "never sent")
	reached := queue.Items[0]
	if _, _, err := db.ClaimChatQueueItem(ctx, "ws_q", session.ID, reached.ID, true); err != nil {
		t.Fatal(err)
	}
	// The server stopped after the session recorded the input, before settling.
	next, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: reached.Text, InputID: reached.ID})
	if err != nil || next.Input.ID != reached.ID {
		t.Fatalf("send with the message's id = %+v, %v", next.Input, err)
	}
	recovered, err := db.RecoverChatQueueDispatches(ctx)
	if err != nil || len(recovered) != 1 || !sameStrings(queueTexts(recovered[0]), []string{"never sent"}) {
		t.Fatalf("recovered = %+v, %v", recovered, err)
	}
	var state, sentTo string
	if err := db.conn().QueryRowContext(ctx, `SELECT state, sent_session_id FROM chat_queue_items WHERE id = ?`, reached.ID).Scan(&state, &sentTo); err != nil || state != "sent" || sentTo != session.ID {
		t.Fatalf("recovered state = %q %q, %v", state, sentTo, err)
	}
	// A repeated send of the same message is refused, never recorded twice.
	if _, err := db.CompleteAgentSession(ctx, session.ID, "second answer", "native_q"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: reached.Text, InputID: reached.ID}); !errors.Is(err, store.ErrSessionInputExists) {
		t.Fatalf("second send of the same message = %v", err)
	}

	// One claimed but never sent goes back to its place.
	waiting := recovered[0].Items[0]
	if _, _, err := db.ClaimChatQueueItem(ctx, "ws_q", session.ID, waiting.ID, true); err != nil {
		t.Fatal(err)
	}
	recovered, err = db.RecoverChatQueueDispatches(ctx)
	if err != nil || len(recovered) != 1 || recovered[0].Items[0].State != store.ChatQueueStateQueued {
		t.Fatalf("recovered unsent = %+v, %v", recovered, err)
	}
}

func TestChatQueueFollowsAnAdoptedNativeChat(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	registerTwoRuntimes(t, db, "ws_adopt")
	native := store.ChatThread{ID: "native_claude_q", Provider: "claude", NativeSessionID: "q", Title: "Terminal", UpdatedAt: "2026-10-09T01:00:00Z",
		Transcript: []store.TranscriptMessage{{ID: "u:0", Kind: "user", Text: "hi"}, {ID: "a:0", Kind: "assistant", Text: "hello"}}}
	if err := db.SyncChats(ctx, store.SyncChatsInput{WorkspaceID: "ws_adopt", Chats: []store.ChatThread{native}}); err != nil {
		t.Fatal(err)
	}
	before := enqueueForTest(t, db, "ws_adopt", native.ID, "queued in the native chat")
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_adopt", AgentID: "agent_claude", Provider: "claude", Prompt: "continue", ChatID: native.ID})
	if err != nil {
		t.Fatal(err)
	}
	moved, err := db.ChatQueue(ctx, "ws_adopt", session.ID)
	if err != nil || !sameStrings(queueTexts(moved), []string{"queued in the native chat"}) || moved.Revision <= before.Revision {
		t.Fatalf("session queue = %+v, %v; want the native chat's, at a newer revision", moved, err)
	}
	if left, _ := db.ChatQueue(ctx, "ws_adopt", native.ID); len(left.Items) != 0 {
		t.Fatalf("native chat kept %v", queueTexts(left))
	}
	found, ok, active, err := db.ChatQueueSession(ctx, "ws_adopt", session.ID)
	if err != nil || !ok || !active || found.ID != session.ID {
		t.Fatalf("chat session = %s %v %v %v", found.ID, ok, active, err)
	}
}
