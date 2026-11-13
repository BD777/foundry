package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The assistant home's needs-you rows carry what the needs-you page needs
// to say what is wanted (an account item's source, rule and missing
// scopes, not just the account's name as its title) and where each came
// from in names, never ids: a chat whose title quotes session ids, the
// assistant's helper, a personal account item.
func TestNeedsYouCardRowsSayWhatAndWhereWithoutIDs(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	pasted, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Source: "chat",
		Prompt: "sess_1793189579694075630 sess_1793262362249887906 这两个session以及他们的sub 看一下",
	})
	if err != nil {
		t.Fatal(err)
	}
	record := func(item store.PendingItem) {
		t.Helper()
		item.UserID, item.Handler = f.aliceID, store.PendingHandlerPerson
		if item.Excerpt == "" {
			item.Excerpt = item.Title
		}
		if _, _, err := f.db.RecordPendingItem(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	record(store.PendingItem{
		Source: store.PendingSourceAccount, Rule: "feishu", Key: "account-scopes:acct_dcw",
		EventID: "account-scopes:acct_dcw|feishu-cli v1.44.0", Title: "邓灿文",
		Excerpt: "okr:okr.content:readonly task:comment:read", Context: "feishu-cli v1.44.0",
	})
	time.Sleep(2 * time.Millisecond)
	record(store.PendingItem{
		WorkspaceID: "ws_budget", SessionID: pasted.ID, Source: store.PendingSourceQuestion,
		Key: "question:pasted", Title: "Commit with --no-verify this once?",
	})
	time.Sleep(2 * time.Millisecond)
	record(store.PendingItem{
		AssistantID: agent.ID, WorkspaceID: "ws_budget", SessionID: f.helper.ID, Source: store.PendingSourceQuestion,
		Key: "question:helper", Title: "Which export format?",
	})

	overview, err := f.server.assistant.OverviewOf(ctx, agent)
	if err != nil {
		t.Fatal(err)
	}
	rows := map[string]store.PersonalAgentNeedsYouItem{}
	for _, row := range overview.NeedsYou.Items {
		rows[row.Source+":"+row.Title] = row
	}
	account, ok := rows["account:邓灿文"]
	if !ok || account.Rule != "feishu" || account.Context != "feishu-cli v1.44.0" ||
		!strings.HasPrefix(account.EventID, "account-scopes:") || account.Excerpt == "" ||
		account.From != (store.PersonalAgentNeedsYouFrom{Kind: store.NeedsYouFromPersonal, Name: "feishu"}) {
		t.Fatalf("account row = %+v (rows %+v)", account, overview.NeedsYou.Items)
	}
	chat := rows["question:Commit with --no-verify this once?"]
	if chat.From.Kind != store.NeedsYouFromChat || chat.From.Detail != "Budget" ||
		strings.Contains(chat.From.Name, "sess_") || !strings.Contains(chat.From.Name, "这两个session") {
		t.Fatalf("chat row from = %+v", chat.From)
	}
	helper := rows["question:Which export format?"]
	if helper.From.Kind != store.NeedsYouFromHelper || helper.From.Name == "" || strings.Contains(helper.From.Name, "sess_") {
		t.Fatalf("helper row from = %+v", helper.From)
	}
}

// A saved message whose attempt failed reads why in one plain line: its
// error is classified as a failed turn's is, with the provider's reset.
func TestInboxViewClassifiesTheFailedAttempt(t *testing.T) {
	view := inboxViewOf(store.PersonalAgentInboxEntry{
		UpdatedAt:   "2026-11-13T03:28:00Z",
		ResultError: "API Error: Request rejected (429) · upstream account quota usage limit has been reached; an account becomes available again at 04:02 UTC (in 12h34m)",
	})
	if view.ResultFailure == nil || view.ResultFailure.Category != store.PendingFailureQuotaExhausted || view.ResultFailure.ResetAt == "" {
		t.Fatalf("failure = %+v", view.ResultFailure)
	}
	if clean := inboxViewOf(store.PersonalAgentInboxEntry{UpdatedAt: "2026-11-13T03:28:00Z"}); clean.ResultFailure != nil {
		t.Fatalf("no error, failure = %+v", clean.ResultFailure)
	}
}
