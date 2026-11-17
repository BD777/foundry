package sqlitestore

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestChatQueueKeepsAnnotationsThroughEnqueueEditAndRead(t *testing.T) {
	ctx := context.Background()
	db := newTestStore(t)
	annotations := []store.SessionInputAnnotation{{ID: "ann_1", SelectedText: "passage", Comment: "note", SourceEventID: "evt_answer", TurnNumber: 4, MessageAt: "2026-11-17T01:00:00Z"}}
	queue, err := db.EnqueueChatMessage(ctx, "ws_a", "chat_a", "user_a", store.EnqueueChatMessageInput{Text: "wrapped prompt", Annotations: annotations})
	if err != nil {
		t.Fatal(err)
	}
	item := queue.Items[0]
	if len(item.Annotations) != 1 || item.Annotations[0] != annotations[0] {
		t.Fatalf("enqueued annotations = %+v", item.Annotations)
	}

	edited := []store.SessionInputAnnotation{}
	queue, err = db.EditChatQueueItem(ctx, "ws_a", "chat_a", item.ID, store.EditChatQueueItemInput{Annotations: &edited, ExpectedRevision: &item.Revision})
	if err != nil {
		t.Fatal(err)
	}
	if queue.Items[0].Annotations != nil {
		t.Fatalf("cleared annotations = %+v, want none", queue.Items[0].Annotations)
	}
}

func TestChatQueueAnnotationsColumnMigrationIsIdempotent(t *testing.T) {
	db := newTestStore(t)
	for range 2 {
		if err := db.addChatQueueAnnotationsColumn(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
}
