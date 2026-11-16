package httpapi

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The AI footer goes on writes by sessions that work for the channel's
// assistant (its home conversation, its channel sessions and their helpers),
// never on another session of the same account, another account, or a
// channel that turned its footer off.
func TestMessageChannelWriteFooterOnlyForItsAssistantsSessions(t *testing.T) {
	f := newChannelSessionFixture(t)
	ctx := context.Background()
	accountID := f.channel.Source.AccountID
	for _, sessionID := range []string{f.session.ID, f.helper.ID} {
		if line, ok := f.server.messageChannelWriteFooter(ctx, accountID, sessionID); !ok || line != "> 来自AI" {
			t.Fatalf("%s: footer %q (%v)", sessionID, line, ok)
		}
	}
	channelSession, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Prompt: "[Message channel …]", Source: "chat",
		WorkspaceAccess: store.SessionWorkspaceAccessRead,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.db.RecordMessageChannelSession(ctx, store.MessageChannelSession{
		SessionID: channelSession.ID, ChannelID: f.channel.ID, AssistantID: f.agent.ID, SessionKey: "c:oc_1",
	}); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.server.messageChannelWriteFooter(ctx, accountID, channelSession.ID); !ok {
		t.Fatal("a channel session gets the footer")
	}
	unrelated, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Prompt: "post /ai", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if line, ok := f.server.messageChannelWriteFooter(ctx, accountID, unrelated.ID); ok {
		t.Fatalf("an unrelated session gets no footer: %q", line)
	}
	if line, ok := f.server.messageChannelWriteFooter(ctx, "xacc_someone_else", f.session.ID); ok {
		t.Fatalf("another account gets no footer: %q", line)
	}

	custom := "  -- AI  "
	f.channel.Footer = &custom
	if err := f.db.SaveMessageChannel(ctx, f.channel); err != nil {
		t.Fatal(err)
	}
	if line, ok := f.server.messageChannelWriteFooter(ctx, accountID, f.session.ID); !ok || line != "-- AI" {
		t.Fatalf("the person's footer: %q (%v)", line, ok)
	}
	empty := ""
	f.channel.Footer = &empty
	if err := f.db.SaveMessageChannel(ctx, f.channel); err != nil {
		t.Fatal(err)
	}
	if line, ok := f.server.messageChannelWriteFooter(ctx, accountID, f.session.ID); !ok || line != "" {
		t.Fatalf("an empty footer turns it off: %q (%v)", line, ok)
	}
}
