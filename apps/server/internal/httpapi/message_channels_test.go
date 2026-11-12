package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// channelSessionFixture is the needs-you fixture plus a message channel of
// the default assistant whose message went to a session in its home, and a
// helper that session started.
type channelSessionFixture struct {
	needsYouFixture
	agent   store.PersonalAgent
	channel store.MessageChannelRecord
	session store.AgentSession
	helper  store.AgentSession
	token   string
}

func newChannelSessionFixture(t *testing.T) channelSessionFixture {
	t.Helper()
	f := channelSessionFixture{needsYouFixture: newNeedsYouFixture(t)}
	ctx := context.Background()
	f.agent = defaultAssistantOf(t, f.server, f.aliceID)
	var err error
	f.session, err = f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: f.agent.WorkspaceID, AgentID: "agent_pa", Prompt: "[Message channel …]", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	f.helper, err = f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_budget", AgentID: "agent_budget", Prompt: "fix it", Source: "agent", ParentSessionID: f.session.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.channel = store.MessageChannelRecord{UserID: f.aliceID, MessageChannel: store.MessageChannel{
		ID: "mch_t1", AssistantID: f.agent.ID, Name: "Lark /fd", Enabled: true, SessionKey: "conversation",
		Source: store.MessageChannelSource{Kind: "openlark", AccountID: "xacc_lark"},
		Scope: store.MessageChannelScope{ConnectorDefault: "off",
			Connectors: []store.MessageChannelConnectorScope{{AccountID: "xacc_lark", Level: "write", Writes: "direct"}, {AccountID: "xacc_gh", Level: "read", Writes: "confirm"}},
			Workspaces: store.PermissionListRule{Scope: store.PermissionListScopeListed, Include: []string{"ws_budget"}}},
		Limits: store.MessageChannelLimits{PerHour: 20, PerDay: 100, Concurrency: 3}, CreatedAt: "2026-11-13T00:00:00Z", UpdatedAt: "2026-11-13T00:00:00Z",
	}}
	if err := f.db.SaveMessageChannel(ctx, f.channel); err != nil {
		t.Fatal(err)
	}
	record := store.MessageChannelDeliveryRecord{UserID: f.aliceID, AssistantID: f.agent.ID, SessionKey: "c:oc_1"}
	record.ID, record.ChannelID, record.Status, record.CreatedAt = "dlv_1", f.channel.ID, store.MessageDeliveryQueued, "2026-01-01T00:00:00Z"
	record.Envelope = store.MessageEnvelope{ID: "new:1", Kind: "message", Op: "new", MessageID: "1", Text: "/fd hi",
		Conversation: store.MessageEnvelopeConversation{ID: "oc_1", Kind: "direct"}, Sender: store.MessageEnvelopeSender{ID: "ou_1"}}
	if _, err := f.db.RecordMessageChannelBatch(ctx, f.channel.ID, []store.MessageChannelDeliveryRecord{record}, "c1"); err != nil {
		t.Fatal(err)
	}
	record.Status, record.SessionID, record.DeliveredAt = store.MessageDeliveryDelivered, f.session.ID, "2026-01-01T00:00:05Z"
	if err := f.db.SaveMessageChannelDelivery(ctx, record); err != nil {
		t.Fatal(err)
	}
	f.token, err = f.db.MintAgentSessionToken(ctx, f.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// What a channel's session and its helpers may use is the channel's scope
// within the assistant's package; writes the person set to direct need no
// card, the others still do.
func TestMessageChannelSessionsAreNarrowedToTheChannelScope(t *testing.T) {
	f := newChannelSessionFixture(t)
	ctx := context.Background()
	for _, session := range []store.AgentSession{f.session, f.helper} {
		access, err := permission.Resolve(ctx, f.db, session)
		if err != nil || !access.Applicable || access.Channel == nil || access.Channel.ID != f.channel.ID {
			t.Fatalf("%s: access %+v (%v)", session.ID, access, err)
		}
		if access.ConnectorLevel("xacc_lark") != store.ConnectorAccessLevelWrite || !access.WritesWithoutConfirmation("xacc_lark") {
			t.Fatalf("%s: the source account writes directly", session.ID)
		}
		if access.ConnectorLevel("xacc_gh") != store.ConnectorAccessLevelRead || access.WritesWithoutConfirmation("xacc_gh") {
			t.Fatalf("%s: a read account stays read", session.ID)
		}
		if access.ConnectorLevel("xacc_other") != store.ConnectorAccessLevelOff {
			t.Fatalf("%s: unlisted accounts are off", session.ID)
		}
		if !access.WorkspaceAllowed("ws_budget") || access.WorkspaceAllowed("ws_other") {
			t.Fatalf("%s: workspaces follow the channel", session.ID)
		}
		if !access.IdentityResourceListed() || access.IdentityResourceAllowed("res_browser") {
			t.Fatalf("%s: no signed-in resources", session.ID)
		}
	}
	// The person's own conversation keeps the package.
	access, err := permission.Resolve(ctx, f.db, f.conversation)
	if err != nil || access.Channel != nil || access.ConnectorLevel("xacc_other") != store.ConnectorAccessLevelWrite || access.WritesWithoutConfirmation("xacc_lark") {
		t.Fatalf("own conversation: %+v (%v)", access, err)
	}
	// The package still caps the channel.
	pkg, _ := f.db.GetPermissionPackage(ctx, f.aliceID, f.agent.PermissionPackageID)
	pkg.ConnectorAccounts = []store.ConnectorAccountPermission{{AccountID: "xacc_lark", Level: store.ConnectorAccessLevelRead}}
	if _, err := f.db.SavePermissionPackage(ctx, pkg); err != nil {
		t.Fatal(err)
	}
	access, _ = permission.Resolve(ctx, f.db, f.session)
	if access.ConnectorLevel("xacc_lark") != store.ConnectorAccessLevelRead || access.WritesWithoutConfirmation("xacc_lark") {
		t.Fatal("the package caps the channel's level")
	}
}

// A channel's session belongs to the assistant itself: what it hands over
// goes straight to the person, with its note.
func TestMessageChannelSessionHandsOverToThePerson(t *testing.T) {
	f := newChannelSessionFixture(t)
	f.needsYouFixture.token = f.token
	text, failed := f.needsYou(t, map[string]any{"op": "hand_over", "sessionId": f.session.ID, "note": "张三问能否今天合并 MR；草稿：今天下午合并。"})
	if failed {
		t.Fatalf("hand_over: %s", text)
	}
	var answer struct {
		HandedOver []needsYouLine `json:"handedOver"`
	}
	if err := json.Unmarshal([]byte(text), &answer); err != nil || len(answer.HandedOver) != 1 {
		t.Fatalf("answer: %s", text)
	}
	item, err := f.db.GetPendingItem(context.Background(), f.aliceID, answer.HandedOver[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if store.PendingHandledBy(item) != store.PendingHandlerPerson || item.SessionID != f.session.ID || !strings.Contains(item.Note, "草稿") {
		t.Fatalf("item: %+v", item)
	}
	// Another session of the home is not a channel session.
	f.needsYouFixture.token = f.token
	if text, failed := f.needsYou(t, map[string]any{"op": "hand_over", "sessionId": f.chat.ID, "note": "x"}); !failed {
		t.Fatalf("a session outside the assistant's reach: %s", text)
	}
	// The deliveries list shows the hand-over as the session's action.
	actions := f.server.messageChannelActions(context.Background(), f.agent, f.channel, f.mustDeliveries(t))
	if got := actions["dlv_1"]; len(got) != 1 || got[0].Kind != "needs_you" {
		t.Fatalf("actions: %+v", actions)
	}
}

func (f channelSessionFixture) mustDeliveries(t *testing.T) []store.MessageChannelDeliveryRecord {
	t.Helper()
	records, err := f.db.ListMessageChannelDeliveries(context.Background(), f.channel.ID, nil, 50)
	if err != nil {
		t.Fatal(err)
	}
	return records
}

// The person's own messages to the assistant never wait behind a channel's
// conversation, and two channel conversations do not wait for each other.
func TestChannelInboxEntriesDoNotHoldThePersonsMessages(t *testing.T) {
	f := newChannelSessionFixture(t)
	ctx := context.Background()
	capture := func(channel, message string) store.PersonalAgentInboxEntry {
		entry, err := f.server.assistant.CaptureInbox(ctx, f.agent, channel, store.PersonalAgentInboxCapture{MessageID: message, Text: "hello " + message})
		if err != nil {
			t.Fatalf("capture %s: %v", channel, err)
		}
		return entry
	}
	first := capture("mc:mch_t1:aaaa", "m1")
	second := capture("mc:mch_t1:bbbb", "m2")
	web := capture("web", "w1")
	due, err := f.db.DuePersonalAgentInbox(ctx, "9999-01-01T00:00:00Z", 20)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, entry := range due {
		ids[entry.ID] = true
	}
	if !ids[first.ID] || !ids[second.ID] || !ids[web.ID] {
		t.Fatalf("due: %+v", due)
	}
	list, err := f.db.ListPersonalAgentInbox(ctx, f.agent.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range list {
		if strings.HasPrefix(entry.Channel, "mc:") {
			t.Fatal("the person's inbox list leaves channel entries out")
		}
	}
}
