package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
)

// The person-only boundaries (docs/personal-agent.md §4; .foundry/reports/
// foundry-mcp-coverage.md §4). An agent never does these through Foundry MCP,
// in any role: the person does them in Settings, on the Web or in Feishu.
// personOnlyOperations is the one list; mcpPersonOnly checks every agent call
// in mcpToolPreflight, before the tool's handler runs. A person's own MCP
// calls (a signed-in account, a device credential) are not refused here.
const (
	boundaryAssistantApproval = "approving the assistant's own proposals and writes"
	boundaryIssueAcceptance   = "accepting an Issue or giving it a verdict"
	boundaryIssueDecision     = "confirming or discarding an Issue's contract, or answering the question it waits on"
	boundaryLoginLogout       = "signing in or out of an account"
	boundaryPassword          = "changing a password"
	boundaryPairing           = "pairing a device"
	boundarySecretEntry       = "entering or clearing a secret"
	boundaryStop              = "the assistant's stop switch"
	boundaryGrants            = "granting a source or a permission package"
	boundaryMembership        = "membership and sharing"
	boundaryDeletion          = "deleting"
)

// personOnlyOperation is one operation an agent is refused. The tool names it;
// field and values match its op or action argument, and arguments match a call
// that sends a value for any of them. A tool with neither is refused whole.
// The entries marked "today" are operations an agent can call now; the others
// have no MCP operation yet, and stay refused if one is added.
type personOnlyOperation struct {
	boundary  string
	tool      string
	field     string
	values    []string
	arguments []string
}

var personOnlyOperations = []personOnlyOperation{
	// Today.
	{boundaryLoginLogout, "sign_in_subscription", "action", []string{"code"}, nil},
	{boundaryLoginLogout, "connector_instances", "action", []string{"revoke"}, nil},
	// Entering a key is secret entry; clearing one destroys it. Copying a key
	// the person already entered (copyApiKeyFromProviderId) is allowed: the key
	// is never in the agent's hands or its answer.
	{boundarySecretEntry, "save_model_provider", "", nil, []string{"apiKey", "clearApiKey"}},
	{boundaryDeletion, "connector_instances", "action", []string{"delete"}, nil},
	{boundaryDeletion, "edge_access", "action", []string{"delete"}, nil},
	{boundaryDeletion, "delete_model_provider", "", nil, nil},
	// Worker groups are deleted by the person only (the boundary table in
	// .foundry/reports/foundry-mcp-coverage.md §4); foundry_settings has no delete.
	{boundaryDeletion, "foundry_settings", "op", []string{"delete"}, nil},
	{boundaryGrants, "assistant_channels", "op", []string{"grant-source"}, nil},
	// Guards: no MCP operation today.
	{boundaryAssistantApproval, "needs_you", "op", []string{"approve", "accept", "decline", "decide"}, nil},
	{boundaryAssistantApproval, "assistant_settings", "op", []string{"accept", "decline", "approve"}, nil},
	{boundaryAssistantApproval, "assistant_channels", "op", []string{"accept", "decline", "approve"}, nil},
	// The issues tool takes no such op; these refuse them by name, whatever
	// tool later carries them. Its own ops (create, draft, comment, retry) stay open.
	{boundaryIssueAcceptance, "issues", "op", []string{"accept", "abandon", "cancel", "verify", "verdict"}, nil},
	{boundaryIssueDecision, "issues", "op", []string{"confirm", "start", "discard", "answer"}, nil},
	{boundaryStop, "assistant_settings", "op", []string{"stop", "resume"}, nil},
	{boundaryMembership, "update_workspace", "", nil, []string{"members", "sharing"}},
	{boundaryPassword, "assistant_settings", "op", []string{"password"}, nil},
	{boundaryPairing, "connector_instances", "action", []string{"pair"}, nil},
}

// mcpPersonOnly refuses an agent's call of a person-only operation, whatever its role.
func mcpPersonOnly(actor Actor, name string, args map[string]json.RawMessage) error {
	if !actor.Agent() {
		return nil
	}
	for _, operation := range personOnlyOperations {
		if operation.matches(name, args) {
			return personOnlyRefusal(operation.boundary)
		}
	}
	return nil
}

func (operation personOnlyOperation) matches(name string, args map[string]json.RawMessage) bool {
	if operation.tool != name {
		return false
	}
	if operation.field != "" && !slices.Contains(operation.values, mcpArgString(args, operation.field)) {
		return false
	}
	if len(operation.arguments) > 0 && !slices.ContainsFunc(operation.arguments, func(argument string) bool {
		return mcpArgPresent(args, argument)
	}) {
		return false
	}
	return true
}

// mcpArgPresent is whether a call sends a value for the argument (not null,
// false or an empty string).
func mcpArgPresent(args map[string]json.RawMessage, key string) bool {
	raw, ok := args[key]
	if !ok {
		return false
	}
	value := strings.TrimSpace(string(raw))
	return value != "" && value != "null" && value != "false" && value != `""`
}

// personOnlyRefusal is the answer an agent gets for a person-only boundary.
func personOnlyRefusal(boundary string) error {
	return &statusError{http.StatusForbidden, fmt.Errorf("%s is the person's to do: agents do not do it through Foundry; the person does it in Foundry", boundary)}
}
