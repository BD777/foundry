package sqlitestore

import (
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"testing"
	"time"
)

func reviewFixture() (reviewData, store.AcceptanceCriterion) {
	snapshot := "snap"
	revision := 1
	isolated := true
	c := store.AcceptanceCriterion{ID: "c", Required: true, EvaluationMode: "agent", EvidenceRequirements: []store.EvidenceRequirement{{ID: "r", MinimumCount: 1, AcceptedCarriers: []string{"document"}, BindingPolicy: "system_observed"}}}
	result := &store.VerificationResult{Verdict: "pass", RawOutputMaterialID: "raw", ReportMaterialID: "report"}
	v := store.Verification{ID: "v", Sequence: 1, CriterionID: "c", ContractRevision: 1, VerificationInputID: "input", Mode: "agent", Status: "completed", Executor: store.VerifierIdentity{Kind: "agent", Isolated: &isolated}, EvidenceIDs: []string{"e"}, Result: result}
	data := reviewData{issue: store.Issue{ContractState: "confirmed", CurrentContractRevision: &revision, CurrentCandidateSnapshotID: &snapshot}, contract: store.IssueContract{Revision: 1, ContentDigest: "contract"}, inputs: map[string]store.VerificationInput{"input": {ID: "input", ContractRevision: 1, ContractDigest: "contract", CandidateSnapshotID: snapshot, BindingStatus: "verified"}}, materials: map[string]store.Material{}, evidence: map[string]store.Evidence{"e": {ID: "e", VerificationInputID: "input", CandidateBinding: "system_observed", Source: store.EvidenceSource{Kind: "candidate_export"}, Claims: []store.EvidenceClaim{{CriterionID: "c", RequirementID: "r"}}, Materials: []store.EvidenceMaterialRef{{MaterialID: "doc", Role: "primary"}}, Collection: store.CollectionRecord{InputMaterialID: "params", Outcome: "completed", Completeness: "complete"}}}, verifications: []store.Verification{v}, now: time.Now().UTC()}
	for _, id := range []string{"doc", "params", "raw", "report"} {
		data.materials[id] = store.Material{ID: id, Availability: "available", Carrier: "document", Digest: id, CapturedAt: data.now.Format(time.RFC3339Nano)}
	}
	return data, c
}
func TestReviewLatestFailureDoesNotFallBackToPass(t *testing.T) {
	d, c := reviewFixture()
	entry, blockers := d.criterionReview(c)
	if entry.EffectiveVerdict != "pass" || len(blockers) != 0 {
		t.Fatalf("valid judgment rejected: %+v %+v", entry, blockers)
	}
	newer := d.verifications[0]
	newer.ID = "newer"
	newer.Sequence = 2
	newer.Status = "failed"
	newer.Result = nil
	d.verifications = append([]store.Verification{newer}, d.verifications...)
	entry, blockers = d.criterionReview(c)
	if entry.EffectiveVerdict == "pass" || len(blockers) == 0 || *entry.VerificationID != "newer" {
		t.Fatal("fell back to old pass")
	}
}
func TestReviewHumanAssessmentIsBoundToExactAgentJudgment(t *testing.T) {
	d, c := reviewFixture()
	d.verifications[0].Result.Verdict = "fail"
	d.assessments = []store.HumanAssessment{{ID: "a", VerificationID: "v", VerificationInputID: "input", ContractRevision: 1, Verdict: "pass"}}
	entry, blockers := d.criterionReview(c)
	if entry.Authority != "human" || entry.EffectiveVerdict != "pass" || len(blockers) != 0 {
		t.Fatal("assessment not applied")
	}
	newer := d.verifications[0]
	newer.ID = "v2"
	newer.Sequence = 2
	d.verifications = append([]store.Verification{newer}, d.verifications...)
	entry, _ = d.criterionReview(c)
	if entry.Authority == "human" || entry.EffectiveVerdict != "fail" {
		t.Fatal("old assessment leaked")
	}
	c.EvaluationMode = "deterministic"
	d.verifications = d.verifications[1:]
	entry, _ = d.criterionReview(c)
	if entry.Authority == "human" || entry.EffectiveVerdict != "fail" {
		t.Fatal("human bypassed deterministic failure")
	}
}
func TestReviewBlocksMissingOfflineUnboundAndDuplicateMaterials(t *testing.T) {
	for _, scenario := range []string{"missing", "offline", "unknown", "reference", "duplicate", "expired"} {
		t.Run(scenario, func(t *testing.T) {
			d, c := reviewFixture()
			switch scenario {
			case "missing":
				delete(d.materials, "doc")
			case "offline":
				m := d.materials["doc"]
				m.Availability = "offline"
				d.materials["doc"] = m
			case "unknown":
				v := d.inputs["input"]
				v.BindingStatus = "unknown"
				d.inputs["input"] = v
			case "reference":
				c.Rubric.Media = []store.ReferenceMedia{{MaterialID: "doc", Role: "target"}}
			case "duplicate":
				c.EvidenceRequirements[0].MinimumCount = 2
				e := d.evidence["e"]
				e.Materials = append(e.Materials, store.EvidenceMaterialRef{MaterialID: "doc"})
				d.evidence["e"] = e
			case "expired":
				age := 1
				c.MaxEvidenceAgeSeconds = &age
				m := d.materials["doc"]
				m.CapturedAt = d.now.Add(-time.Minute).Format(time.RFC3339Nano)
				d.materials["doc"] = m
			}
			_, blockers := d.criterionReview(c)
			if len(blockers) == 0 {
				t.Fatal("invalid proof allowed through review")
			}
		})
	}
}
