package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"

	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestKnowledgeRememberUsesSelectedOwnerAndDoesNotTrustInference(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	_, err := f.server.store.CreateKnowledgeVault(ctx, store.KnowledgeVault{ID: flow.Key("vault", f.aliceID, "memory"), UserID: f.aliceID, Kind: "memory", WorkspaceID: "ws_alice", DeviceID: "dev_alice", RootPath: "knowledge"})
	if err != nil {
		t.Fatal(err)
	}
	session := f.startSession(t, "ws_pa", "", "I prefer concise reports")
	token := f.mint(t, session.ID)
	input := map[string]any{"op": "add", "item": map[string]any{"intentKey": "report-style", "title": "Report style", "content": "Prefers concise reports", "quote": "I prefer concise reports"}}
	text, failed := f.tool(t, token, "remember", input)
	if failed || !strings.Contains(text, `"status": "captured"`) {
		t.Fatalf("source capture: %s", text)
	}
	text, failed = f.tool(t, token, "remember", input)
	if failed {
		t.Fatalf("source replay: %s", text)
	}
	jobs, err := f.server.store.ListKnowledgeMutations(ctx, f.aliceID)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("duplicate source writes: %+v %v", jobs, err)
	}
	if !strings.Contains(jobs[0].SourceRef, "/event/evt_"+session.Input.ID) {
		t.Fatalf("wrong source event: %+v", jobs[0])
	}
	if _, err = f.server.store.CompleteAgentSession(ctx, session.ID, "noted", ""); err != nil {
		t.Fatal(err)
	}
	if _, err = f.server.store.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: personalagent.Notice("review current facts")}); err != nil {
		t.Fatal(err)
	}
	if text, failed = f.tool(t, token, "remember", input); failed {
		t.Fatalf("historical source replay: %s", text)
	}
	jobs, _ = f.server.store.ListKnowledgeMutations(ctx, f.aliceID)
	if len(jobs) != 1 {
		t.Fatal("a later notice duplicated the original user fact")
	}
	legacy, err := f.server.store.ListPersonalAgentMemory(ctx, f.aliceID)
	if err != nil || len(legacy) != 0 {
		t.Fatalf("second editable fact body created: %+v %v", legacy, err)
	}
	guessed, failed := f.tool(t, token, "remember", map[string]any{"op": "add", "item": map[string]any{"intentKey": "guess", "title": "Guess", "content": "Probably wants weekly calls", "inferred": true}})
	if failed || !strings.Contains(guessed, "needs_confirmation") {
		t.Fatalf("inference trusted: %s", guessed)
	}
	jobs, _ = f.server.store.ListKnowledgeMutations(ctx, f.aliceID)
	if len(jobs) != 1 {
		t.Fatal("inferred fact written to authority")
	}
	for _, tool := range []string{"create_session", "send_message"} {
		text, failed = f.tool(t, token, tool, map[string]any{})
		if !failed || !strings.Contains(text, "dispatch_item") {
			t.Fatalf("assistant bypassed dispatch ledger through %s: %s", tool, text)
		}
	}
	// The REST route its token also reaches refuses it the same way.
	request := httptest.NewRequest(http.MethodPost, "/api/agent-sessions", strings.NewReader(`{"workspaceId":"ws_alice","provider":"claude","prompt":"do it myself"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "dispatch_item") {
		t.Fatalf("assistant bypassed dispatch ledger through POST /api/agent-sessions: %d %s", response.Code, response.Body.String())
	}
	request = httptest.NewRequest(http.MethodPost, "/api/agent-sessions/"+session.ID+"/messages", strings.NewReader(`{"prompt":"do it myself"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	response = httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "dispatch_item") {
		t.Fatalf("assistant bypassed dispatch ledger through POST messages: %d %s", response.Code, response.Body.String())
	}
}
