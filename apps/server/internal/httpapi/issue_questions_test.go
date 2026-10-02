package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

// The execution asks through the ask_person Foundry tool; only the Issue's
// creator or a maintainer answers, and the answer resumes the Issue.
func TestExecutionAsksThePersonThroughFoundryTools(t *testing.T) {
	f := newIsolationFixture(t)
	ctx := context.Background()
	db := f.server.store
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.bob, http.MethodPost, "/api/workspaces/ws_bob/members", `{"username":"owner","role":"member"}`)),
		http.StatusNoContent, "share ws_bob with alice as member")
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_bob", Title: "deploy", Runtime: "claude", CreatedByUserID: f.bobID})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, db.(store.EvidenceStore), issue.ID)
	executions := db.(store.IssueExecutionStore)
	_, executor, err := executions.ClaimIssueExecution(ctx, "dev_bob", "ws_bob")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, executor.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartIssueRun(ctx, issue.ID, store.Run{ID: executor.ID, Runtime: "claude", StartedAt: time.Now().UTC().Format(time.RFC3339)}); err != nil {
		t.Fatal(err)
	}
	token, err := db.MintAgentSessionToken(ctx, executor.ID)
	if err != nil {
		t.Fatal(err)
	}
	ask := doAuthCall(t, f.handler, authCall{method: http.MethodPost, path: "/api/mcp",
		body:    `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask_person","arguments":{"question":"Deploy to staging?","kind":"permission","options":["Yes","No"]}}}`,
		headers: map[string]string{"Authorization": "Bearer " + token, "Content-Type": "application/json"}})
	if !strings.Contains(ask.Body.String(), "End this turn now") || strings.Contains(ask.Body.String(), "isError") {
		t.Fatalf("ask_person: %s", ask.Body.String())
	}
	asked, err := db.GetIssue(ctx, issue.ID)
	if err != nil || asked.Question == nil || asked.Question.Kind != "permission" || len(asked.Question.Options) != 2 {
		t.Fatalf("question not recorded: %+v %v", asked.Question, err)
	}
	if _, err := db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{RunID: executor.ID, Artifact: store.AcceptanceArtifact{ID: "art", IssueID: issue.ID, Kind: "text", Title: "Summary"}}); err != nil {
		t.Fatal(err)
	}
	answer := func(cookie string) *httptest.ResponseRecorder {
		return doAuthCall(t, f.handler, f.as(cookie, http.MethodPost, "/api/issues/"+issue.ID+"/answer", `{"questionId":"`+asked.Question.ID+`","answer":"Approved"}`))
	}
	expectStatus(t, answer(f.alice), http.StatusForbidden, "a member who did not start the Issue approves its permission")
	resumed := answer(f.bob)
	expectStatus(t, resumed, http.StatusOK, "the Issue's creator answers")
	var current store.Issue
	if err := json.Unmarshal(resumed.Body.Bytes(), &current); err != nil || current.Status != "pending" || current.Question != nil {
		t.Fatalf("the answer did not resume the Issue: %s", resumed.Body.String())
	}
}
