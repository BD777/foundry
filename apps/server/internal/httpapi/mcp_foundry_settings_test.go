package httpapi

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// foundryChatToken is the token of a chat of the person's: a session with no
// role, the kind foundry_settings serves. dev_alice is paired to the person,
// so the device tools see it as theirs.
func (f assistantFixture) foundryChatToken(t *testing.T) string {
	t.Helper()
	f.pairDevice(t, "dev_alice")
	chat := f.startSession(t, "ws_alice", "", "a chat in a project")
	return f.mint(t, chat.ID)
}

// pairDevice gives a device an identity owned by the person, as redeeming a
// pairing token the person issued does (store.PairDevice).
func (f assistantFixture) pairDevice(t *testing.T, deviceID string) {
	t.Helper()
	ctx := context.Background()
	const pairingToken, credential = "foundry-settings-pairing-token", "foundry-settings-device-credential"
	if err := f.server.store.CreateDevicePairingToken(ctx, accounts.HashToken(pairingToken), f.aliceID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.store.PairDevice(ctx, store.PairDeviceInput{
		TokenHash: accounts.HashToken(pairingToken), RequestedDeviceID: deviceID, CredentialHash: accounts.HashToken(credential),
		Now: time.Now().UTC(), WorkerFingerprint: "fingerprint-" + deviceID,
	}); err != nil {
		t.Fatal(err)
	}
}

// foundryCall runs foundry_settings and decodes a successful answer.
func (f assistantFixture) foundryCall(t *testing.T, token string, args map[string]any) (map[string]any, string, bool) {
	t.Helper()
	text, failed := f.tool(t, token, "foundry_settings", args)
	var answer map[string]any
	if !failed {
		if err := json.Unmarshal([]byte(text), &answer); err != nil {
			t.Fatalf("answer is not JSON: %q (%v)", text, err)
		}
	}
	return answer, text, failed
}

// foundryActions are the foundry_settings rows of the person's assistant's log.
func (f assistantFixture) foundryActions(t *testing.T) []store.PersonalAgentActionRecord {
	t.Helper()
	ctx := context.Background()
	agent, err := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	records, err := f.server.store.ListPersonalAgentActions(ctx, agent.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	var mine []store.PersonalAgentActionRecord
	for _, record := range records {
		if record.Tool == "foundry_settings" {
			mine = append(mine, record)
		}
	}
	return mine
}

// deviceLabel reads a device's name straight from the store.
func (f assistantFixture) deviceLabel(t *testing.T, deviceID string) string {
	t.Helper()
	devices, err := f.server.store.ListDevices(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, device := range devices {
		if device.ID == deviceID {
			return device.Label
		}
	}
	t.Fatalf("device %s not found", deviceID)
	return ""
}

// seedWorkerGroup saves one worker group of the person's, over an API endpoint
// of theirs (a group's members must be providers the person has), and returns
// its id.
func (f assistantFixture) seedWorkerGroup(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	provider, err := f.server.store.SaveProfile(ctx, store.SaveProfileInput{
		ID: "provider_fast", Runtime: "claude", Label: "Fast relay", AuthMode: "custom", ConnectionType: "anthropic_compatible",
		BaseURL: "https://fast.example", Model: "cheap", Models: []string{"cheap"}, OwnerUserID: f.aliceID,
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	group := store.StoredWorkerGroup{ID: "wgroup_fast", OwnerUserID: f.aliceID, Label: "Fast", CreatedAt: now, UpdatedAt: now,
		Members: []store.WorkerGroupMember{{ProviderKind: store.WorkerGroupMemberProviderKindAPI, ProviderID: provider.ID, Runtime: "claude", Model: "cheap"}}}
	if _, err := f.server.store.SaveWorkerGroup(context.Background(), group); err != nil {
		t.Fatal(err)
	}
	return group.ID
}

func (f assistantFixture) workerGroupMembers(t *testing.T, id string) []store.WorkerGroupMember {
	t.Helper()
	group, err := f.server.store.GetWorkerGroup(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return group.Members
}

func (f assistantFixture) workerGroupLabel(t *testing.T, id string) string {
	t.Helper()
	group, err := f.server.store.GetWorkerGroup(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return group.Label
}

// foundry_settings is for the person's own chats and the sessions they start
// (their helpers included): it is listed and callable there, and refused for
// the assistant, Issue sessions and verifiers.
func TestFoundrySettingsIsListedOnlyForThePersonsOwnSessions(t *testing.T) {
	f := newAssistantFixture(t)
	chat := f.startSession(t, "ws_alice", "", "a chat in a project")
	helper := f.startSession(t, "ws_alice", f.conversation.ID, "a helper")
	for label, token := range map[string]string{"a chat": f.mint(t, chat.ID), "a helper": f.mint(t, helper.ID)} {
		if !slices.Contains(f.listedTools(t, token), "foundry_settings") {
			t.Errorf("%s does not list foundry_settings", label)
		}
	}
	if slices.Contains(f.listedTools(t, f.token), "foundry_settings") {
		t.Errorf("the assistant lists foundry_settings")
	}
	for _, role := range []string{store.AgentSessionRoleIssueExecution, store.AgentSessionRoleIssueClarification, store.AgentSessionRolePersonalAgent} {
		if err := mcpToolAllowed(role, false, "foundry_settings"); err == nil {
			t.Errorf("role %q may call foundry_settings", role)
		}
	}
	if err := mcpToolAllowed("", true, "foundry_settings"); err == nil {
		t.Errorf("a verifier may call foundry_settings")
	}
	if err := mcpToolAllowed("", false, "foundry_settings"); err != nil {
		t.Errorf("a chat may not call foundry_settings: %v", err)
	}
}

// get answers every area, and the devices it answers are the person's own.
func TestFoundrySettingsGetAnswersEachArea(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	groupID := f.seedWorkerGroup(t)
	for _, args := range []map[string]any{
		{"op": "get", "area": "execution"},
		{"op": "get", "area": "workspace_defaults", "workspaceId": "ws_alice"},
		{"op": "get", "area": "worker_groups"},
		{"op": "get", "area": "worker_groups", "id": groupID},
		{"op": "get", "area": "devices"},
	} {
		if _, text, failed := f.foundryCall(t, token, args); failed {
			t.Errorf("get %v failed: %s", args, text)
		}
	}
	answer, text, failed := f.foundryCall(t, token, map[string]any{"op": "get", "area": "devices"})
	if failed {
		t.Fatalf("devices: %s", text)
	}
	ids := []string{}
	for _, item := range answer["devices"].([]any) {
		ids = append(ids, item.(map[string]any)["id"].(string))
	}
	if !slices.Contains(ids, "dev_alice") || slices.Contains(ids, "dev_bob") {
		t.Errorf("devices answered %v: want the person's own dev_alice and not dev_bob", ids)
	}
	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "get", "area": "workspace_defaults", "workspaceId": "ws_missing"}); !failed {
		t.Errorf("a workspace the person cannot see was answered: %s", text)
	}
	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "get", "area": "worker_groups", "id": "wgroup_other"}); !failed {
		t.Errorf("an unknown worker group was answered: %s", text)
	}
}

// A device name changes at once, is audited in the assistant's log with its
// before and after, and undo puts the first name back. A second undo, after
// the field no longer holds what the change set, is refused.
func TestFoundrySettingsRenamesADeviceAuditsItAndUndoesIt(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	before := f.deviceLabel(t, "dev_alice")
	answer, text, failed := f.foundryCall(t, token, map[string]any{"op": "update", "area": "devices", "id": "dev_alice",
		"patch": map[string]any{"name": "Studio Mac"}})
	if failed || answer["status"] != "applied" {
		t.Fatalf("rename: %s", text)
	}
	actionID, _ := answer["actionId"].(string)
	if got := f.deviceLabel(t, "dev_alice"); got != "Studio Mac" {
		t.Fatalf("device name = %q after rename", got)
	}
	actions := f.foundryActions(t)
	if len(actions) != 1 || actions[0].Outcome != store.PersonalAgentOutcomeApplied || actions[0].ID != actionID {
		t.Fatalf("audit rows = %+v, want one applied row %s", actions, actionID)
	}
	if !strings.Contains(actions[0].ArgsSummary, "devices.name") {
		t.Errorf("audit summary %q does not name the field", actions[0].ArgsSummary)
	}
	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "undo", "actionId": actionID}); failed {
		t.Fatalf("undo: %s", text)
	}
	if got := f.deviceLabel(t, "dev_alice"); got != before {
		t.Fatalf("device name = %q after undo, want %q", got, before)
	}
	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "undo", "actionId": actionID}); !failed {
		t.Errorf("a second undo was applied: %s", text)
	}
}

// Labels and worker group labels are immediate fields too: each update is
// undoable and the undo restores the value the change replaced.
func TestFoundrySettingsLabelsAndWorkerGroupLabelAreImmediate(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	groupID := f.seedWorkerGroup(t)
	answer, text, failed := f.foundryCall(t, token, map[string]any{"op": "update", "area": "worker_groups", "id": groupID,
		"patch": map[string]any{"label": "Quick"}})
	if failed {
		t.Fatalf("group label: %s", text)
	}
	if got := f.workerGroupLabel(t, groupID); got != "Quick" {
		t.Fatalf("group label = %q", got)
	}
	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "undo", "actionId": answer["actionId"]}); failed {
		t.Fatalf("undo group label: %s", text)
	}
	if got := f.workerGroupLabel(t, groupID); got != "Fast" {
		t.Fatalf("group label = %q after undo, want Fast", got)
	}
	answer, text, failed = f.foundryCall(t, token, map[string]any{"op": "update", "area": "devices", "id": "dev_alice",
		"patch": map[string]any{"labels": []any{map[string]any{"key": "site", "value": "lab"}}}})
	if failed {
		t.Fatalf("labels: %s", text)
	}
	labelled, _, _ := f.foundryCall(t, token, map[string]any{"op": "get", "area": "devices", "id": "dev_alice"})
	if !strings.Contains(stringify(t, labelled), `"site"`) {
		t.Fatalf("labels not saved: %v", labelled)
	}
	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "undo", "actionId": answer["actionId"]}); failed {
		t.Fatalf("undo labels: %s", text)
	}
	restored, _, _ := f.foundryCall(t, token, map[string]any{"op": "get", "area": "devices", "id": "dev_alice"})
	if strings.Contains(stringify(t, restored), `"site"`) {
		t.Fatalf("labels still hold site after undo: %v", restored)
	}
}

// Execution defaults, workspace agent defaults and worker group members are
// the person's to change: the call is refused, nothing changes, nothing is
// audited. Deleting a worker group is refused by the person-only table.
func TestFoundrySettingsRefusesThePersonsOwnFields(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	groupID := f.seedWorkerGroup(t)
	refusals := []struct {
		args map[string]any
		want string
	}{
		{map[string]any{"op": "update", "area": "execution", "patch": map[string]any{"model": "gpt-x"}}, "changing execution.model"},
		{map[string]any{"op": "update", "area": "workspace_defaults", "workspaceId": "ws_alice", "id": "ws_alice", "patch": map[string]any{"model": "gpt-x"}}, "changing workspace_defaults.model"},
		{map[string]any{"op": "delete", "area": "worker_groups", "id": groupID}, "deleting is the person's to do"},
	}
	for _, refusal := range refusals {
		_, text, failed := f.foundryCall(t, token, refusal.args)
		if !failed || !strings.Contains(text, refusal.want) {
			t.Errorf("%v: want refusal containing %q, got failed=%v %s", refusal.args, refusal.want, failed, text)
		}
	}
	if got := f.workerGroupLabel(t, groupID); got != "Fast" {
		t.Errorf("worker group changed to %q by a refused call", got)
	}
	if n := len(f.foundryActions(t)); n != 0 {
		t.Errorf("%d audit rows for refused calls", n)
	}
}

// Worker group members are changed by worker_groups, which the person's
// sessions already use: update answers with that call and changes nothing.
// Running the answered call saves the members, so the pointer is right.
func TestFoundrySettingsPointsMembersAtWorkerGroups(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	groupID := f.seedWorkerGroup(t)
	members := []any{map[string]any{"providerKind": "api", "providerId": "provider_fast", "runtime": "claude", "model": "cheap"}}
	answer, text, failed := f.foundryCall(t, token, map[string]any{"op": "update", "area": "worker_groups", "id": groupID,
		"patch": map[string]any{"members": members}})
	if failed {
		t.Fatalf("members update: %s", text)
	}
	use, _ := answer["use"].(map[string]any)
	if answer["status"] != "not_applied" || use["tool"] != "worker_groups" {
		t.Fatalf("members update answered %s, want a not_applied pointer to worker_groups", text)
	}
	arguments, _ := use["arguments"].(map[string]any)
	if arguments["action"] != "save" || arguments["id"] != groupID {
		t.Fatalf("pointer arguments = %v", arguments)
	}
	if n := len(f.foundryActions(t)); n != 0 {
		t.Errorf("%d audit rows for a pointer that changed nothing", n)
	}
	if text, failed := f.tool(t, token, "worker_groups", arguments); failed {
		t.Fatalf("the pointed-at worker_groups call failed: %s", text)
	}
	if got := len(f.workerGroupMembers(t, groupID)); got != 1 {
		t.Errorf("group has %d members after the pointed-at call, want 1", got)
	}
}

// One field per call, a named area and id, and a known field: anything else
// is refused before a change is made.
func TestFoundrySettingsNeedsOneFieldPerCall(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	before := f.deviceLabel(t, "dev_alice")
	for _, args := range []map[string]any{
		{"op": "update", "area": "devices", "id": "dev_alice", "patch": map[string]any{"name": "A", "labels": []any{}}},
		{"op": "update", "area": "devices", "patch": map[string]any{"name": "A"}},
		{"op": "update", "area": "devices", "id": "dev_alice", "patch": map[string]any{"colour": "red"}},
		{"op": "update", "area": "devices", "id": "dev_alice"},
		{"op": "get", "area": "unknown"},
	} {
		if _, text, failed := f.foundryCall(t, token, args); !failed {
			t.Errorf("%v was applied: %s", args, text)
		}
	}
	if got := f.deviceLabel(t, "dev_alice"); got != before {
		t.Errorf("device name changed by refused calls: %q", got)
	}
}

// An undo of a change is refused once any later change has set the field.
func TestFoundrySettingsUndoRefusesAfterALaterChange(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	first, text, failed := f.foundryCall(t, token, map[string]any{"op": "update", "area": "devices", "id": "dev_alice",
		"patch": map[string]any{"name": "First"}})
	if failed {
		t.Fatalf("first rename: %s", text)
	}
	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "update", "area": "devices", "id": "dev_alice",
		"patch": map[string]any{"name": "Second"}}); failed {
		t.Fatalf("second rename: %s", text)
	}
	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "undo", "actionId": first["actionId"]}); !failed {
		t.Errorf("undo of the first change overwrote the second: %s", text)
	}
	if got := f.deviceLabel(t, "dev_alice"); got != "Second" {
		t.Errorf("device name = %q, want Second", got)
	}
	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "undo", "actionId": "pa_missing"}); !failed {
		t.Errorf("an unknown action was undone: %s", text)
	}
}

// stringify is a decoded answer as JSON text, for substring checks.
func stringify(t *testing.T, value map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// pair_code needs a Maintainer of the workspace, the person's role read
// uncapped: a Member is refused, and so is a call from an assistant's helper,
// even when the person owns the workspace. Area feishu takes no update, and an
// issued code has no undo.
func TestFoundrySettingsPairCodeIsRefusedToMembersAndHelpers(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	helper := f.startSession(t, "ws_alice", f.conversation.ID, "a helper")
	helperToken := f.mint(t, helper.ID)
	ctx := context.Background()
	if err := f.server.store.SetWorkspaceMember(ctx, "ws_alice", f.aliceID, store.WorkspaceRoleMember, "test"); err != nil {
		t.Fatal(err)
	}

	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "pair_code", "area": "feishu", "workspaceId": "ws_alice"}); !failed || !strings.Contains(text, "Maintainer") {
		t.Errorf("a pairing code for a person who is only a Member: %q (failed %v)", text, failed)
	}
	if err := f.server.store.SetWorkspaceMember(ctx, "ws_alice", f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}
	if _, text, failed := f.foundryCall(t, helperToken, map[string]any{"op": "pair_code", "area": "feishu", "workspaceId": "ws_alice"}); !failed || !strings.Contains(text, "helper") {
		t.Errorf("an assistant's helper issued a pairing code: %q (failed %v)", text, failed)
	}
	for _, args := range []map[string]any{
		{"op": "pair_code", "area": "devices", "workspaceId": "ws_alice"},
		{"op": "pair_code", "area": "feishu"},
		{"op": "get", "area": "feishu"},
		{"op": "update", "area": "feishu", "id": "ws_alice", "patch": map[string]any{"pair_code": "FND-0000"}},
	} {
		if _, text, failed := f.foundryCall(t, token, args); !failed {
			t.Errorf("%v was answered: %s", args, text)
		}
	}
}

// An agent acts for the person who started its session: a chat of a person
// who maintains the workspace gets the code, though the agent's own scope is
// capped at Member everywhere else.
func TestFoundrySettingsPairCodeIsIssuedForAWorkspaceOwnerThroughTheirChat(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	ctx := context.Background()
	db := f.server.store
	app, err := db.CreateExternalProviderApp(ctx, store.ExternalProviderApp{
		Provider: "feishu", OwnerUserID: f.aliceID, Label: "Foundry", ClientID: "cli_foundry",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetWorkspaceFeishuBotApp(ctx, "ws_alice", app.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.SetWorkspaceMember(ctx, "ws_alice", f.aliceID, store.WorkspaceRoleOwner, "test"); err != nil {
		t.Fatal(err)
	}

	answer, text, failed := f.foundryCall(t, token, map[string]any{"op": "pair_code", "area": "feishu", "workspaceId": "ws_alice"})
	if failed {
		t.Fatalf("the owner's chat was refused a pairing code: %s", text)
	}
	if answer["status"] != "issued" || !strings.HasPrefix(answer["pairingCode"].(string), "FND-") {
		t.Errorf("pairing answer = %v, want an issued FND- code", answer)
	}
}

// An issued pairing code is audited and cannot be undone by an agent.
func TestFoundrySettingsUndoRefusesAnIssuedPairingCode(t *testing.T) {
	f := newAssistantFixture(t)
	token := f.foundryChatToken(t)
	ctx := context.Background()
	agent, err := f.server.store.GetPersonalAgent(ctx, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	args, err := json.Marshal(foundryChange{Op: "issue", Area: "feishu", ID: "ws_alice", Field: "pair_code", Class: foundryIssued})
	if err != nil {
		t.Fatal(err)
	}
	saved, err := f.server.store.RecordPersonalAgentAction(ctx, store.PersonalAgentActionRecord{
		UserID: agent.UserID, AssistantID: agent.ID, Tool: "foundry_settings", ArgsSummary: "feishu.pair_code issue",
		Decision: store.PersonalAgentAuto, Outcome: store.PersonalAgentOutcomeApplied,
	}, args)
	if err != nil {
		t.Fatal(err)
	}
	if _, text, failed := f.foundryCall(t, token, map[string]any{"op": "undo", "actionId": saved.ID}); !failed || !strings.Contains(text, "does not undo") {
		t.Errorf("undo of an issued pairing code: %q (failed %v)", text, failed)
	}
}
