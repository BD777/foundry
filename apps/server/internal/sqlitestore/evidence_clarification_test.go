package sqlitestore

import (
	"context"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestClarificationPreservesHumanConfirmationBoundary(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_clarify", SourceInput: "hi", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	draft, err := db.contractByRevision(ctx, issue.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	now := evidenceNow()
	raw := store.Material{SchemaVersion: 1, ID: "clarifier_raw", WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, CreatedAt: now, CreatedBy: store.ActorRef{Kind: "daemon", ID: "worker", DisplayName: "Worker"}, Name: "Raw", Carrier: "text_log", MimeType: "text/plain", ByteSize: 3, Digest: evidenceDigest("raw"), StorageDeviceID: "worker", CapturedAt: now, Redaction: store.MaterialRedaction{Status: "none"}, PreviewMaterialIDs: []string{}, Availability: "available", AvailabilityCheckedAt: now}
	if err = db.RegisterMaterial(ctx, issue.ID, raw); err != nil {
		t.Fatal(err)
	}
	reply := store.ClarificationResponse{Message: "What observable result should the Issue deliver?", RawOutputMaterialID: raw.ID}
	current, err := db.RecordClarification(ctx, issue.ID, 1, draft.ContentDigest, "Help define this", "Clarify the target", reply, owner, "question")
	if err != nil {
		t.Fatal(err)
	}
	if current.Status != "blocked" || current.CurrentContractRevision != nil || len(current.Messages) != 2 {
		t.Fatal("clarification launched execution or lost dialogue")
	}
	if _, err = db.ClaimNextIssue(ctx, "worker", issue.WorkspaceID); err == nil {
		t.Fatal("claimed unconfirmed clarification")
	}
	content := store.ContractContentOf(draft)
	_, criterion := reviewFixture()
	criterion.Title = "Valid HTTP responses"
	criterion.Statement = "Valid input returns 200 and invalid input returns 400"
	criterion.ProofKind = "functional"
	criterion.Rubric = store.RichContent{Text: "Compare actual request and response", Media: []store.ReferenceMedia{}}
	criterion.EvidenceRequirements[0].Description = "Actual HTTP exchange"
	content.Goal.Text = "Fix API validation"
	content.Criteria = []store.AcceptanceCriterion{criterion}
	reply.ProposedContent = &content
	reply.Message = "The proposed contract is ready for your review, not confirmed."
	current, err = db.RecordClarification(ctx, issue.ID, 1, draft.ContentDigest, "Valid 200; invalid 400", "Specify status behavior", reply, owner, "proposal")
	if err != nil {
		t.Fatal(err)
	}
	proposal, err := db.contractByRevision(ctx, issue.ID, *current.DraftContractRevision)
	if err != nil {
		t.Fatal(err)
	}
	if proposal.Origin != "agent_proposal" || proposal.CreatedBy.Kind != "agent" || proposal.Confirmation != nil || current.CurrentContractRevision != nil {
		t.Fatal("proposal impersonated human confirmation")
	}
	same := store.ContractContentOf(proposal)
	noChange := store.ClarificationResponse{Message: "继续不等于确认，请核对已保存草案。", ProposedContent: &same, RawOutputMaterialID: raw.ID}
	unchanged, err := db.RecordClarification(ctx, issue.ID, proposal.Revision, proposal.ContentDigest, "继续", "继续讨论", noChange, owner, "no-change")
	if err != nil || *unchanged.DraftContractRevision != proposal.Revision || unchanged.CurrentContractRevision != nil {
		t.Fatal("identical proposal created a revision or confirmed", err)
	}
	replayed, found, err := db.ReplayClarification(ctx, issue.ID, 1, draft.ContentDigest, "Valid 200; invalid 400", "Specify status behavior", owner, "proposal")
	if err != nil || !found || len(replayed.Messages) != 4 {
		t.Fatal("clarification replay failed", err)
	}
	if _, _, err = db.ReplayClarification(ctx, issue.ID, 1, draft.ContentDigest, "Continue", "Specify status behavior", owner, "proposal"); err == nil {
		t.Fatal("changed clarification replay accepted")
	}
	for _, kind := range []string{"agent", "daemon"} {
		if _, err = db.ConfirmContract(ctx, issue.ID, proposal.Revision, proposal.ContentDigest, store.ActorRef{Kind: kind, ID: kind}, "confirm-"+kind); err == nil {
			t.Fatalf("%s confirmed its own proposal", kind)
		}
	}
	confirmed, err := db.ConfirmContract(ctx, issue.ID, proposal.Revision, proposal.ContentDigest, owner, "user-confirms")
	if err != nil || confirmed.Status != "confirmed" {
		t.Fatal("user could not confirm exact proposal", err)
	}
	reason := "用户要求讨论新的完成标准"
	base := confirmed.Revision
	amendment, err := db.CreateContract(ctx, issue.ID, store.ContractDraftInput{BaseRevision: &base, Content: store.ContractContentOf(confirmed), ChangeReason: &reason}, owner, "begin-amendment")
	if err != nil {
		t.Fatal(err)
	}
	content.Goal.Text = "Fix validation and explain errors"
	current, err = db.RecordClarification(ctx, issue.ID, amendment.Revision, amendment.ContentDigest, "建议加上错误说明", reason, reply, owner, "amendment-proposal")
	if err != nil || current.CurrentContractRevision == nil || *current.CurrentContractRevision != confirmed.Revision {
		t.Fatal("Agent proposal replaced effective standard before user approval", err)
	}
	next, err := db.contractByRevision(ctx, issue.ID, *current.DraftContractRevision)
	if err != nil || next.CreatedBy.Kind != "agent" || next.Confirmation != nil {
		t.Fatal("amendment was not an unconfirmed Agent proposal", err)
	}
	if _, err = db.ConfirmContract(ctx, issue.ID, next.Revision, next.ContentDigest, owner, "user-confirms-amendment"); err != nil {
		t.Fatal(err)
	}
	current, err = db.GetIssue(ctx, issue.ID)
	if err != nil || *current.CurrentContractRevision != next.Revision {
		t.Fatal("user confirmation did not activate new standard", err)
	}
}

func TestConfirmingRevisedStandardSendsVerifyingIssueBackToImplementation(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_revise", SourceInput: "fix pricing", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	draft, err := db.contractByRevision(ctx, issue.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	_, criterion := reviewFixture()
	criterion.Title = "Discount is clamped"
	criterion.Statement = "applyDiscount returns 0 above 100 percent"
	criterion.ProofKind = "functional"
	criterion.Rubric = store.RichContent{Text: "Read the delivered file and run the tests", Media: []store.ReferenceMedia{}}
	criterion.EvidenceRequirements[0].Description = "Delivered source file"
	content := store.ContractContentOf(draft)
	content.Goal.Text = "Clamp the discount"
	content.Criteria = []store.AcceptanceCriterion{criterion}
	firstBase := draft.Revision
	firstReason := "用户确认第一版标准"
	first, err := db.CreateContract(ctx, issue.ID, store.ContractDraftInput{BaseRevision: &firstBase, Content: content, ChangeReason: &firstReason}, owner, "first-draft")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ConfirmContract(ctx, issue.ID, first.Revision, first.ContentDigest, owner, "confirm-first"); err != nil {
		t.Fatal(err)
	}
	current, err := db.GetIssue(ctx, issue.ID)
	if err != nil {
		t.Fatal(err)
	}
	// The implementation ran and the Issue now waits for acceptance.
	current.Status = "verifying"
	current.Run = &store.Run{ID: "run_1", IssueID: issue.ID, WorkspaceID: current.WorkspaceID, Status: "completed", Runtime: "claude"}
	if err = db.saveIssue(ctx, current, time.Time{}, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	base := first.Revision
	reason := "固定检查器无法运行，改为独立 Agent 检查"
	revised := store.ContractContentOf(first)
	revised.Criteria[0].Statement = "applyDiscount returns 0 at and above 100 percent"
	amendment, err := db.CreateContract(ctx, issue.ID, store.ContractDraftInput{BaseRevision: &base, Content: revised, ChangeReason: &reason}, owner, "amend")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ConfirmContract(ctx, issue.ID, amendment.Revision, amendment.ContentDigest, owner, "confirm-amendment"); err != nil {
		t.Fatal(err)
	}
	current, err = db.GetIssue(ctx, issue.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.Status != "pending" {
		t.Fatalf("a revised standard left the Issue waiting on a stale candidate: %s", current.Status)
	}
	claimed, err := db.ClaimNextIssue(ctx, "worker", issue.WorkspaceID)
	if err != nil || claimed.ID != issue.ID || *claimed.CurrentContractRevision != amendment.Revision {
		t.Fatal("worker could not implement the revised standard", err)
	}
}

func TestConfirmationRejectsDeterministicCriterionWithoutChecker(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	owner := store.ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_checker", SourceInput: "fix pricing", Runtime: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	draft, err := db.contractByRevision(ctx, issue.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	_, criterion := reviewFixture()
	criterion.Title = "Tests pass"
	criterion.Statement = "node --test reports every case passing"
	criterion.ProofKind = "functional"
	criterion.Rubric = store.RichContent{Text: "Run the project test command", Media: []store.ReferenceMedia{}}
	criterion.EvaluationMode = "deterministic"
	criterion.EvidenceRequirements[0].Description = "Test report"
	content := store.ContractContentOf(draft)
	content.Goal.Text = "Clamp the discount"
	content.Criteria = []store.AcceptanceCriterion{criterion}
	unrunnableBase := draft.Revision
	unrunnableReason := "改为固定检查器"
	unrunnable, err := db.CreateContract(ctx, issue.ID, store.ContractDraftInput{BaseRevision: &unrunnableBase, Content: content, ChangeReason: &unrunnableReason}, owner, "draft-unrunnable")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ConfirmContract(ctx, issue.ID, unrunnable.Revision, unrunnable.ContentDigest, owner, "confirm-unrunnable"); err == nil {
		t.Fatal("confirmed a criterion no checker can ever run")
	}
}
