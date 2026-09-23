package sqlitestore

import (
	"context"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestStatusQuestionPersistsWithoutExecutionOrContractChange(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "status_chat", SourceInput: "hi", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		got, err := db.RecordIssueStatusQuestion(ctx, issue.ID, "这里是什么状态？", "same-question")
		if err != nil {
			t.Fatal(err)
		}
		if len(got.Messages) != 2 || got.Run != nil || got.CurrentContractRevision != nil ||
			got.Status != issue.Status || *got.DraftContractRevision != *issue.DraftContractRevision {
			t.Fatalf("status query changed lifecycle or duplicated: %+v", got)
		}
		if !strings.Contains(got.Messages[1].Text, "不会开始") {
			t.Fatal("missing explanation")
		}
	}
	if _, err := db.RecordIssueStatusQuestion(ctx, issue.ID, "different", "same-question"); err == nil {
		t.Fatal("same idempotency key accepted different message")
	}
}
