package httpapi

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// settingsReply is one assistant_settings answer, decoded.
type settingsReply struct {
	text   string
	failed bool
}

func (r settingsReply) decode(t *testing.T) map[string]any {
	t.Helper()
	var answer map[string]any
	if err := json.Unmarshal([]byte(r.text), &answer); err != nil {
		t.Fatalf("answer is not JSON: %q (%v)", r.text, err)
	}
	return answer
}

func (f assistantFixture) settingsCall(t *testing.T, args map[string]any) settingsReply {
	t.Helper()
	text, failed := f.tool(t, f.token, "assistant_settings", args)
	return settingsReply{text: text, failed: failed}
}

// settingsOf reads the assistant's settings straight from the store.
func (f assistantFixture) settingsOf(t *testing.T) store.PersonalAgentSettings {
	t.Helper()
	agent, err := f.server.store.GetPersonalAgent(context.Background(), f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	return agent.Settings
}

// assistant_settings is the assistant's tool: a coding session, a helper and
// a chat elsewhere do not list it or call it, and the gate says so for Issue
// sessions too.
func TestAssistantSettingsIsListedOnlyForTheAssistant(t *testing.T) {
	f := newAssistantFixture(t)
	if !slices.Contains(f.listedTools(t, f.token), "assistant_settings") {
		t.Fatalf("the assistant does not list assistant_settings")
	}
	child := f.startSession(t, "ws_alice", f.conversation.ID, "a helper")
	elsewhere := f.startSession(t, "ws_alice", "", "a chat in a project")
	for label, token := range map[string]string{"its helper": f.mint(t, child.ID), "a chat elsewhere": f.mint(t, elsewhere.ID)} {
		if slices.Contains(f.listedTools(t, token), "assistant_settings") {
			t.Errorf("%s lists assistant_settings", label)
		}
		if text, failed := f.tool(t, token, "assistant_settings", map[string]any{"op": "get"}); !failed {
			t.Errorf("%s read the assistant's settings: %s", label, text)
		}
	}
	for _, role := range []string{store.AgentSessionRoleIssueExecution, store.AgentSessionRoleIssueClarification} {
		if err := mcpToolAllowed(role, false, "assistant_settings"); err == nil {
			t.Errorf("role %s may call assistant_settings", role)
		}
	}
	if err := mcpToolAllowed("", true, "assistant_settings"); err == nil {
		t.Errorf("a verifier may call assistant_settings")
	}
}

// get answers the sections in a small answer, with the revision and the
// classes of the fields it may change.
func TestAssistantSettingsGetAnswersSmallSections(t *testing.T) {
	f := newAssistantFixture(t)
	reply := f.settingsCall(t, map[string]any{"op": "get"})
	if reply.failed || len(reply.text) > 1536 {
		t.Fatalf("get failed or is %d bytes: %s", len(reply.text), reply.text)
	}
	answer := reply.decode(t)
	sections, _ := answer["sections"].(map[string]any)
	for _, name := range []string{"notify", "quietHours", "digest", "interface", "models", "feishu"} {
		if _, ok := sections[name]; !ok {
			t.Errorf("get has no %s section: %v", name, sections)
		}
	}
	classes, _ := answer["classes"].(map[string]any)
	if immediate, _ := classes["immediate"].([]any); !slices.Contains(anyStrings(immediate), "dailyDigest") {
		t.Errorf("immediate classes = %v", classes["immediate"])
	}
	if proposal, _ := classes["proposal"].([]any); !slices.Contains(anyStrings(proposal), "feishuDirectChat") {
		t.Errorf("proposal classes = %v", classes["proposal"])
	}
	if reply := f.settingsCall(t, map[string]any{"op": "get", "sections": []string{"digest"}}); len(reply.decode(t)["sections"].(map[string]any)) != 1 {
		t.Errorf("sections filter did not narrow the answer: %s", reply.text)
	}
	if bad := f.settingsCall(t, map[string]any{"op": "get", "sections": []string{"policy"}}); !bad.failed {
		t.Errorf("an unknown section was answered: %s", bad.text)
	}
}

func anyStrings(values []any) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if text, ok := value.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

// An immediate update applies at once, is audited with its before and after
// values, and undo reverts it to exactly those values.
func TestAssistantSettingsImmediateUpdateIsAuditedAndUndone(t *testing.T) {
	f := newAssistantFixture(t)
	reply := f.settingsCall(t, map[string]any{"op": "update", "patch": map[string]any{"dailyDigest": true, "dailyDigestTime": "08:30"}})
	if reply.failed {
		t.Fatalf("update failed: %s", reply.text)
	}
	applied := reply.decode(t)
	if applied["status"] != "applied" || applied["revision"] != float64(1) {
		t.Fatalf("update answered %v", applied)
	}
	actionID, _ := applied["actionId"].(string)
	if actionID == "" {
		t.Fatalf("update names no actionId: %v", applied)
	}
	settings := f.settingsOf(t)
	if !settings.DailyDigest || settings.DailyDigestTime != "08:30" || settings.Revision != 1 {
		t.Fatalf("settings after update = digest %v at %q, revision %d", settings.DailyDigest, settings.DailyDigestTime, settings.Revision)
	}
	record, args, err := f.server.store.GetPersonalAgentAction(context.Background(), defaultAssistantOf(t, f.server, f.aliceID).ID, actionID)
	if err != nil {
		t.Fatal(err)
	}
	if record.Tool != "update_settings" || record.Outcome != store.PersonalAgentOutcomeApplied {
		t.Fatalf("audit row = %s %s", record.Tool, record.Outcome)
	}
	var audited struct {
		Before map[string]json.RawMessage `json:"before"`
		Class  string                     `json:"class"`
	}
	if err := json.Unmarshal(args, &audited); err != nil {
		t.Fatal(err)
	}
	if string(audited.Before["dailyDigest"]) != "false" || string(audited.Before["dailyDigestTime"]) != `"09:00"` || audited.Class != "immediate" {
		t.Fatalf("audit before = %v class %s", audited.Before, audited.Class)
	}

	undo := f.settingsCall(t, map[string]any{"op": "update", "undo": actionID})
	if undo.failed || undo.decode(t)["status"] != "applied" {
		t.Fatalf("undo failed: %s", undo.text)
	}
	settings = f.settingsOf(t)
	if settings.DailyDigest || settings.DailyDigestTime != "09:00" || settings.Revision != 2 {
		t.Fatalf("settings after undo = digest %v at %q, revision %d", settings.DailyDigest, settings.DailyDigestTime, settings.Revision)
	}
	if again := f.settingsCall(t, map[string]any{"op": "update", "undo": actionID}); !again.failed {
		t.Fatalf("a second undo of the same change applied: %s", again.text)
	}
}

// Undo is refused once any later save moved the revision on, so it cannot
// overwrite a change the person or the assistant made after this one.
func TestAssistantSettingsUndoIsRefusedAfterLaterChanges(t *testing.T) {
	f := newAssistantFixture(t)
	first := f.settingsCall(t, map[string]any{"op": "update", "patch": map[string]any{"homePage": false}}).decode(t)
	actionID := first["actionId"].(string)
	if later := f.settingsCall(t, map[string]any{"op": "update", "patch": map[string]any{"urgentAnytime": false}}); later.failed {
		t.Fatalf("later update failed: %s", later.text)
	}
	if undo := f.settingsCall(t, map[string]any{"op": "update", "undo": actionID}); !undo.failed || !strings.Contains(undo.text, "changed after") {
		t.Fatalf("undo after a later change = %q (failed %v)", undo.text, undo.failed)
	}
	if f.settingsOf(t).HomePage {
		t.Fatalf("the refused undo changed homePage back")
	}
}

// A proposal-class update changes nothing: it creates one pending proposal,
// and accepting that proposal applies the patch.
func TestAssistantSettingsProposalClassCreatesAProposalAndChangesNothing(t *testing.T) {
	f := newAssistantFixture(t)
	reply := f.settingsCall(t, map[string]any{"op": "update", "patch": map[string]any{"assistantModel": "model-x"}})
	if reply.failed {
		t.Fatalf("proposal update failed: %s", reply.text)
	}
	answer := reply.decode(t)
	if answer["status"] != "needs_confirmation" {
		t.Fatalf("proposal update answered %v", answer)
	}
	if got := f.settingsOf(t); got.AssistantModel != "" || got.Revision != 0 {
		t.Fatalf("a proposal changed the settings: model %q revision %d", got.AssistantModel, got.Revision)
	}
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	pending, err := f.server.store.ListPersonalAgentProposals(ctx, agent.ID, []string{store.PersonalAgentProposalPending})
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].Kind != store.PersonalAgentProposalSettings || pending[0].ID != answer["proposalId"] {
		t.Fatalf("pending proposals = %+v, answer %v", pending, answer)
	}
	if _, err := f.server.assistant.DecideProposal(ctx, agent, pending[0].ID, true, "test"); err != nil {
		t.Fatalf("accept: %v", err)
	}
	if got := f.settingsOf(t); got.AssistantModel != "model-x" {
		t.Fatalf("accepting the proposal did not apply it: model %q", got.AssistantModel)
	}
}

// One update is one class, only settings the assistant may change, and a
// patch names something: anything else is refused and changes nothing.
func TestAssistantSettingsRefusesMixedUnknownAndEmptyPatches(t *testing.T) {
	f := newAssistantFixture(t)
	cases := map[string]struct {
		patch map[string]any
		want  string
	}{
		"mixed classes":       {map[string]any{"dailyDigest": true, "assistantModel": "x"}, "separate update"},
		"not the assistant's": {map[string]any{"timezone": "Asia/Tokyo"}, "the person sets it in Settings"},
		"empty":               {map[string]any{}, "names no setting"},
	}
	for label, tc := range cases {
		reply := f.settingsCall(t, map[string]any{"op": "update", "patch": tc.patch})
		if !reply.failed || !strings.Contains(reply.text, tc.want) {
			t.Errorf("%s: answer %q (failed %v), want %q", label, reply.text, reply.failed, tc.want)
		}
	}
	if got := f.settingsOf(t); got.Revision != 0 || got.DailyDigest {
		t.Fatalf("refused patches changed the settings: revision %d digest %v", got.Revision, got.DailyDigest)
	}
}

// A stale expectedRevision is a conflict: nothing is saved.
func TestAssistantSettingsRevisionConflictChangesNothing(t *testing.T) {
	f := newAssistantFixture(t)
	reply := f.settingsCall(t, map[string]any{"op": "update", "expectedRevision": 7, "patch": map[string]any{"dailyDigest": true}})
	if !reply.failed || !strings.Contains(reply.text, "revision 0 now, you read 7") {
		t.Fatalf("stale revision answered %q (failed %v)", reply.text, reply.failed)
	}
	if got := f.settingsOf(t); got.DailyDigest || got.Revision != 0 {
		t.Fatalf("a conflicting update changed the settings: digest %v revision %d", got.DailyDigest, got.Revision)
	}
	fresh := f.settingsCall(t, map[string]any{"op": "update", "expectedRevision": 0, "patch": map[string]any{"dailyDigest": true}})
	if fresh.failed {
		t.Fatalf("the current revision was refused: %s", fresh.text)
	}
}

// Stopping the assistant refuses its updates the way every write is refused.
func TestAssistantSettingsRefusesWhileStopped(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	if _, err := f.server.store.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	if reply := f.settingsCall(t, map[string]any{"op": "update", "patch": map[string]any{"dailyDigest": true}}); !reply.failed {
		t.Fatalf("a stopped assistant updated its settings: %s", reply.text)
	}
	if reply := f.settingsCall(t, map[string]any{"op": "notify_test", "connectorInstanceId": "ext_missing"}); !reply.failed || !strings.Contains(reply.text, "stopped") {
		t.Fatalf("a stopped assistant sent a test notice: %s", reply.text)
	}
}

// Test notices are limited per assistant; the refusal says so, and the
// count restarts once the window has passed.
func TestAssistantSettingsNotifyTestIsRateLimited(t *testing.T) {
	var limiter noticeTestLimiter
	now := time.Now()
	for range noticeTestMax {
		if !limiter.allow("asst_a", now) {
			t.Fatalf("a test notice inside the limit was refused")
		}
	}
	if limiter.allow("asst_a", now.Add(time.Minute)) {
		t.Fatalf("a test notice past the limit was allowed")
	}
	if !limiter.allow("asst_b", now) {
		t.Fatalf("another assistant shares the limit")
	}
	if !limiter.allow("asst_a", now.Add(noticeTestWindow)) {
		t.Fatalf("the limit did not restart after the window")
	}

	f := newAssistantFixture(t)
	for range noticeTestMax {
		f.settingsCall(t, map[string]any{"op": "notify_test", "connectorInstanceId": "ext_missing"})
	}
	if reply := f.settingsCall(t, map[string]any{"op": "notify_test", "connectorInstanceId": "ext_missing"}); !reply.failed || !strings.Contains(reply.text, "at most 3 test notices") {
		t.Fatalf("the fourth test notice was not limited: %s", reply.text)
	}
}

// The MCP answer names the operations it does not know, and the notice
// operations need a connector instance.
func TestAssistantSettingsRejectsUnknownOperations(t *testing.T) {
	f := newAssistantFixture(t)
	if reply := f.settingsCall(t, map[string]any{"op": "reset"}); !reply.failed || !strings.Contains(reply.text, "get, update, notify_instances, notify_find_chat or notify_test") {
		t.Fatalf("unknown op answered %q", reply.text)
	}
	if reply := f.settingsCall(t, map[string]any{"op": "notify_find_chat"}); !reply.failed || !strings.Contains(reply.text, "connectorInstanceId") {
		t.Fatalf("find without an instance answered %q", reply.text)
	}
}

// notify_instances answers where notices can go: the Foundry bot alone, with
// the reason it cannot carry them yet, even beside an extension instance.
func TestAssistantSettingsListsNotifyInstancesWithReasons(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	if _, err := f.server.store.CreateExternalProviderApp(ctx, store.ExternalProviderApp{
		ID: "xapp_stub", Provider: "acme-api", OwnerUserID: f.aliceID, Visibility: store.ExternalAppPersonal,
		Label: "Stub", CreatedVia: "extension", ExtensionData: "{}",
	}); err != nil {
		t.Fatal(err)
	}
	reply := f.settingsCall(t, map[string]any{"op": "notify_instances"})
	if reply.failed {
		t.Fatalf("notify_instances failed: %s", reply.text)
	}
	var answer struct {
		Instances []map[string]any `json:"instances"`
	}
	if err := json.Unmarshal([]byte(reply.text), &answer); err != nil {
		t.Fatalf("answer is not JSON: %q (%v)", reply.text, err)
	}
	if len(answer.Instances) != 1 {
		t.Fatalf("instances = %v, want the Foundry bot alone", answer.Instances)
	}
	if bot := answer.Instances[0]; bot["connectorInstanceId"] != "builtin:feishu" || bot["reason"] != notifyReasonFeishuNotPaired {
		t.Fatalf("the Foundry bot = %v, want reason %q", bot, notifyReasonFeishuNotPaired)
	}
}
