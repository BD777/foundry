package connectors

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestRiskConfirmationIsAOneUseProposal(t *testing.T) {
	ctx := context.Background()
	db, err := sqlitestore.Open(filepath.Join(t.TempDir(), "foundry.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	agent, err := db.CreatePersonalAgent(ctx, store.PersonalAgent{
		UserID: "alice", WorkspaceID: "ws_pa", HomeDeviceID: "dev_alice",
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	confirmations := &Confirmations{Store: db, ProposalTTL: time.Hour, Now: func() time.Time { return now }}
	request := gateway.ConfirmationRequest{
		Lease: &gateway.Lease{
			Grant: store.FeishuGatewayGrant{
				UserID: "alice", SessionID: "sess_pa", AccountID: "acct_a",
			},
			Session: store.AgentSession{WorkspaceID: agent.WorkspaceID},
			Account: store.ExternalAccount{
				ID: "acct_a", Label: "Work Cloudflare", Provider: "cloudflare",
			},
		},
		Need:        gateway.Need{Risk: "dns_change"},
		Method:      "DELETE",
		Path:        "/zones/zone/dns_records/record",
		BodyDigest:  "body",
		Fingerprint: "fingerprint",
		Summary:     "Delete a DNS record",
	}
	pending, denial := confirmations.Review(ctx, request)
	if denial != nil || pending.Approved || pending.ProposalID == "" || pending.Summary != request.Summary {
		t.Fatalf("pending confirmation = %+v (%+v)", pending, denial)
	}
	proposal, err := db.GetPersonalAgentProposal(ctx, agent.UserID, pending.ProposalID)
	if err != nil || proposal.Kind != store.PersonalAgentProposalConnectorWrite || proposal.Status != store.PersonalAgentProposalPending {
		t.Fatalf("proposal = %+v (%v)", proposal, err)
	}
	var spec ConnectorConfirmationSpec
	if err := json.Unmarshal(proposal.Spec, &spec); err != nil || spec.AccountName != "Work Cloudflare" {
		t.Fatalf("proposal account name = %q (%v)", spec.AccountName, err)
	}
	if _, err := db.SetPersonalAgentProposalStatus(ctx, agent.UserID, proposal.ID,
		[]string{store.PersonalAgentProposalPending}, store.PersonalAgentProposalAccepted, "web", ""); err != nil {
		t.Fatal(err)
	}
	approved, denial := confirmations.Review(ctx, request)
	if denial != nil || !approved.Approved || approved.ProposalID != proposal.ID {
		t.Fatalf("approved confirmation = %+v (%+v)", approved, denial)
	}
	applied, err := db.GetPersonalAgentProposal(ctx, agent.UserID, proposal.ID)
	if err != nil || applied.Status != store.PersonalAgentProposalApplied {
		t.Fatalf("applied proposal = %+v (%v)", applied, err)
	}
	again, denial := confirmations.Review(ctx, request)
	if denial != nil || again.Approved || again.ProposalID == "" || again.ProposalID == proposal.ID {
		t.Fatalf("approval was reusable: %+v (%+v)", again, denial)
	}
}
