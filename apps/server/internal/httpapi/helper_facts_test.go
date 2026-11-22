package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// helperFixture is alice's assistant, whose package reaches only ws_alice,
// its conversation in ws_pa, and a helper it started in ws_alice.
type helperFixture struct {
	reachFixture
	conversation, helper store.AgentSession
}

func newHelperFixture(t *testing.T, said string) helperFixture {
	t.Helper()
	f := helperFixture{reachFixture: newReachFixture(t)}
	ctx := context.Background()
	if err := f.db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_alice", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_pa", Name: "Assistant", LocalPath: "/tmp/ws_pa"},
		Agents: []store.AgentProjection{{
			ID: "agent_pa", WorkspaceID: "ws_pa", DeviceID: "dev_alice", Provider: "claude", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.server.store.SetWorkspaceKind(ctx, "ws_pa", store.WorkspaceKindPersonalAgent); err != nil {
		t.Fatal(err)
	}
	agent, err := f.server.store.CreatePersonalAgent(ctx, store.PersonalAgent{UserID: f.aliceID, WorkspaceID: "ws_pa", HomeDeviceID: "dev_alice"})
	if err != nil {
		t.Fatal(err)
	}
	pkg, err := f.server.store.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil {
		t.Fatal(err)
	}
	pkg.Workspaces = store.PermissionListRule{Scope: store.PermissionListScopeListed, Include: []string{"ws_alice"}}
	if _, err := f.server.store.SavePermissionPackage(ctx, pkg); err != nil {
		t.Fatal(err)
	}
	if f.conversation, err = f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Provider: "claude", Prompt: said, Source: store.SessionSourceChat,
	}); err != nil {
		t.Fatal(err)
	}
	if f.helper, err = f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Prompt: "rerun the cases",
		Source: store.SessionSourceAgent, ParentSessionID: f.conversation.ID,
	}); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f helperFixture) caller(t *testing.T, session store.AgentSession) func(string, any) (string, bool) {
	t.Helper()
	token, err := f.db.MintAgentSessionToken(context.Background(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	return mcpToolCaller(t, f.handler, token)
}

// A helper reads the conversation that started it, and that one's own
// parent, though its assistant's package does not reach their workspace
// (2026-11-19: read_context on the parent was refused). The rest of that
// workspace stays out of its reach.
func TestHelperReadsItsOwnParentChain(t *testing.T) {
	f := newHelperFixture(t, "rerun the cases from the day before yesterday")
	ctx := context.Background()
	other, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_pa", AgentID: "agent_pa", Provider: "claude", Prompt: "another conversation", Source: store.SessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	grandchild, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Prompt: "one case",
		Source: store.SessionSourceAgent, ParentSessionID: f.helper.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	bobs, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.bobID, WorkspaceID: "ws_bob", AgentID: "agent_bob", Provider: "claude", Prompt: "bob's", Source: store.SessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	bobsChild, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Prompt: "under bob's",
		Source: store.SessionSourceAgent, ParentSessionID: bobs.ID,
	})
	if err != nil {
		t.Fatal(err)
	}

	call := f.caller(t, f.helper)
	if text, failed := call("read_context", map[string]any{"sessionId": f.conversation.ID}); failed || !strings.Contains(text, "rerun the cases from the day before yesterday") {
		t.Fatalf("helper reads its parent = %v %s", failed, text)
	}
	if text, failed := call("read_context", map[string]any{"sessionId": other.ID}); !failed || !strings.Contains(text, "that you can read") {
		t.Fatalf("helper reads another conversation of its package's excluded workspace = %v %s", failed, text)
	}
	if text, failed := f.caller(t, grandchild)("read_context", map[string]any{"sessionId": f.conversation.ID}); failed || !strings.Contains(text, f.conversation.ID) {
		t.Fatalf("grandchild reads its grandparent = %v %s", failed, text)
	}
	// Lineage reaches only the sessions the same person started.
	if text, failed := f.caller(t, bobsChild)("read_context", map[string]any{"sessionId": bobs.ID}); !failed {
		t.Fatalf("a session reads a parent another person started = %s", text)
	}
	// Reading is all lineage grants: the parent is not the helper's to stop.
	if text, failed := call("cancel_session", map[string]any{"sessionId": f.conversation.ID}); !failed {
		t.Fatalf("helper cancels its parent outside its reach = %s", text)
	}
}

// personQuote: words found in one of the person's own messages in the
// sender's conversation travel with the message as a checked fact (who,
// when, where, the words); other words refuse the call.
func TestPersonQuoteTravelsAsACheckedFact(t *testing.T) {
	f := newHelperFixture(t, "approve上面的mr，然后合入")
	ctx := context.Background()
	workspaceChat, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude",
		Prompt: "Go ahead and deploy the fix to dev.", Source: store.SessionSourceChat,
	})
	if err != nil {
		t.Fatal(err)
	}
	call := f.caller(t, workspaceChat)

	if text, failed := call("create_session", map[string]any{"prompt": "deploy it", "personQuote": "deploy everything to production"}); !failed || !strings.Contains(text, "personQuote is not in any one of the person's own messages") {
		t.Fatalf("an ungrounded quote = %v %s", failed, text)
	}
	text, failed := call("create_session", map[string]any{"prompt": "Deploy the fix.", "personQuote": "deploy the fix to dev"})
	if failed {
		t.Fatalf("create_session with a grounded quote: %s", text)
	}
	created := createdSessionID(t, text)
	child, err := f.server.store.GetAgentSessionRecord(ctx, created)
	if err != nil {
		t.Fatal(err)
	}
	at, _ := time.Parse(time.RFC3339Nano, workspaceChat.Input.At)
	for _, want := range []string{"Deploy the fix.\n\n" + personQuoteHeading, "wrote this at " + at.UTC().Format(time.RFC3339), "in their own message in session " + workspaceChat.ID, "> deploy the fix to dev"} {
		if !strings.Contains(child.Input.Prompt, want) {
			t.Fatalf("helper's first message lacks %q:\n%s", want, child.Input.Prompt)
		}
	}

	// send_message carries it the same way.
	if text, failed := call("send_message", map[string]any{"sessionId": created, "prompt": "Also run the smoke test.", "personQuote": "Go ahead and deploy"}); failed {
		t.Fatalf("send_message with a grounded quote: %s", text)
	}
	if !messageReached(t, f.server.store, created, "Also run the smoke test.\n\n"+personQuoteHeading, "> Go ahead and deploy") {
		t.Fatal("send_message's quote did not reach the helper")
	}
	if text, failed := call("send_message", map[string]any{"sessionId": created, "prompt": "Ship it.", "personQuote": "ship it"}); !failed || !strings.Contains(text, "personQuote is not in") {
		t.Fatalf("send_message with an ungrounded quote = %v %s", failed, text)
	}

	// A helper's own conversation holds no words of the person's.
	if text, failed := f.caller(t, f.helper)("create_session", map[string]any{"prompt": "merge", "personQuote": "approve上面的mr"}); !failed || !strings.Contains(text, "personQuote is not in") {
		t.Fatalf("a helper passing on its parent's words = %v %s", failed, text)
	}

	// dispatch_item checks it before the step is captured.
	assistant := f.caller(t, f.conversation)
	if text, failed := assistant("dispatch_item", map[string]any{"itemId": "pai_missing", "intentRevision": 1, "stepKey": "s1", "workspaceId": "ws_alice", "prompt": "merge", "personQuote": "merge everything"}); !failed || !strings.Contains(text, "personQuote is not in") {
		t.Fatalf("dispatch_item with an ungrounded quote = %v %s", failed, text)
	}
	if text, failed := assistant("dispatch_item", map[string]any{"itemId": "pai_missing", "intentRevision": 1, "stepKey": "s1", "workspaceId": "ws_alice", "prompt": "merge", "personQuote": "approve上面的mr"}); !failed || strings.Contains(text, "personQuote") {
		t.Fatalf("dispatch_item with a grounded quote fails on the missing item, not the quote = %v %s", failed, text)
	}
}

func createdSessionID(t *testing.T, answer string) string {
	t.Helper()
	_, rest, found := strings.Cut(answer, `"id": "`)
	if !found {
		_, rest, found = strings.Cut(answer, `"id":"`)
	}
	id, _, _ := strings.Cut(rest, `"`)
	if !found || !strings.HasPrefix(id, "sess_") {
		t.Fatalf("no session id in %s", answer)
	}
	return id
}

// messageReached reports whether a message holding every part reached the
// session: in its inbox or as its input.
func messageReached(t *testing.T, db Backend, sessionID string, parts ...string) bool {
	t.Helper()
	ctx := context.Background()
	holds := func(text string) bool {
		for _, part := range parts {
			if !strings.Contains(text, part) {
				return false
			}
		}
		return true
	}
	items, err := db.SessionInboxItems(ctx, sessionID, time.Now().Add(-time.Hour), 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		if holds(item.Prompt) {
			return true
		}
	}
	session, err := db.GetAgentSessionRecord(ctx, sessionID)
	return err == nil && holds(session.Input.Prompt)
}
