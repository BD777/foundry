package sqlitestore

import (
	"context"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func TestIssueRuntimeOptionsPersistThroughFeedback(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	for _, runtime := range []string{"claude", "codex"} {
		input := store.CreateIssueInput{Runtime: runtime, SourceInput: "configured task", Model: "chosen-model", ProfileID: "chosen-profile"}
		if runtime == "claude" {
			input.ClaudeEffort = "max"
		} else {
			input.CodexReasoningEffort = "xhigh"
			input.CodexSpeed = "fast"
		}
		issue, err := db.CreateIssue(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.UpdateIssueStatus(ctx, issue.ID, "verifying"); err != nil {
			t.Fatal(err)
		}
		if _, err = db.RequestIssueChanges(ctx, issue.ID, "continue with these settings", ""); err != nil {
			t.Fatal(err)
		}
		loaded, err := db.GetIssue(ctx, issue.ID)
		if err != nil {
			t.Fatal(err)
		}
		if loaded.Model != input.Model || loaded.ProfileID != input.ProfileID || loaded.ClaudeEffort != input.ClaudeEffort || loaded.CodexReasoningEffort != input.CodexReasoningEffort || loaded.CodexSpeed != input.CodexSpeed || loaded.Status != "pending" {
			t.Fatalf("options lost: %+v", loaded)
		}
	}
	for _, input := range []store.CreateIssueInput{
		{Runtime: "claude", ClaudeEffort: "bogus"},
		{Runtime: "codex", CodexReasoningEffort: "max"},
		{Runtime: "codex", ClaudeEffort: "high"},
		{Runtime: "codex", CodexSpeed: "invalid"},
		{Model: "invalid\nmodel"},
	} {
		if _, err := db.CreateIssue(ctx, input); err == nil {
			t.Fatalf("accepted invalid settings: %+v", input)
		}
	}
}
