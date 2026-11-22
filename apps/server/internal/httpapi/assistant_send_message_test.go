package httpapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The assistant uses the same send_message as any orchestrator: its
// admission is the generic scope, narrowed for an assistant session to its
// permission package.
func TestAssistantSendMessageStaysInItsScope(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	inScope := f.startSession(t, "ws_alice", "", "existing work")
	if _, err := f.server.store.CompleteAgentSession(ctx, inScope.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	outScope := f.startSession(t, "ws_bob", "", "bob's work")
	if _, err := f.server.store.CompleteAgentSession(ctx, outScope.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	// The person's permission package reaches ws_alice, not ws_bob.
	f.editPackage(t, func(pkg *store.PermissionPackage) {
		pkg.Workspaces = store.PermissionListRule{Scope: store.PermissionListScopeListed, Include: []string{"ws_alice"}}
	})
	for _, delivery := range []string{"boundary", "interrupt", "turn_end"} {
		if text, failed := f.tool(t, f.token, "send_message", map[string]any{"sessionId": inScope.ID, "prompt": "carry on " + delivery, "delivery": delivery}); failed {
			t.Fatalf("in-scope %s send_message refused: %s", delivery, text)
		}
	}
	if text, failed := f.tool(t, f.token, "send_message", map[string]any{"sessionId": outScope.ID, "prompt": "carry on"}); !failed ||
		!strings.Contains(text, "that you can read") {
		t.Fatalf("out-of-scope send_message = %q (failed %v)", text, failed)
	}
}

// The person's assistants hand things over by message (D1): one's home
// conversation reaches another's, outside its own package; a helper and a
// session that is not a home conversation stay refused. Each one's
// instructions name the others, what they are in charge of and that
// conversation.
func TestAssistantsMessageEachOthersConversation(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	settings := personalagent.DefaultSettings()
	settings.Responsibility = "公司的事：公司身份和公司电脑。"
	work, err := f.server.store.CreatePersonalAgent(ctx, store.PersonalAgent{
		UserID: f.aliceID, Name: "ByteWork", WorkspaceID: "ws_alice", HomeDeviceID: "dev_alice", Settings: settings,
	})
	if err != nil {
		t.Fatal(err)
	}
	// The default assistant's package reaches only ws_bob, not ByteWork's home.
	f.editPackage(t, func(pkg *store.PermissionPackage) {
		pkg.Workspaces = store.PermissionListRule{Scope: store.PermissionListScopeListed, Include: []string{"ws_bob"}}
	})
	workConversation := f.startSession(t, "ws_alice", "", "公司的周报")
	if _, err := f.server.store.CompleteAgentSession(ctx, workConversation.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	if text, failed := f.tool(t, f.token, "send_message", map[string]any{"sessionId": workConversation.ID, "prompt": "这件是公司的事，交给你"}); failed {
		t.Fatalf("default → ByteWork conversation refused: %s", text)
	}
	if _, err := f.server.store.CompleteAgentSession(ctx, f.conversation.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	if text, failed := f.tool(t, f.mint(t, workConversation.ID), "send_message", map[string]any{"sessionId": f.conversation.ID, "prompt": "这件是家里的事"}); failed {
		t.Fatalf("ByteWork → default conversation refused: %s", text)
	}

	helper := f.startSession(t, "ws_bob", f.conversation.ID, "a helper")
	if text, failed := f.tool(t, f.mint(t, helper.ID), "send_message", map[string]any{"sessionId": workConversation.ID, "prompt": "hello"}); !failed {
		t.Fatalf("a helper reached the other assistant's conversation: %s", text)
	}
	workHelper := f.startSession(t, "ws_alice", workConversation.ID, "ByteWork's helper")
	if _, err := f.server.store.CompleteAgentSession(ctx, workHelper.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	if text, failed := f.tool(t, f.token, "send_message", map[string]any{"sessionId": workHelper.ID, "prompt": "hello"}); !failed {
		t.Fatalf("the default assistant reached ByteWork's helper: %s", text)
	}

	input, err := f.server.assistant.PromptInput(ctx, defaultAssistantOf(t, f.server, f.aliceID), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(input.OtherAssistants) != 1 || input.OtherAssistants[0].Name != "ByteWork" ||
		input.OtherAssistants[0].Responsibility != settings.Responsibility || input.OtherAssistants[0].ConversationID != workConversation.ID {
		t.Fatalf("the default assistant's other assistants = %+v", input.OtherAssistants)
	}
	input, err = f.server.assistant.PromptInput(ctx, work, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(input.OtherAssistants) != 1 || !input.OtherAssistants[0].Default || input.OtherAssistants[0].ConversationID != f.conversation.ID {
		t.Fatalf("ByteWork's other assistants = %+v", input.OtherAssistants)
	}
}

// A helper reports back to the session that started it, whatever workspace
// that parent runs in; any other session outside its scope stays refused.
func TestHelperSendMessageReachesItsParent(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	// The package reaches ws_alice and the helper's ws_bob, not the parent's ws_pa.
	f.editPackage(t, func(pkg *store.PermissionPackage) {
		pkg.Workspaces = store.PermissionListRule{Scope: store.PermissionListScopeListed, Include: []string{"ws_alice", "ws_bob"}}
	})
	if _, err := f.server.store.CompleteAgentSession(ctx, f.conversation.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	helper := f.startSession(t, "ws_bob", f.conversation.ID, "report back")
	token := f.mint(t, helper.ID)
	if text, failed := f.tool(t, token, "send_message", map[string]any{"sessionId": f.conversation.ID, "prompt": "the evidence"}); failed {
		t.Fatalf("helper → parent refused: %s", text)
	}
	unrelated := f.startSession(t, "ws_pa", "", "unrelated work")
	if _, err := f.server.store.CompleteAgentSession(ctx, unrelated.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	if text, failed := f.tool(t, token, "send_message", map[string]any{"sessionId": unrelated.ID, "prompt": "hello"}); !failed || !strings.Contains(text, "that you can read") {
		t.Fatalf("unrelated send = %q (failed %v)", text, failed)
	}
}

// A helper that ended with a question resumes with the assistant's
// send_message; the prompt arrives in the runtime's reply envelope.
func TestAssistantSendMessageAnswersAWaitingHelper(t *testing.T) {
	f := newNeedsYouFixture(t)
	ctx := context.Background()
	helper := f.helper
	if _, err := f.server.store.StartAgentSession(ctx, helper.ID); err != nil {
		t.Fatal(err)
	}
	question := store.AgentSessionEvent{
		ID: "evt_q", SessionID: helper.ID, At: time.Now().UTC().Format(time.RFC3339Nano),
		Message: &store.TranscriptMessage{
			ID: "toolu_q", Kind: "assistant", Text: "Which format?", Delivery: questionDeliveryNextTurn,
			Questions: []store.AgentQuestion{{Title: "Which format?", Options: []string{"CSV", "XLSX"}}},
		},
	}
	if _, err := f.server.store.RecordAgentSessionEvent(ctx, question); err != nil {
		t.Fatal(err)
	}
	pendingReactions{f.server}.SessionEventRecorded(ctx, question)
	if _, err := f.server.store.CompleteAgentSession(ctx, helper.ID, "Waiting for the format.", "native-helper"); err != nil {
		t.Fatal(err)
	}
	call := mcpToolCaller(t, f.server.Routes(), f.token)
	if text, failed := call("send_message", map[string]any{"sessionId": helper.ID, "prompt": "Use CSV, the person's usual format.", "delivery": "boundary"}); failed {
		t.Fatalf("send_message: %s", text)
	}
	run := f.daemon.nextChatRun()
	if run.Session.ID != helper.ID {
		t.Fatalf("answered %s, want the helper", run.Session.ID)
	}
	input := run.Session.Input.Prompt
	if !strings.Contains(input, agentQuestionReplyOpen) || !strings.Contains(input, "toolu_q") ||
		!strings.Contains(input, "Use CSV, the person's usual format.") {
		t.Fatalf("helper input = %s", input)
	}
}
