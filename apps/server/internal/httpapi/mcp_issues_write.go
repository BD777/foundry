package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/issues"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The issues tool: the Issue steps a person takes that an agent acting for
// them may take too (create, draft, comment, retry). Confirming a contract,
// discarding a draft, answering the question an Issue waits on, abandoning and
// accepting are the person's (mcp_person_only.go). Each op decodes the body the
// HTTP route would receive (decodeEvidenceJSON), checks reach as the route does
// and calls the same issues.Service method. The actor is the agent, acting for
// the account that started its session.

// issuesEnabled mirrors the web app's issuesEnabled (apps/web/src/lib/feature-flags.ts,
// DEV-148). Issues are hidden on both sides; turning them on is a code change to
// both, not a setting. While it is false, the tools in issueMCPTools are not
// listed and a call to one is refused.
const issuesEnabled = false

// issueMCPTools are the tools of the Issue workflow that are hidden while
// issuesEnabled is false: the issues tool, its read tools, and ask_person, which
// only an Issue's execution may call.
var issueMCPTools = map[string]bool{"issues": true, "list_issues": true, "get_issue": true, "ask_person": true}

// issuesMCPTools are the tools only the person's own chats and the sessions they
// start may call: not an Issue's execution, clarification or verifier, nor the
// assistant.
var issuesMCPTools = map[string]bool{"issues": true}

var issuesToolOps = []string{"schema", "validate", "create", "draft", "comment", "retry"}

// issueCreateRequest is the body of a create: the Issue form, which the HTTP
// route also decodes. It has no initializeGit: setting up Git in a workspace
// is the person's to confirm in Foundry.
type issueCreateRequest struct {
	store.CreateIssueInput
}

// issuesForMCP runs one op of the issues tool.
func (s *Server) issuesForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	op := mcpArgString(call.args, "op")
	if !slices.Contains(issuesToolOps, op) {
		return "", &statusError{http.StatusBadRequest, fmt.Errorf("unknown op %q: the issues tool takes %s", op, strings.Join(issuesToolOps, ", "))}
	}
	by, scope, err := s.issueWriter(ctx, call.actor)
	if err != nil {
		return "", err
	}
	switch op {
	case "schema":
		return issueSchemaForMCP(call.args)
	case "validate":
		return issueValidationForMCP(call.args)
	case "create":
		return s.createIssueForMCP(call, by, scope)
	case "draft":
		return s.draftIssueForMCP(call, by, scope)
	case "comment":
		return s.commentIssueForMCP(call, by, scope)
	default:
		return s.retryIssueForMCP(call, by, scope)
	}
}

// issueWriter is who an agent's issues call acts as: the account behind the
// session, in the workspaces that account reaches as the session does. An
// Issue's own sessions act for no one here.
func (s *Server) issueWriter(ctx context.Context, actor Actor) (issues.Actor, accessScope, error) {
	scope, err := s.contextScope(ctx, actor)
	if err != nil {
		return issues.Actor{}, accessScope{}, err
	}
	if scope.issueID != "" {
		return issues.Actor{}, accessScope{}, &statusError{http.StatusForbidden, errors.New("an Issue's own sessions do not create or change Issues: the person does it in Foundry")}
	}
	if scope.userID == "" {
		return issues.Actor{}, accessScope{}, &statusError{http.StatusForbidden, errors.New("this session has no person behind it to create or change Issues for")}
	}
	by := issues.Actor{ActorRef: store.ActorRef{Kind: "user", ID: scope.userID}, UserID: scope.userID}
	if actor.Agent() {
		sessionID := actor.Identity.SessionID
		by.ActorRef = store.ActorRef{Kind: "agent", ID: sessionID, DisplayName: "Foundry agent", SessionID: &sessionID}
		by.Via = issues.ViaAgent
	}
	return by, scope, nil
}

// mcpBodyWithout is the JSON object the HTTP route would receive for these
// arguments: all of them but the tool's own keys. Unknown keys stay, so the
// decoder refuses them as it refuses an unknown field in a request.
func mcpBodyWithout(args map[string]json.RawMessage, keys ...string) ([]byte, error) {
	body := map[string]json.RawMessage{}
	for key, raw := range args {
		if !slices.Contains(keys, key) {
			body[key] = raw
		}
	}
	return json.Marshal(body)
}

func issueRequestError(err error) error {
	return &statusError{http.StatusBadRequest, err}
}

func requireRequestID(args map[string]json.RawMessage, op string) (string, error) {
	requestID := strings.TrimSpace(mcpArgString(args, "requestId"))
	if requestID == "" {
		return "", issueRequestError(fmt.Errorf("requestId is required for %s: a key so that a repeated call is recorded once", op))
	}
	return requestID, nil
}

// issueValidationForMCP says what saving the content as a draft, or confirming
// it, would refuse, without writing anything (the HTTP validate route).
func issueValidationForMCP(args map[string]json.RawMessage) (string, error) {
	content := args["content"]
	if len(content) == 0 || string(content) == "null" {
		return "", issueRequestError(errors.New("content is required: the contract content, goal, inScope, outOfScope, constraints and criteria"))
	}
	confirming := mcpArgPresent(args, "confirming")
	problems := []string{}
	for _, problem := range store.ContractProblems(content, confirming) {
		problems = append(problems, store.ContractProblemHints(problem))
	}
	return encodeJSON(map[string]any{"problems": problems})
}

// issueSchemaForMCP answers one part of the contract draft's outline (op schema):
// the fields, which are required and the allowed values, small enough to read
// before drafting.
func issueSchemaForMCP(args map[string]json.RawMessage) (string, error) {
	part := strings.TrimSpace(mcpArgString(args, "part"))
	if part == "" {
		part = "contract"
	}
	outline, err := store.ContractOutline(part)
	if err != nil {
		return "", issueRequestError(err)
	}
	return outline, nil
}

func (s *Server) createIssueForMCP(call mcpCall, by issues.Actor, scope accessScope) (string, error) {
	raw, err := mcpBodyWithout(call.args, "op", "requestId")
	if err != nil {
		return "", err
	}
	var request issueCreateRequest
	if err := decodeEvidenceJSON(raw, "", &request); err != nil {
		return "", issueRequestError(err)
	}
	requestID, err := requireRequestID(call.args, "create")
	if err != nil {
		return "", err
	}
	input := request.CreateIssueInput
	if input.Runtime != "claude" && input.Runtime != "codex" {
		return "", issueRequestError(errors.New("runtime is required: claude or codex"))
	}
	input.WorkspaceID = requestedWorkspace(call.actor, input.WorkspaceID)
	if err := workspaceRefusal(scope, strings.TrimSpace(input.WorkspaceID), store.WorkspaceRoleMember); err != nil {
		return "", err
	}
	created, err := s.issueService.Create(call.r.Context(), by, input, issues.CreateOptions{RequestID: requestID})
	var needsGit *issues.NeedsGit
	if errors.As(err, &needsGit) {
		return "", &statusError{http.StatusConflict, fmt.Errorf("this workspace needs Git first (its folder is %s): the person confirms setting up Git in Foundry", needsGit.Path)}
	}
	if err != nil {
		return "", err
	}
	return encodeJSON(created.Issue)
}

// writableIssue is the Issue a call names, when the caller may change it
// (member of its workspace, the route's rule).
func (s *Server) writableIssue(call mcpCall, scope accessScope) (store.Issue, error) {
	issue, err := s.readableIssue(call.r.Context(), call.actor, mcpArgString(call.args, "issueId"))
	if err != nil {
		return store.Issue{}, err
	}
	return issue, workspaceRefusal(scope, issue.WorkspaceID, store.WorkspaceRoleMember)
}

// draftIssueForMCP saves a draft of the Issue's contract as an agent's proposal:
// the person confirms it, with the digest they saw. Its body is the one the
// draft route takes (content, baseRevision, changeReason).
func (s *Server) draftIssueForMCP(call mcpCall, by issues.Actor, scope accessScope) (string, error) {
	raw, err := mcpBodyWithout(call.args, "op", "issueId", "requestId")
	if err != nil {
		return "", err
	}
	var input store.ContractDraftInput
	if err := decodeEvidenceJSON(raw, "ContractDraftInput", &input); err != nil {
		return "", issueRequestError(errors.New(store.ContractProblemHints(err.Error())))
	}
	requestID, err := requireRequestID(call.args, "draft")
	if err != nil {
		return "", err
	}
	issue, err := s.writableIssue(call, scope)
	if err != nil {
		return "", err
	}
	contract, err := s.issueService.SaveDraft(call.r.Context(), by, issue.ID, input, requestID)
	if err != nil {
		return "", err
	}
	return encodeJSON(contract)
}

// commentIssueForMCP hands a message to the Issue as the person's conversation
// does (issues.Service.Message). Routing is the service's: a question about the
// Issue's status, a clarification of its draft, or feedback to its execution.
// An agent may not answer the question the Issue waits on.
func (s *Server) commentIssueForMCP(call mcpCall, by issues.Actor, scope accessScope) (string, error) {
	raw, err := mcpBodyWithout(call.args, "op", "issueId", "requestId")
	if err != nil {
		return "", err
	}
	var input issueMessageRequest
	if err := decodeEvidenceJSON(raw, "", &input); err != nil {
		return "", issueRequestError(err)
	}
	requestID, err := requireRequestID(call.args, "comment")
	if err != nil {
		return "", err
	}
	issue, err := s.writableIssue(call, scope)
	if err != nil {
		return "", err
	}
	by.Role = scope.role(issue.WorkspaceID)
	route, updated, err := s.issueService.Message(call.r.Context(), by, issue.ID, issues.Message{
		Text: input.Text, Key: requestID,
		Revision: input.ExpectedRevision, ContentDigest: input.ExpectedContentDigest, ChangeReason: input.ChangeReason,
		ExpectedRunID: input.ExpectedRunID,
	})
	if err != nil {
		return "", err
	}
	return encodeJSON(map[string]any{"route": route, "issue": updated})
}

// retryIssueForMCP resends the person's latest message to a clarification that
// failed (issues.Service.RetryClarification).
func (s *Server) retryIssueForMCP(call mcpCall, by issues.Actor, scope accessScope) (string, error) {
	issue, err := s.writableIssue(call, scope)
	if err != nil {
		return "", err
	}
	updated, err := s.issueService.RetryClarification(call.r.Context(), by, issue.ID, strings.TrimSpace(mcpArgString(call.args, "requestId")))
	if err != nil {
		return "", err
	}
	return encodeJSON(updated)
}
