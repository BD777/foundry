package sqlitestore

import (
	"context"
	"encoding/json"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
	"strings"
	"testing"
)

func TestEvidenceContractConfirmationAndAmendment(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_evidence", SourceInput: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	if len(issue.AcceptanceCriteria) != 0 || len(issue.Skills) != 0 || issue.InferredTask != "" || issue.ContractState != "draft" {
		t.Fatalf("invented contract: %+v", issue)
	}
	if _, err = db.ClaimNextIssue(ctx, "dev", "ws_evidence"); err == nil {
		t.Fatal("claimed unconfirmed issue")
	}
	if _, err = db.StartIssueRun(ctx, issue.ID, store.Run{ID: "unconfirmed"}); err == nil {
		t.Fatal("worker bypassed confirmation")
	}
	draft, err := db.contractByRevision(ctx, issue.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	actor := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	if _, err = db.ConfirmContract(ctx, issue.ID, 1, draft.ContentDigest, actor, "empty"); err == nil {
		t.Fatal("empty contract confirmed")
	}
	testfixture.ConfirmContract(t, db, issue.ID)
	current, _ := db.GetIssue(ctx, issue.ID)
	confirmed, _ := db.contractByRevision(ctx, issue.ID, *current.CurrentContractRevision)
	base := confirmed.Revision
	reason := "Change the required output"
	input := store.ContractDraftInput{BaseRevision: &base, Content: store.ContractContentOf(confirmed), ChangeReason: &reason}
	input.Content.Criteria[0].Statement = "The output includes the revised content"
	changed, err := db.CreateContract(ctx, issue.ID, input, actor, "revision")
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := db.CreateContract(ctx, issue.ID, input, actor, "revision")
	if err != nil || replayed.ID != changed.ID {
		t.Fatal("idempotent draft replay failed")
	}
	input.Content.Goal.Text = "different"
	if _, err = db.CreateContract(ctx, issue.ID, input, actor, "revision"); err == nil {
		t.Fatal("same key different content accepted")
	}
	if _, err = db.ClaimNextIssue(ctx, "dev", "ws_evidence"); err == nil {
		t.Fatal("amendment did not pause claim")
	}
	if _, err = db.ConfirmContract(ctx, issue.ID, changed.Revision, "sha256:"+strings.Repeat("0", 64), actor, "wrong"); err == nil {
		t.Fatal("wrong digest confirmed")
	}
	if _, err = db.ConfirmContract(ctx, issue.ID, changed.Revision, changed.ContentDigest, store.ActorRef{Kind: "daemon", ID: "dev"}, "forged"); err == nil {
		t.Fatal("daemon confirmed contract")
	}
	if _, err = db.DiscardContract(ctx, issue.ID, changed.Revision, "Keep original scope", actor, "discard"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ClaimNextIssue(ctx, "dev", "ws_evidence"); err != nil {
		t.Fatal(err)
	}
	raw, err := db.ListEvidenceRecords(ctx, issue.ID, "audit")
	if err != nil || len(raw) < 3 {
		t.Fatal("audit history missing")
	}
	var event store.AuditEvent
	if json.Unmarshal(raw[0], &event) != nil || event.Action != "contract_discarded" {
		t.Fatal("wrong audit")
	}
}
