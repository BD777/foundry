// Package testfixture supplies explicit confirmed contracts for execution tests.
// Production never infers or auto-confirms these requirements.
package testfixture

import (
	"context"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
)

func ConfirmContract(t *testing.T, st store.EvidenceStore, issueID string) {
	t.Helper()
	ctx := context.Background()
	records, err := st.ListEvidenceRecords(ctx, issueID, "contract")
	if err != nil {
		t.Fatal(err)
	}
	// Execution tests create a new Issue with one initial draft.
	base := len(records)
	reason := "Test explicitly specifies the observable output"
	content := store.ContractContent{Goal: store.RichContent{Text: "Deliver the requested test output", Media: []store.ReferenceMedia{}}, InScope: []string{}, OutOfScope: []string{}, Constraints: []string{}, Criteria: []store.AcceptanceCriterion{{ID: "criterion_output", Title: "Requested output", Statement: "The candidate contains the requested test output", Required: true, ProofKind: "content_completeness", EvaluationMode: "agent", Rubric: store.RichContent{Text: "Inspect candidate output for the requested content", Media: []store.ReferenceMedia{}}, EvidenceRequirements: []store.EvidenceRequirement{{ID: "requirement_output", Description: "Candidate output exported from the sealed snapshot", AcceptedCarriers: []store.CarrierKind{"document"}, MinimumCount: 1, BindingPolicy: "system_observed"}}}}}
	actor := store.ActorRef{Kind: "local_owner", ID: "test_owner", DisplayName: "Test owner"}
	input := store.ContractDraftInput{Content: content}
	if base > 0 {
		input.BaseRevision = &base
		input.ChangeReason = &reason
	}
	draft, err := st.CreateContract(ctx, issueID, input, actor, fmt.Sprintf("test-draft-%d", base))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.ConfirmContract(ctx, issueID, draft.Revision, draft.ContentDigest, actor, fmt.Sprintf("test-confirm-%d", base)); err != nil {
		t.Fatal(err)
	}
}
