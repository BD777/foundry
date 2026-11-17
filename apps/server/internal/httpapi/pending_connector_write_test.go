package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A connector write outside the grant is a Needs you item (DEV-265), and
// answering it allows the exact recorded request once: a second answer
// replays nothing, and an expired proposal sends nothing.
func TestConnectorWriteProposalIsANeedsYouItemAndReplaysOnce(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	spec, err := json.Marshal(connectors.ConnectorConfirmationSpec{
		AccountID: "xacc_lark", AccountName: "OpenLark", Connector: "openlark",
		Text: "hello", Objects: []permission.GrantObject{{Type: "conversation", ID: "oc_other"}},
		Labels: []gateway.ObjectLabel{{Type: "conversation", ID: "oc_other", Name: "Gao Yibin"}},
		Replay: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	proposal, err := f.db.CreatePersonalAgentProposal(ctx, store.PersonalAgentProposal{
		UserID: f.aliceID, AssistantID: agent.ID, Kind: store.PersonalAgentProposalConnectorWrite,
		WorkspaceID: agent.WorkspaceID, Spec: spec, Summary: "A write outside the grant",
		ExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !f.server.reconcileConnectorWritePending(ctx, f.aliceID, map[string]bool{}) {
		t.Fatal("the proposal has no pending item")
	}
	items, err := f.db.ListPendingItems(ctx, f.aliceID, []string{store.PendingOpen}, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	var found *store.PendingItem
	for index := range items {
		if items[index].Source == store.PendingSourceConnectorWrite {
			found = &items[index]
		}
	}
	if found == nil || found.Key != connectorWritePendingKey(proposal.ID) || found.ConnectorWrite == nil ||
		found.ConnectorWrite.ProposalID != proposal.ID || found.ConnectorWrite.AccountName != "OpenLark" ||
		found.ConnectorWrite.Text != "hello" || found.ConnectorWrite.TargetID != "oc_other" ||
		found.ConnectorWrite.TargetName != "Gao Yibin" || found.ConnectorWrite.Action != "message" {
		t.Fatalf("the connector write's item = %+v", found)
	}

	calls := 0
	f.server.assistant.ConnectorReplay = func(context.Context, store.PersonalAgentProposal) (string, error) {
		calls++
		return "message id om_1", nil
	}
	answered, err := f.server.assistant.DecideProposal(ctx, agent, proposal.ID, true, store.PersonalAgentViaWeb)
	if err != nil || answered.Status != store.PersonalAgentProposalApplied || calls != 1 {
		t.Fatalf("allow = %+v (%v), replays %d", answered, err, calls)
	}
	if _, err := f.server.assistant.DecideProposal(ctx, agent, proposal.ID, true, store.PersonalAgentViaWeb); err == nil {
		t.Fatal("a second answer was accepted")
	}
	if calls != 1 {
		t.Fatalf("a second answer replayed: %d", calls)
	}

	// The proposal settled: the next read closes its item.
	if !f.server.reconcileConnectorWritePending(ctx, f.aliceID, map[string]bool{found.Key: true}) {
		t.Fatal("the settled proposal's item stayed open")
	}

	expired, err := f.db.CreatePersonalAgentProposal(ctx, store.PersonalAgentProposal{
		UserID: f.aliceID, AssistantID: agent.ID, Kind: store.PersonalAgentProposalConnectorWrite,
		WorkspaceID: agent.WorkspaceID, Spec: spec, Summary: "Expired",
		ExpiresAt: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.server.assistant.DecideProposal(ctx, agent, expired.ID, true, store.PersonalAgentViaWeb); err == nil {
		t.Fatal("an expired proposal was accepted")
	}
	if calls != 1 {
		t.Fatalf("an expired proposal replayed: %d", calls)
	}
}

// A non-message write names its operation and shows what it would send; the
// card never makes it guess from a raw body (DEV-265).
func TestGenericConnectorWriteItemNamesTheOperationAndShowsTheBody(t *testing.T) {
	f := newDigestFixture(t)
	ctx := context.Background()
	agent := defaultAssistantOf(t, f.server, f.aliceID)
	spec, err := json.Marshal(connectors.ConnectorConfirmationSpec{
		AccountID: "xacc_lark", AccountName: "OpenLark", Connector: "openlark",
		Method: "POST", Path: "/agent/v1/documents/drive/items",
		Body:      []byte(`{"title":"DEV-265 授权测试（可删）","docType":"docx"}`),
		Operation: "新建云文档", Replay: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	proposal, err := f.db.CreatePersonalAgentProposal(ctx, store.PersonalAgentProposal{
		UserID: f.aliceID, AssistantID: agent.ID, Kind: store.PersonalAgentProposalConnectorWrite,
		WorkspaceID: agent.WorkspaceID, Spec: spec, Summary: "Create a document",
		ExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !f.server.reconcileConnectorWritePending(ctx, f.aliceID, map[string]bool{}) {
		t.Fatal("the proposal has no pending item")
	}
	items, err := f.db.ListPendingItems(ctx, f.aliceID, []string{store.PendingOpen}, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	var found *store.PendingItem
	for index := range items {
		if items[index].Key == connectorWritePendingKey(proposal.ID) {
			found = &items[index]
		}
	}
	if found == nil || found.ConnectorWrite == nil {
		t.Fatalf("the proposal's item = %+v", found)
	}
	detail := found.ConnectorWrite
	if detail.Action != "write" || detail.Operation != "新建云文档" ||
		detail.ExpiresAt != proposal.ExpiresAt ||
		len(detail.Preview) != 2 || detail.Preview[0] != "docType: docx" ||
		detail.Preview[1] != "title: DEV-265 授权测试（可删）" ||
		!strings.Contains(detail.Body, `"title": "DEV-265 授权测试（可删）"`) {
		t.Fatalf("the generic item = %+v", detail)
	}
}
