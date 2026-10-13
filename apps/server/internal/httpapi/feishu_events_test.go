package httpapi

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents"
	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents/feishueventstest"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// An agent session receives the events of the Feishu app its person
// connected in Connectors through feishu_events: subscribe (filtered),
// read with a wait, unsubscribe. Nobody else reads its subscription, and a
// person who connected no app gets nothing.
func TestFeishuEventsToolServesConnectedApps(t *testing.T) {
	f := newExternalAccountsFixture(t)
	f.connect(f.alice, f.createApp(f.alice, ""))
	source := feishueventstest.NewFakeSource("cli_fake", "secret_fake")
	t.Cleanup(source.Close)
	f.server.feishuEvents.Domain = source.URL()
	t.Cleanup(f.server.feishuEvents.Stop)
	ctx := context.Background()
	sessionToken := func(owner, workspace, agent string) string {
		t.Helper()
		session, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
			CreatedByUserID: owner, WorkspaceID: workspace, AgentID: agent, Provider: "claude", Prompt: "watch the group", Source: "chat",
		})
		if err != nil {
			t.Fatal(err)
		}
		token, err := f.db.MintAgentSessionToken(ctx, session.ID)
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	aliceToken := sessionToken(f.aliceID, "ws_alice", "agent_alice")
	if names := mcpToolNames(t, f.handler, aliceToken); !slices.Contains(names, "feishu_events") {
		t.Fatalf("a chat's tools %v lack feishu_events", names)
	}
	call := mcpToolCaller(t, f.handler, aliceToken)
	read := func(text string, isError bool) feishuevents.Batch {
		t.Helper()
		var batch feishuevents.Batch
		if isError || json.Unmarshal([]byte(text), &batch) != nil {
			t.Fatalf("feishu_events answered %q", text)
		}
		return batch
	}

	subscribed := read(call("feishu_events", map[string]any{"eventTypes": []string{"im.message.receive_v1"}, "chatId": "oc_1"}))
	if !strings.HasPrefix(subscribed.SubscriptionID, "fsub_") || subscribed.AppID != "cli_fake" || len(subscribed.Events) != 0 {
		t.Fatalf("subscribing answered %+v", subscribed)
	}
	if !source.WaitOpen(1, 5*time.Second) {
		t.Fatal("subscribing did not connect the app")
	}
	go func() {
		time.Sleep(100 * time.Millisecond)
		_, _ = source.Push(feishueventstest.MessagePayload("cli_fake", "ev_other_chat", "oc_2", "om_0", "", "not here", false), 1)
		_, _ = source.Push(feishueventstest.MessagePayload("cli_fake", "ev_1", "oc_1", "om_1", "", "deploy please", true), 1)
	}()
	batch := read(call("feishu_events", map[string]any{"subscriptionId": subscribed.SubscriptionID, "timeoutMs": 5000}))
	if len(batch.Events) != 1 || batch.Events[0].ID != "ev_1" || batch.Events[0].ChatID != "oc_1" || batch.Cursor != 1 ||
		batch.Connection != "connected" || !strings.Contains(string(batch.Events[0].Payload), "deploy please") {
		t.Fatalf("reading answered %+v", batch)
	}
	if again := read(call("feishu_events", map[string]any{"subscriptionId": subscribed.SubscriptionID, "timeoutMs": 0})); len(again.Events) != 0 || again.Cursor != 1 {
		t.Fatalf("a second read answered %+v", again)
	}

	bobCall := mcpToolCaller(t, f.handler, sessionToken(f.bobID, "ws_bob", "agent_bob"))
	if text, isError := bobCall("feishu_events", map[string]any{"subscriptionId": subscribed.SubscriptionID, "timeoutMs": 0}); !isError || !strings.Contains(text, "no such Feishu event subscription") {
		t.Fatalf("bob read alice's subscription: %q", text)
	}
	if text, isError := bobCall("feishu_events", map[string]any{"appId": "cli_fake"}); !isError || !strings.Contains(text, "connect one in Connectors") {
		t.Fatalf("bob subscribed to alice's app: %q", text)
	}

	if text, isError := call("feishu_events", map[string]any{"subscriptionId": subscribed.SubscriptionID, "unsubscribe": true}); isError || !strings.Contains(text, `"unsubscribed": true`) {
		t.Fatalf("unsubscribing answered %q", text)
	}
	if !source.WaitOpen(0, 5*time.Second) {
		t.Fatal("the app's connection outlived its last subscription")
	}
}
