package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// channelsReply is one assistant_channels answer.
type channelsReply struct {
	text   string
	failed bool
}

func (r channelsReply) decode(t *testing.T) map[string]any {
	t.Helper()
	var answer map[string]any
	if err := json.Unmarshal([]byte(r.text), &answer); err != nil {
		t.Fatalf("answer is not JSON: %q (%v)", r.text, err)
	}
	return answer
}

func (f assistantFixture) channelsCall(t *testing.T, args map[string]any) channelsReply {
	t.Helper()
	text, failed := f.tool(t, f.token, "assistant_channels", args)
	return channelsReply{text: text, failed: failed}
}

// seedAssistantChannel stores one channel of the assistant, without going
// through the save route (its source account is not set up in these tests).
func seedAssistantChannel(t *testing.T, f assistantFixture, id, name string, enabled bool) {
	t.Helper()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	record := store.MessageChannelRecord{UserID: f.aliceID, MessageChannel: store.MessageChannel{
		ID: id, AssistantID: agent.ID, Name: name, Enabled: enabled, SessionKey: "conversation",
		Source: store.MessageChannelSource{Kind: "openlark", AccountID: "xacc_" + id},
		Guide:  "answer briefly", CreatedAt: "2026-11-18T00:00:00Z", UpdatedAt: "2026-11-18T00:00:00Z",
	}}
	if err := f.server.store.(store.MessageChannelStore).SaveMessageChannel(context.Background(), record); err != nil {
		t.Fatal(err)
	}
}

// useStoredChannelSaves replaces the save with one that writes the channel
// straight to the store. The real save checks the connector source, which
// these tests do not set up; message_channels_test.go covers those checks.
func (f assistantFixture) useStoredChannelSaves(t *testing.T) *int {
	t.Helper()
	saves := new(int)
	f.server.assistant.SaveChannel = func(ctx context.Context, agent store.PersonalAgent, id string, input store.MessageChannelInput, resumeFromNow bool) (store.MessageChannelView, error) {
		*saves++
		st := f.server.store.(store.MessageChannelStore)
		record, err := st.GetMessageChannel(ctx, id)
		if err != nil {
			return store.MessageChannelView{}, err
		}
		record.Name, record.Enabled, record.Guide = input.Name, input.Enabled, input.Guide
		if err := st.SaveMessageChannel(ctx, record); err != nil {
			return store.MessageChannelView{}, err
		}
		return store.MessageChannelView{Channel: record.MessageChannel}, nil
	}
	return saves
}

func channelEnabledInStore(t *testing.T, f assistantFixture, id string) bool {
	t.Helper()
	record, err := f.server.store.(store.MessageChannelStore).GetMessageChannel(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return record.Enabled
}

func channelNameInStore(t *testing.T, f assistantFixture, id string) string {
	t.Helper()
	record, err := f.server.store.(store.MessageChannelStore).GetMessageChannel(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return record.Name
}

// assistant_channels is the assistant's tool: a helper and a chat elsewhere
// do not list it or call it, and the Issue roles are refused.
func TestAssistantChannelsIsListedOnlyForTheAssistant(t *testing.T) {
	f := newAssistantFixture(t)
	if !slices.Contains(f.listedTools(t, f.token), "assistant_channels") {
		t.Fatalf("the assistant does not list assistant_channels")
	}
	child := f.startSession(t, "ws_alice", f.conversation.ID, "a helper")
	elsewhere := f.startSession(t, "ws_alice", "", "a chat in a project")
	for label, token := range map[string]string{"its helper": f.mint(t, child.ID), "a chat elsewhere": f.mint(t, elsewhere.ID)} {
		if slices.Contains(f.listedTools(t, token), "assistant_channels") {
			t.Errorf("%s lists assistant_channels", label)
		}
		if text, failed := f.tool(t, token, "assistant_channels", map[string]any{"op": "list"}); !failed {
			t.Errorf("%s read the assistant's channels: %s", label, text)
		}
	}
	for _, role := range []string{store.AgentSessionRoleIssueExecution, store.AgentSessionRoleIssueClarification} {
		if err := mcpToolAllowed(role, false, "assistant_channels"); err == nil {
			t.Errorf("role %s may call assistant_channels", role)
		}
	}
}

// Reads answer without changing anything: list, peers (which need a source)
// and test (which tries rules on samples only).
func TestAssistantChannelsReadsAnswer(t *testing.T) {
	f := newAssistantFixture(t)
	seedAssistantChannel(t, f, "mch_read", "Reading", true)
	list := f.channelsCall(t, map[string]any{"op": "list"})
	if list.failed {
		t.Fatalf("list failed: %s", list.text)
	}
	channels, _ := list.decode(t)["channels"].([]any)
	if len(channels) != 1 {
		t.Fatalf("list has %d channels: %s", len(channels), list.text)
	}
	if reply := f.channelsCall(t, map[string]any{"op": "peers"}); !reply.failed {
		t.Errorf("peers without accountId answered: %s", reply.text)
	}
	if reply := f.channelsCall(t, map[string]any{"op": "peers", "accountId": "xacc_read"}); reply.failed {
		t.Errorf("peers failed: %s", reply.text)
	}
	tested := f.channelsCall(t, map[string]any{"op": "test", "filters": map[string]any{"rules": []any{
		map[string]any{"id": "group", "enabled": true, "conversationKinds": []string{"group"}},
	}}, "samples": []any{map[string]any{"text": "hi", "conversationKind": "group"}}})
	if tested.failed {
		t.Fatalf("test failed: %s", tested.text)
	}
	if verdicts, _ := tested.decode(t)["verdicts"].([]any); len(verdicts) != 1 {
		t.Errorf("test answered %d verdicts, want 1: %s", len(verdicts), tested.text)
	}
	if reply := f.channelsCall(t, map[string]any{"op": "frobnicate"}); !reply.failed {
		t.Errorf("an unknown op answered: %s", reply.text)
	}
}

// Pausing a channel applies at once and is audited with the value it replaced.
// Undo would enable it again, which widens reach: it waits for the person.
func TestAssistantChannelsPauseIsImmediateAndUndoWaitsForThePerson(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	seedAssistantChannel(t, f, "mch_pause", "Pause me", true)
	f.useStoredChannelSaves(t)

	paused := f.channelsCall(t, map[string]any{"op": "update", "channelId": "mch_pause", "patch": map[string]any{"enabled": false}})
	if paused.failed {
		t.Fatalf("pause failed: %s", paused.text)
	}
	answer := paused.decode(t)
	actionID, _ := answer["actionId"].(string)
	if answer["status"] != "applied" || actionID == "" {
		t.Fatalf("pause did not apply at once: %s", paused.text)
	}
	if channelEnabledInStore(t, f, "mch_pause") {
		t.Fatalf("the channel is still enabled after the pause")
	}
	record, raw, err := f.server.store.GetPersonalAgentAction(ctx, agent.ID, actionID)
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Before map[string]json.RawMessage `json:"before"`
		Class  string                     `json:"class"`
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}
	if record.Tool != "assistant_channels" || record.Outcome != store.PersonalAgentOutcomeApplied || spec.Class != "immediate" || string(spec.Before["enabled"]) != "true" {
		t.Fatalf("audit row = %+v spec = %s", record, raw)
	}

	undo := f.channelsCall(t, map[string]any{"op": "update", "undo": actionID})
	if undo.failed {
		t.Fatalf("undo request failed: %s", undo.text)
	}
	undone := undo.decode(t)
	if undone["status"] != store.PersonalAgentNeedsConfirmationStatus {
		t.Fatalf("undo of a pause should wait for the person: %s", undo.text)
	}
	if channelEnabledInStore(t, f, "mch_pause") {
		t.Fatalf("undo enabled the channel before the person accepted")
	}
	proposalID, _ := undone["proposalId"].(string)
	accepted := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/personal-agent/proposals/"+proposalID+"/accept", ""))
	expectStatus(t, accepted, http.StatusOK, "accept the enable")
	if !channelEnabledInStore(t, f, "mch_pause") {
		t.Fatalf("the accepted proposal did not enable the channel")
	}
}

// A rename is immediate; undo reverts it only while the name is still the one it set.
func TestAssistantChannelsUndoIsRefusedAfterTheFieldChanged(t *testing.T) {
	f := newAssistantFixture(t)
	seedAssistantChannel(t, f, "mch_rename", "Old", true)
	f.useStoredChannelSaves(t)

	first := f.channelsCall(t, map[string]any{"op": "update", "channelId": "mch_rename", "patch": map[string]any{"name": "New"}})
	second := f.channelsCall(t, map[string]any{"op": "update", "channelId": "mch_rename", "patch": map[string]any{"name": "Newer"}})
	firstID, _ := first.decode(t)["actionId"].(string)
	secondID, _ := second.decode(t)["actionId"].(string)
	if firstID == "" || secondID == "" {
		t.Fatalf("renames did not apply: %s / %s", first.text, second.text)
	}
	if reply := f.channelsCall(t, map[string]any{"op": "update", "undo": firstID}); !reply.failed {
		t.Fatalf("undo of a rename the name has since moved past was answered: %s", reply.text)
	}
	if name := channelNameInStore(t, f, "mch_rename"); name != "Newer" {
		t.Fatalf("a refused undo changed the name to %q", name)
	}
	if reply := f.channelsCall(t, map[string]any{"op": "update", "undo": secondID}); reply.failed {
		t.Fatalf("undo of the latest rename failed: %s", reply.text)
	}
	if name := channelNameInStore(t, f, "mch_rename"); name != "New" {
		t.Fatalf("undo restored %q, want New", name)
	}
}

// Widening a channel and creating one wait for the person: nothing is saved
// until the card is accepted.
func TestAssistantChannelsWideningAndCreatingWaitForThePerson(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	seedAssistantChannel(t, f, "mch_wide", "Wide", false)
	saves := f.useStoredChannelSaves(t)

	created := f.channelsCall(t, map[string]any{"op": "create", "channel": map[string]any{
		"name": "Ops", "enabled": true, "source": map[string]any{"accountId": "xacc_ops"}}})
	if created.failed || created.decode(t)["status"] != store.PersonalAgentNeedsConfirmationStatus {
		t.Fatalf("create did not wait for the person: %s", created.text)
	}
	enable := f.channelsCall(t, map[string]any{"op": "update", "channelId": "mch_wide", "patch": map[string]any{"enabled": true}})
	if enable.failed || enable.decode(t)["status"] != store.PersonalAgentNeedsConfirmationStatus {
		t.Fatalf("enabling a channel did not wait for the person: %s", enable.text)
	}
	if *saves != 0 || channelEnabledInStore(t, f, "mch_wide") {
		t.Fatalf("a proposal saved %d times before the person accepted", *saves)
	}
	pending, err := f.server.store.ListPersonalAgentProposals(ctx, agent.ID, []string{store.PersonalAgentProposalPending})
	if err != nil {
		t.Fatal(err)
	}
	kinds := []string{}
	for _, proposal := range pending {
		kinds = append(kinds, proposal.Kind)
	}
	if !slices.Contains(kinds, store.PersonalAgentProposalChannel) || len(kinds) < 2 {
		t.Fatalf("pending proposals = %v, want two channel_change", kinds)
	}
}

// A patch mixing an immediate and a proposal field, an unknown field or no
// field changes nothing and says why.
func TestAssistantChannelsRefusesMixedUnknownAndEmptyPatches(t *testing.T) {
	f := newAssistantFixture(t)
	seedAssistantChannel(t, f, "mch_mixed", "Mixed", true)
	saves := f.useStoredChannelSaves(t)
	for label, patch := range map[string]map[string]any{
		"mixed":   {"enabled": false, "guide": "new principles"},
		"unknown": {"owner": "someone"},
		"empty":   {},
	} {
		if reply := f.channelsCall(t, map[string]any{"op": "update", "channelId": "mch_mixed", "patch": patch}); !reply.failed {
			t.Errorf("%s patch answered: %s", label, reply.text)
		}
	}
	if *saves != 0 || !channelEnabledInStore(t, f, "mch_mixed") {
		t.Fatalf("a refused patch saved %d times", *saves)
	}
}

// grant-source stays the person's: the gate refuses it before the tool runs.
func TestAssistantChannelsRefusesGrantSource(t *testing.T) {
	f := newAssistantFixture(t)
	reply := f.channelsCall(t, map[string]any{"op": "grant-source", "accountId": "xacc_any"})
	if !reply.failed || !strings.Contains(reply.text, "granting a source") {
		t.Fatalf("grant-source was not refused as the person's: %s", reply.text)
	}
}

// A stopped assistant changes no channel.
func TestAssistantChannelsRefusesWhileStopped(t *testing.T) {
	f := newAssistantFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	seedAssistantChannel(t, f, "mch_stop", "Stop", true)
	saves := f.useStoredChannelSaves(t)
	if _, err := f.server.store.SetPersonalAgentState(ctx, agent.ID, store.PersonalAgentStopped); err != nil {
		t.Fatal(err)
	}
	if reply := f.channelsCall(t, map[string]any{"op": "update", "channelId": "mch_stop", "patch": map[string]any{"enabled": false}}); !reply.failed {
		t.Fatalf("a stopped assistant paused a channel: %s", reply.text)
	}
	if *saves != 0 || !channelEnabledInStore(t, f, "mch_stop") {
		t.Fatalf("a stopped assistant saved the channel")
	}
}
