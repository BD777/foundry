package httpapi

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The channel's own-write set is what the gateway recorded for its source
// account, read by kind and time (600 later gateway events of other kinds do
// not push it out, an old write or another account's write does not leak in),
// and only from sessions that work for the channel's assistant (DEV-243): its
// channel sessions, its home conversation and the helpers those started. A
// write by another session of the same account (the E2E sender's shape) must
// stay deliverable.
func TestMessageChannelOwnWritesFollowTheAssistantsSessions(t *testing.T) {
	f := newChannelSessionFixture(t)
	ctx := context.Background()
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
	// A session of the same person, in a workspace the assistant may reach,
	// that the assistant neither owns nor started.
	unrelated, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Prompt: "post /ai", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	accountID := f.channel.Source.AccountID
	record := func(accountID, messageID, sessionID, at string) {
		t.Helper()
		if err := f.db.AppendExternalAccountEvent(ctx, store.ExternalAccountEvent{
			AccountID: accountID, Kind: connectors.ExtensionWriteCreatedMessage, SessionID: sessionID, CreatedAt: at,
			Detail: fmt.Sprintf(`{"messageId":%q,"method":"POST","route":"/agent/v1/messages/:messageId/replies"}`, messageID),
		}); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC()
	record(accountID, "om_home", f.session.ID, now.Format(time.RFC3339Nano))
	record(accountID, "om_helper", f.helper.ID, now.Format(time.RFC3339Nano))
	record(accountID, "om_channel", channelSession.ID, now.Format(time.RFC3339Nano))
	record(accountID, "om_unrelated", unrelated.ID, now.Format(time.RFC3339Nano))
	record(accountID, "om_old", f.session.ID, now.Add(-49*time.Hour).Format(time.RFC3339Nano))
	record("xacc_someone_else", "om_other_account", f.session.ID, now.Format(time.RFC3339Nano))
	for i := 0; i < 600; i++ {
		if err := f.db.AppendExternalAccountEvent(ctx, store.ExternalAccountEvent{
			AccountID: accountID, Kind: "extension_connector_request",
			Detail: fmt.Sprintf(`{"method":"GET","route":"/changes/%d"}`, i),
		}); err != nil {
			t.Fatal(err)
		}
	}

	own, err := f.server.messageChannelOwnWrites(ctx, f.channel)
	if err != nil {
		t.Fatal(err)
	}
	for _, messageID := range []string{"om_home", "om_helper", "om_channel"} {
		if !own[messageID] {
			t.Fatalf("%s is the assistant's own write: %v", messageID, own)
		}
	}
	for _, messageID := range []string{"om_unrelated", "om_old", "om_other_account"} {
		if own[messageID] {
			t.Fatalf("%s is not the assistant's own write: %v", messageID, own)
		}
	}
}
