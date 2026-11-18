package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

// issueContentArgs is a complete contract content, as the issues tool takes it.
func issueContentArgs(t *testing.T, goal string) map[string]any {
	t.Helper()
	source := store.EvidenceRequirementSourceCandidateFile
	content := store.ContractContent{
		Goal: store.RichContent{Text: goal, Media: []store.ReferenceMedia{}}, InScope: []string{}, OutOfScope: []string{}, Constraints: []string{},
		Criteria: []store.AcceptanceCriterion{{
			ID: "criterion_output", Title: "Requested output", Statement: "The candidate contains the requested output", Required: true,
			ProofKind: "content_completeness", EvaluationMode: "agent",
			Rubric:               store.RichContent{Text: "Inspect the candidate output", Media: []store.ReferenceMedia{}},
			EvidenceRequirements: []store.EvidenceRequirement{{ID: "requirement_output", Description: "Candidate output", AcceptedCarriers: []store.CarrierKind{"document"}, MinimumCount: 1, BindingPolicy: "system_observed", Source: &source}},
		}},
	}
	raw, err := json.Marshal(content)
	if err != nil {
		t.Fatal(err)
	}
	var args map[string]any
	if err := json.Unmarshal(raw, &args); err != nil {
		t.Fatal(err)
	}
	return args
}

// withArgs returns the arguments with the extra keys set.
func withArgs(base map[string]any, extra map[string]any) map[string]any {
	args := map[string]any{}
	for key, value := range base {
		args[key] = value
	}
	for key, value := range extra {
		args[key] = value
	}
	return args
}

func decodeIssueAnswer(t *testing.T, text string) map[string]any {
	t.Helper()
	var answer map[string]any
	if err := json.Unmarshal([]byte(text), &answer); err != nil {
		t.Fatalf("answer is not JSON: %q (%v)", text, err)
	}
	return answer
}

// httpIssueCall calls a route as the person (their cookie) with an Idempotency-Key.
func (f assistantFixture) httpIssueCall(t *testing.T, method, path, body string) (int, map[string]any) {
	t.Helper()
	response := doAuthCall(t, f.server.Routes(), authCall{method: method, path: path, body: body, cookie: f.alice, origin: accountsTestOrigin,
		headers: map[string]string{"Idempotency-Key": "http-" + path}})
	var answer map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &answer)
	return response.Code, answer
}

// An Issue's own sessions and the assistant never see the issues tool; the
// person's chats and the sessions they start do.
func TestIssuesToolIsOfferedOnlyToThePersonsOwnSessions(t *testing.T) {
	skipWhileIssuesHidden(t)
	f := newAssistantFixture(t)
	ctx := context.Background()
	chat := f.startSession(t, "ws_alice", "", "a chat in a project")
	helper := f.startSession(t, "ws_alice", chat.ID, "a helper")
	issue, err := f.server.store.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_alice", SourceInput: "ship the page", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, f.server.store, issue.ID)
	_, execution, err := f.server.store.ClaimIssueExecution(ctx, "dev_alice", "ws_alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.store.StartIssueRun(ctx, issue.ID, store.Run{ID: execution.ID, Runtime: "claude"}); err != nil {
		t.Fatal(err)
	}
	listed := func(token string) bool {
		t.Helper()
		return slices.Contains(mcpListedNames(t, f.server.Routes(), token), "issues")
	}
	if !listed(f.mint(t, chat.ID)) || !listed(f.mint(t, helper.ID)) {
		t.Fatal("a person's chat or the helper it started does not list the issues tool")
	}
	if listed(f.token) {
		t.Fatal("the assistant lists the issues tool")
	}
	if listed(f.mint(t, execution.ID)) {
		t.Fatal("an Issue's execution lists the issues tool")
	}
	for _, role := range []string{store.AgentSessionRoleIssueExecution, store.AgentSessionRoleIssueClarification, store.AgentSessionRolePersonalAgent} {
		if mcpToolAllowed(role, false, "issues") == nil {
			t.Errorf("role %q may call the issues tool", role)
		}
	}
	if mcpToolAllowed("", true, "issues") == nil {
		t.Error("a verifier may call the issues tool")
	}
	if err := mcpToolAllowed("", false, "issues"); err != nil {
		t.Errorf("a person's chat is refused the issues tool: %v", err)
	}
}

// While issuesEnabled is false the Issue tools are not listed, and a call to
// the issues tool is refused before anything is written.
func TestIssueToolsAreHiddenWhileIssuesAreDisabled(t *testing.T) {
	f := newAssistantFixture(t)
	chat := f.startSession(t, "ws_alice", "", "a chat in a project")
	token := f.mint(t, chat.ID)

	names := mcpListedNames(t, f.server.Routes(), token)
	for _, name := range []string{"issues", "list_issues", "get_issue", "ask_person"} {
		if slices.Contains(names, name) {
			t.Errorf("tools/list offers %s while Issues are turned off", name)
		}
	}
	create := map[string]any{"op": "create", "requestId": "off-1", "workspaceId": "ws_alice", "title": "Friendlier greeting", "sourceInput": "make the greeting friendlier", "runtime": "claude"}
	if text, failed := f.tool(t, token, "issues", create); !failed || !strings.Contains(text, "Issues are turned off") {
		t.Fatalf("create while Issues are turned off: %q (failed %v)", text, failed)
	}
}

// skipWhileIssuesHidden skips a test that calls an Issue tool through the MCP
// route: the route refuses those tools while issuesEnabled is false
// (mcp_issues_write.go). Re-enabling Issues is a code change; drop the skip then.
func skipWhileIssuesHidden(t *testing.T) {
	t.Helper()
	if !issuesEnabled {
		t.Skip("Issue tools are hidden from MCP: issuesEnabled is false (mcp_issues_write.go)")
	}
}

// mcpListedNames is the tool names tools/list sends to a token.
func mcpListedNames(t *testing.T, handler http.Handler, token string) []string {
	t.Helper()
	names := []string{}
	for name := range mcpListedToolDefinitions(t, handler, token) {
		names = append(names, name)
	}
	return names
}

// create through MCP makes the same Issue the HTTP route does, under the
// person's account; the same refusals and replays apply.
func TestIssueCreateOverMCPMakesTheSameIssueAsTheRoute(t *testing.T) {
	skipWhileIssuesHidden(t)
	f := newAssistantFixture(t)
	chat := f.startSession(t, "ws_alice", "", "a chat in a project")
	token := f.mint(t, chat.ID)
	base := map[string]any{"op": "create", "workspaceId": "ws_alice", "title": "Friendlier greeting", "sourceInput": "make the greeting friendlier", "runtime": "claude"}

	if text, failed := f.tool(t, token, "issues", base); !failed || !strings.Contains(text, "requestId is required") {
		t.Fatalf("create without a requestId: %q (failed %v)", text, failed)
	}
	if text, failed := f.tool(t, token, "issues", withArgs(base, map[string]any{"requestId": "c1", "initializeGit": true})); !failed || !strings.Contains(text, "initializeGit") {
		t.Fatalf("create set up Git for the person: %q (failed %v)", text, failed)
	}
	if text, failed := f.tool(t, token, "issues", withArgs(base, map[string]any{"requestId": "c1", "runtime": ""})); !failed || !strings.Contains(text, "runtime is required") {
		t.Fatalf("create without a runtime: %q (failed %v)", text, failed)
	}

	first, failed := f.tool(t, token, "issues", withArgs(base, map[string]any{"requestId": "create-1"}))
	if failed {
		t.Fatalf("create: %s", first)
	}
	again, failed := f.tool(t, token, "issues", withArgs(base, map[string]any{"requestId": "create-1"}))
	if failed || decodeIssueAnswer(t, again)["id"] != decodeIssueAnswer(t, first)["id"] {
		t.Fatalf("a repeated create was recorded twice: %s / %s", first, again)
	}
	mcpIssue := decodeIssueAnswer(t, first)
	stored, err := f.server.store.GetIssue(context.Background(), mcpIssue["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if stored.CreatedByUserID != f.aliceID {
		t.Fatalf("created by %q, want the person %q", stored.CreatedByUserID, f.aliceID)
	}

	status, httpIssue := f.httpIssueCall(t, http.MethodPost, "/api/issues",
		`{"workspaceId":"ws_alice","title":"Friendlier greeting","sourceInput":"make the greeting friendlier","runtime":"claude"}`)
	if status != http.StatusCreated {
		t.Fatalf("the route answered %d: %v", status, httpIssue)
	}
	for _, field := range []string{"workspaceId", "title", "sourceInput", "runtime", "status", "contractState"} {
		if mcpIssue[field] != httpIssue[field] {
			t.Errorf("%s: MCP %v, route %v", field, mcpIssue[field], httpIssue[field])
		}
	}
}

// draft through MCP saves the same contract the route does, as the agent's
// proposal; a confirmed contract is edited by a new draft, and the Issue keeps
// its confirmed revision until the person confirms.
func TestIssueDraftOverMCPSavesTheRoutesContractAsAProposal(t *testing.T) {
	skipWhileIssuesHidden(t)
	f := newAssistantFixture(t)
	ctx := context.Background()
	chat := f.startSession(t, "ws_alice", "", "a chat in a project")
	token := f.mint(t, chat.ID)
	content := issueContentArgs(t, "Deliver the greeting")

	mcpIssue, err := f.server.store.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_alice", SourceInput: "greeting", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	draft, failed := f.tool(t, token, "issues", map[string]any{"op": "draft", "issueId": mcpIssue.ID, "requestId": "draft-1", "content": content, "baseRevision": 1, "changeReason": "Refine the greeting"})
	if failed {
		t.Fatalf("draft: %s", draft)
	}
	mcpDraft := decodeIssueAnswer(t, draft)

	routeIssue, err := f.server.store.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_alice", SourceInput: "greeting", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	status, routeDraft := f.httpIssueCall(t, http.MethodPost, "/api/issues/"+routeIssue.ID+"/contracts",
		`{"baseRevision":1,"changeReason":"Refine the greeting","content":`+mustJSON(t, content)+`}`)
	if status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("the route answered %d: %v", status, routeDraft)
	}
	for _, field := range []string{"revision", "status", "contentDigest"} {
		if mcpDraft[field] != routeDraft[field] {
			t.Errorf("%s: MCP %v, route %v", field, mcpDraft[field], routeDraft[field])
		}
	}
	if mcpDraft["origin"] != "agent_proposal" || routeDraft["origin"] != "user" {
		t.Errorf("origin: MCP %v (want agent_proposal), route %v (want user)", mcpDraft["origin"], routeDraft["origin"])
	}

	bad := map[string]any{"op": "draft", "issueId": mcpIssue.ID, "requestId": "draft-2", "content": map[string]any{"goal": map[string]any{"text": "no criteria"}}, "baseRevision": 2, "changeReason": "Refine"}
	if text, failed := f.tool(t, token, "issues", bad); !failed {
		t.Fatalf("a draft without its criteria was saved: %s", text)
	}
	if text, failed := f.tool(t, token, "issues", map[string]any{"op": "validate", "content": content}); failed || !strings.Contains(text, `"problems": []`) {
		t.Fatalf("validate of complete content: %q (failed %v)", text, failed)
	}
	if text, failed := f.tool(t, token, "issues", map[string]any{"op": "validate", "content": map[string]any{"goal": map[string]any{"text": "x"}}}); failed || strings.Contains(text, `"problems": []`) {
		t.Fatalf("validate of incomplete content found no problem: %q (failed %v)", text, failed)
	}

	confirmed, err := f.server.store.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_alice", SourceInput: "greeting", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, f.server.store, confirmed.ID)
	edit, failed := f.tool(t, token, "issues", map[string]any{"op": "draft", "issueId": confirmed.ID, "requestId": "edit-1", "content": issueContentArgs(t, "Deliver a warmer greeting"), "baseRevision": 2, "changeReason": "Warmer tone"})
	if failed {
		t.Fatalf("edit a confirmed contract: %s", edit)
	}
	view, failed := f.tool(t, token, "get_issue", map[string]any{"issueId": confirmed.ID})
	if failed || !strings.Contains(view, `"revision": 2`) || !strings.Contains(view, `"draftRevision": 3`) {
		t.Fatalf("the confirmed Issue shows %s; want contract r2 with a draft r3", view)
	}
}

// comment through MCP is routed by the Issue as the person's message is. An
// agent may ask the status and give feedback, but not answer the question the
// Issue waits on.
func TestIssueCommentOverMCPNeverAnswersTheQuestion(t *testing.T) {
	skipWhileIssuesHidden(t)
	f := newAssistantFixture(t)
	ctx := context.Background()
	chat := f.startSession(t, "ws_alice", "", "a chat in a project")
	token := f.mint(t, chat.ID)

	issue, err := f.server.store.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_alice", SourceInput: "deploy the site", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, f.server.store, issue.ID)
	_, execution, err := f.server.store.ClaimIssueExecution(ctx, "dev_alice", "ws_alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.store.StartAgentSession(ctx, execution.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.store.StartIssueRun(ctx, issue.ID, store.Run{ID: execution.ID, Runtime: "claude", StartedAt: time.Now().UTC().Format(time.RFC3339)}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.store.AskIssueQuestion(ctx, execution.ID, store.IssueQuestion{Kind: "permission", Text: "Deploy to staging?", Options: []string{"Yes", "No"}}); err != nil {
		t.Fatal(err)
	}
	// The execution's turn ends on the question, and the Issue blocks on it.
	if _, err := f.server.store.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{RunID: execution.ID, Response: "Waiting for approval to deploy."}); err != nil {
		t.Fatal(err)
	}

	text, failed := f.tool(t, token, "issues", map[string]any{"op": "comment", "issueId": issue.ID, "requestId": "answer-1", "text": "Yes, deploy"})
	if !failed || !strings.Contains(text, "agents do not answer it through Foundry") {
		t.Fatalf("a comment answered the question: %q (failed %v)", text, failed)
	}
	waiting, err := f.server.store.GetIssue(ctx, issue.ID)
	if err != nil {
		t.Fatal(err)
	}
	if waiting.Question == nil || waiting.Status != "blocked" {
		t.Fatalf("the question was answered anyway: status %s, question %+v", waiting.Status, waiting.Question)
	}

	status, failed := f.tool(t, token, "issues", map[string]any{"op": "comment", "issueId": issue.ID, "requestId": "status-1", "text": "status?"})
	if failed || !strings.Contains(status, `"route": "status"`) {
		t.Fatalf("a status question while blocked: %q (failed %v)", status, failed)
	}
}

// Retrying a clarification through MCP answers what the route does when there
// is nothing to retry.
func TestIssueRetryOverMCPMatchesTheRoute(t *testing.T) {
	f := newAssistantFixture(t)
	chat := f.startSession(t, "ws_alice", "", "a chat in a project")
	token := f.mint(t, chat.ID)
	issue, err := f.server.store.CreateIssue(context.Background(), store.CreateIssueInput{WorkspaceID: "ws_alice", SourceInput: "greeting", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	text, failed := f.tool(t, token, "issues", map[string]any{"op": "retry", "issueId": issue.ID})
	status, _ := f.httpIssueCall(t, http.MethodPost, "/api/issues/"+issue.ID+"/clarify/retry", "")
	if !failed || status < 400 {
		t.Fatalf("retry through MCP %q (failed %v) but the route answered %d", text, failed, status)
	}
}

// Confirming, discarding, answering, abandoning and accepting are refused over
// MCP by name, and an unknown op is refused.
func TestIssuesToolRefusesThePersonsDecisionsOverMCP(t *testing.T) {
	skipWhileIssuesHidden(t)
	f := newAssistantFixture(t)
	chat := f.startSession(t, "ws_alice", "", "a chat in a project")
	token := f.mint(t, chat.ID)
	for op, boundary := range map[string]string{
		"accept": boundaryIssueAcceptance, "abandon": boundaryIssueAcceptance, "cancel": boundaryIssueAcceptance,
		"verify": boundaryIssueAcceptance, "verdict": boundaryIssueAcceptance,
		"confirm": boundaryIssueDecision, "start": boundaryIssueDecision, "discard": boundaryIssueDecision, "answer": boundaryIssueDecision,
	} {
		text, failed := f.tool(t, token, "issues", map[string]any{"op": op, "issueId": "iss_missing", "revision": 1})
		if !failed || !strings.Contains(text, boundary) {
			t.Errorf("op %s: %q (failed %v), want a refusal naming %q", op, text, failed, boundary)
		}
	}
	if text, failed := f.tool(t, token, "issues", map[string]any{"op": "frobnicate"}); !failed || !strings.Contains(text, "unknown op") {
		t.Errorf("an unknown op: %q (failed %v)", text, failed)
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// outlineAgent drafts a contract from the issues tool's own answers only: it
// reads one part of the outline at a time (op schema) and fills every required
// field with a value the outline allows.
type outlineAgent struct {
	t     *testing.T
	f     assistantFixture
	token string
}

func (a outlineAgent) part(name string) map[string]any {
	a.t.Helper()
	text, failed := a.f.tool(a.t, a.token, "issues", map[string]any{"op": "schema", "part": name})
	if failed {
		a.t.Fatalf("schema %s: %s", name, text)
	}
	return decodeIssueAnswer(a.t, text)
}

// fill is the object an outline describes, with its required fields set.
func (a outlineAgent) fill(outline map[string]any) map[string]any {
	fields, _ := outline["fields"].(map[string]any)
	value := map[string]any{}
	for name, raw := range fields {
		spec := raw.(map[string]any)
		if spec["optional"] == true {
			continue
		}
		value[name] = a.value(name, spec)
	}
	return value
}

func (a outlineAgent) value(name string, spec map[string]any) any {
	switch spec["type"] {
	case "string":
		return name
	case "boolean":
		return true
	case "integer":
		if minimum, ok := spec["min"].(float64); ok {
			return minimum
		}
		return 1.0
	case "enum":
		return chooseEnum(spec)
	case "array":
		items := []any{}
		if spec["minItems"] != nil {
			switch spec["of"] {
			case "enum":
				items = append(items, chooseEnum(spec))
			case "object":
				items = append(items, a.object(spec))
			}
		}
		return items
	case "object":
		return a.object(spec)
	}
	return nil
}

func (a outlineAgent) object(spec map[string]any) map[string]any {
	if part, ok := spec["see"].(string); ok {
		return a.fill(a.part(part))
	}
	if _, ok := spec["fields"]; ok {
		return a.fill(spec)
	}
	return map[string]any{}
}

// chooseEnum takes the first allowed value whose note does not say it needs
// something the agent may not have (a checker).
func chooseEnum(spec map[string]any) string {
	notes, _ := spec["notes"].(map[string]any)
	values := spec["values"].([]any)
	for _, raw := range values {
		value := raw.(string)
		if note, _ := notes[value].(string); !strings.Contains(note, "needs") {
			return value
		}
	}
	return values[0].(string)
}

// An agent that follows only the issues tool's answers drafts a contract that
// validates and saves; the same agent can tell what confirming would still need.
func TestAgentDraftFromTheSchemaOutlineIsValid(t *testing.T) {
	t.Skip("DEV-298h: Issues are turned off on this server, so the issues tool is not offered; re-enable when Issues return")
	f := newAssistantFixture(t)
	chat := f.startSession(t, "ws_alice", "", "a chat in a project")
	token := f.mint(t, chat.ID)
	agent := outlineAgent{t: t, f: f, token: token}
	content := agent.fill(agent.part("contract"))

	problems, failed := f.tool(t, token, "issues", map[string]any{"op": "validate", "content": content})
	if failed || !strings.Contains(problems, `"problems": []`) {
		t.Fatalf("the outline's draft does not validate: %s (failed %v)", problems, failed)
	}
	confirm, failed := f.tool(t, token, "issues", map[string]any{"op": "validate", "content": content, "confirming": true})
	if failed || !strings.Contains(confirm, "source") {
		t.Fatalf("confirming should still need an evidence source: %s (failed %v)", confirm, failed)
	}

	issue, err := f.server.store.CreateIssue(context.Background(), store.CreateIssueInput{WorkspaceID: "ws_alice", SourceInput: "greeting", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	saved, failed := f.tool(t, token, "issues", map[string]any{"op": "draft", "issueId": issue.ID, "requestId": "outline-1",
		"content": content, "baseRevision": 1, "changeReason": "Drafted from the schema outline"})
	if failed {
		t.Fatalf("the outline's draft was refused: %s", saved)
	}
	if answer := decodeIssueAnswer(t, saved); answer["revision"] != 2.0 || answer["origin"] != "agent_proposal" {
		t.Fatalf("saved draft %s, want revision 2 as an agent proposal", saved)
	}
}

// A problem names the allowed values of the enum fields it mentions, on the
// validate answer and in a refused draft alike.
func TestIssueProblemsNameTheAllowedValues(t *testing.T) {
	skipWhileIssuesHidden(t)
	f := newAssistantFixture(t)
	chat := f.startSession(t, "ws_alice", "", "a chat in a project")
	token := f.mint(t, chat.ID)
	agent := outlineAgent{t: t, f: f, token: token}
	content := agent.fill(agent.part("contract"))
	criterion := content["criteria"].([]any)[0].(map[string]any)
	delete(criterion, "proofKind")
	delete(criterion, "evaluationMode")

	text, failed := f.tool(t, token, "issues", map[string]any{"op": "validate", "content": content})
	if failed || !strings.Contains(text, "proofKind: functional, visual_interaction, quality") || !strings.Contains(text, "evaluationMode: deterministic, agent") {
		t.Fatalf("validate did not name the allowed values: %s (failed %v)", text, failed)
	}
	issue, err := f.server.store.CreateIssue(context.Background(), store.CreateIssueInput{WorkspaceID: "ws_alice", SourceInput: "greeting", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	refused, failed := f.tool(t, token, "issues", map[string]any{"op": "draft", "issueId": issue.ID, "requestId": "hint-1", "content": content, "baseRevision": 1, "changeReason": "Missing fields"})
	if !failed || !strings.Contains(refused, "[allowed: ") {
		t.Fatalf("a refused draft did not name the allowed values: %s (failed %v)", refused, failed)
	}
}

// Each part of the outline is answered by name, and an unknown part is refused.
func TestIssueSchemaAnswersParts(t *testing.T) {
	skipWhileIssuesHidden(t)
	f := newAssistantFixture(t)
	chat := f.startSession(t, "ws_alice", "", "a chat in a project")
	token := f.mint(t, chat.ID)
	for _, part := range []string{"contract", "criterion", "richContent", "evidence"} {
		text, failed := f.tool(t, token, "issues", map[string]any{"op": "schema", "part": part})
		if failed || decodeIssueAnswer(t, text)["part"] != part {
			t.Errorf("part %s: %s (failed %v)", part, text, failed)
		}
	}
	if text, failed := f.tool(t, token, "issues", map[string]any{"op": "schema", "part": "everything"}); !failed || !strings.Contains(text, "part is one of") {
		t.Errorf("an unknown part: %s (failed %v)", text, failed)
	}
}
