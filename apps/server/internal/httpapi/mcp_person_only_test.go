package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Every person-only boundary of docs/personal-agent.md §4 has an entry, so the
// list cannot lose one by accident.
var allPersonOnlyBoundaries = []string{
	boundaryAssistantApproval, boundaryIssueAcceptance, boundaryLoginLogout, boundaryPassword,
	boundaryPairing, boundarySecretEntry, boundaryStop, boundaryGrants, boundaryMembership, boundaryDeletion,
	boundaryIssueDecision,
}

// argsOf is the call an entry describes: its op or action value, or a
// value for its first argument.
func argsOf(operation personOnlyOperation) map[string]json.RawMessage {
	args := map[string]json.RawMessage{}
	if operation.field != "" {
		value, _ := json.Marshal(operation.values[0])
		args[operation.field] = value
	}
	if len(operation.arguments) > 0 {
		args[operation.arguments[0]] = json.RawMessage(`"set"`)
	}
	return args
}

// Each boundary entry refuses an agent in any role, with the boundary named,
// and leaves the person's own calls alone.
func TestPersonOnlyBoundariesRefuseAgentsAndNotThePerson(t *testing.T) {
	agent := Actor{Kind: ActorAgent, Identity: store.SessionTokenIdentity{SessionID: "sess_agent"}}
	person := Actor{Kind: ActorAccount}
	covered := []string{}
	for _, operation := range personOnlyOperations {
		if !slices.Contains(covered, operation.boundary) {
			covered = append(covered, operation.boundary)
		}
		args := argsOf(operation)
		err := mcpPersonOnly(agent, operation.tool, args)
		var status *statusError
		if !errors.As(err, &status) || status.status != http.StatusForbidden || !strings.Contains(err.Error(), operation.boundary) {
			t.Errorf("%s %v: agent got %v, want a 403 naming %q", operation.tool, args, err, operation.boundary)
		}
		if err := mcpPersonOnly(person, operation.tool, args); err != nil {
			t.Errorf("%s: the person's own call was refused: %v", operation.tool, err)
		}
	}
	for _, boundary := range allPersonOnlyBoundaries {
		if !slices.Contains(covered, boundary) {
			t.Errorf("boundary %q has no entry", boundary)
		}
	}
	if len(covered) != len(allPersonOnlyBoundaries) {
		t.Errorf("entries cover %v, want exactly the %d boundaries", covered, len(allPersonOnlyBoundaries))
	}
}

// Calls that are not the person-only operation pass the gate: the same tool
// with another op or action, a secret cleared to false, and the reads.
func TestPersonOnlyGateLeavesOtherCallsAlone(t *testing.T) {
	agent := Actor{Kind: ActorAgent, Identity: store.SessionTokenIdentity{SessionID: "sess_agent"}}
	for _, call := range []struct {
		tool string
		args map[string]any
	}{
		{"sign_in_subscription", map[string]any{"action": "start"}},
		{"connector_instances", map[string]any{"action": "list"}},
		{"connector_instances", map[string]any{"action": "check"}},
		{"edge_access", map[string]any{"action": "list"}},
		{"save_model_provider", map[string]any{"providerId": "p1", "label": "Team"}},
		{"save_model_provider", map[string]any{"providerId": "p1", "clearApiKey": false}},
		{"save_model_provider", map[string]any{"providerId": "p1", "copyApiKeyFromProviderId": "p2"}},
		{"assistant_channels", map[string]any{"op": "list"}},
		{"assistant_channels", map[string]any{"op": "update", "channelId": "mch_1"}},
		{"list_model_providers", map[string]any{}},
		{"issues", map[string]any{"op": "create"}},
		{"issues", map[string]any{"op": "draft"}},
		{"issues", map[string]any{"op": "comment"}},
		{"issues", map[string]any{"op": "retry"}},
		{"issues", map[string]any{"op": "validate"}},
	} {
		args := map[string]json.RawMessage{}
		for key, value := range call.args {
			raw, _ := json.Marshal(value)
			args[key] = raw
		}
		if err := mcpPersonOnly(agent, call.tool, args); err != nil {
			t.Errorf("%s %v refused: %v", call.tool, call.args, err)
		}
	}
}

// The operations an agent can already reach through MCP are refused over the
// real tool path, before their handlers run.
func TestPersonOnlyOperationsAreRefusedOverMCP(t *testing.T) {
	f := newAssistantFixture(t)
	for _, call := range []struct {
		tool     string
		args     map[string]any
		boundary string
	}{
		{"sign_in_subscription", map[string]any{"deviceId": "dev_alice", "runtime": "claude", "action": "code", "code": "123"}, boundaryLoginLogout},
		{"connector_instances", map[string]any{"action": "revoke", "instanceId": "xinst_1"}, boundaryLoginLogout},
		{"connector_instances", map[string]any{"action": "delete", "instanceId": "xinst_1"}, boundaryDeletion},
		{"edge_access", map[string]any{"action": "delete", "id": "edge_1"}, boundaryDeletion},
		{"save_model_provider", map[string]any{"providerId": "p1", "runtime": "claude", "apiKey": "not-a-real-key"}, boundarySecretEntry},
		{"delete_model_provider", map[string]any{"providerId": "p1"}, boundaryDeletion},
		{"assistant_channels", map[string]any{"op": "grant-source", "accountId": "xacc_1"}, boundaryGrants},
	} {
		text, failed := f.tool(t, f.token, call.tool, call.args)
		if !failed || !strings.Contains(text, call.boundary) {
			t.Errorf("%s %v: got %q (failed %v), want refusal naming %q", call.tool, call.args, text, failed, call.boundary)
		}
	}
}
