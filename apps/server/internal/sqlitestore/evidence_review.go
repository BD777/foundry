package sqlitestore

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func evidenceList[T any](ctx context.Context, s *Store, issueID, kind string) ([]T, error) {
	raws, err := s.ListEvidenceRecords(ctx, issueID, kind)
	if err != nil {
		return nil, err
	}
	result := make([]T, 0, len(raws))
	for _, raw := range raws {
		var value T
		if err = json.Unmarshal(raw, &value); err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, nil
}
func evidenceGet[T any](ctx context.Context, s *Store, issueID, kind, id string) (T, error) {
	var value T
	raw, err := s.GetEvidenceRecord(ctx, issueID, kind, id)
	if err != nil {
		return value, err
	}
	err = json.Unmarshal(raw, &value)
	return value, err
}

type reviewData struct {
	issue         store.Issue
	contract      store.IssueContract
	inputs        map[string]store.VerificationInput
	materials     map[string]store.Material
	evidence      map[string]store.Evidence
	verifications []store.Verification
	assessments   []store.HumanAssessment
	now           time.Time
}

// Live observations are mutable projections; published review packages never are.
type reviewObservation struct {
	ID          string                `json:"id"`
	CandidateID string                `json:"candidateId"`
	Blockers    []store.ReviewBlocker `json:"blockers"`
}

func (s *Store) RecordReviewObservation(ctx context.Context, issueID, candidateID string, blockers []store.ReviewBlocker) error {
	return s.withTx(ctx, func(tx *Store) error {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return err
		}
		if issue.CurrentCandidateSnapshotID == nil || *issue.CurrentCandidateSnapshotID != candidateID {
			return fmt.Errorf("candidate_changed")
		}
		observations, err := evidenceList[reviewObservation](ctx, tx, issue.ID, "review_observation")
		if err != nil {
			return err
		}
		for _, previous := range observations {
			if previous.CandidateID == candidateID {
				previous.Blockers = blockers
				return tx.updateEvidenceProjection(ctx, previous.ID, previous)
			}
		}
		observation := reviewObservation{ID: evidenceID("observation"), CandidateID: candidateID, Blockers: blockers}
		sequence, err := tx.nextEvidenceSequence(ctx, issue.ID, "review_observation")
		if err != nil {
			return err
		}
		return tx.insertEvidenceRecord(ctx, issue, "review_observation", observation.ID, sequence, observation)
	})
}

func (s *Store) reviewData(ctx context.Context, issue store.Issue) (reviewData, error) {
	data := reviewData{issue: issue, inputs: map[string]store.VerificationInput{}, materials: map[string]store.Material{}, evidence: map[string]store.Evidence{}, now: time.Now().UTC()}
	if issue.CurrentContractRevision != nil {
		var err error
		data.contract, err = s.contractByRevision(ctx, issue.ID, *issue.CurrentContractRevision)
		if err != nil {
			return data, err
		}
	}
	inputs, err := evidenceList[store.VerificationInput](ctx, s, issue.ID, "input")
	if err != nil {
		return data, err
	}
	for _, v := range inputs {
		data.inputs[v.ID] = v
	}
	materials, err := evidenceList[store.Material](ctx, s, issue.ID, "material")
	if err != nil {
		return data, err
	}
	for _, v := range materials {
		data.materials[v.ID] = v
	}
	evidence, err := evidenceList[store.Evidence](ctx, s, issue.ID, "evidence")
	if err != nil {
		return data, err
	}
	for _, v := range evidence {
		data.evidence[v.ID] = v
	}
	data.verifications, err = evidenceList[store.Verification](ctx, s, issue.ID, "verification")
	if err != nil {
		return data, err
	}
	data.assessments, err = evidenceList[store.HumanAssessment](ctx, s, issue.ID, "assessment")
	return data, err
}

func (s *Store) CurrentReview(ctx context.Context, issueID string) (store.ReviewSnapshot, error) {
	var result store.ReviewSnapshot
	err := s.withTx(ctx, func(tx *Store) error {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return err
		}
		data, err := tx.reviewData(ctx, issue)
		if err != nil {
			return err
		}
		result = store.ReviewSnapshot{SchemaVersion: 1, ID: evidenceID("review"), WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, CreatedAt: evidenceNow(), CreatedBy: store.ActorRef{Kind: "system", ID: "foundry", DisplayName: "Foundry"}, ContractRevision: data.contract.Revision, CriterionResults: []store.CriterionReviewEntry{}, BlockingReasons: []store.ReviewBlocker{}}
		if issue.CurrentCandidateSnapshotID != nil {
			result.CandidateSnapshotID = *issue.CurrentCandidateSnapshotID
		}
		if issue.ContractState != "confirmed" {
			code := "contract_unconfirmed"
			if issue.ContractState == "amendment_pending" {
				code = "contract_amendment_pending"
			}
			result.BlockingReasons = append(result.BlockingReasons, store.ReviewBlocker{Code: code, Message: "Review and confirm the exact criterion contract"})
		}
		if result.CandidateSnapshotID == "" {
			result.BlockingReasons = append(result.BlockingReasons, store.ReviewBlocker{Code: "candidate_changed", Message: "No sealed candidate has been verified"})
		}
		if issue.Status == "in_progress" || (issue.Run != nil && issue.Run.Status == "running") {
			result.BlockingReasons = append(result.BlockingReasons, store.ReviewBlocker{Code: "candidate_changed", Message: "Implementation is still running; seal and verify its completed candidate"})
		}
		if len(data.contract.Criteria) == 0 {
			result.BlockingReasons = append(result.BlockingReasons, store.ReviewBlocker{Code: "contract_unconfirmed", Message: "At least one required observable criterion must be confirmed"})
		}
		for _, c := range data.contract.Criteria {
			entry, blockers := data.criterionReview(c)
			result.CriterionResults = append(result.CriterionResults, entry)
			if c.Required {
				result.BlockingReasons = append(result.BlockingReasons, blockers...)
			}
		}
		observations, err := evidenceList[reviewObservation](ctx, tx, issue.ID, "review_observation")
		if err != nil {
			return err
		}
		for _, observation := range observations {
			if observation.CandidateID != result.CandidateSnapshotID {
				continue
			}
			result.BlockingReasons = append(result.BlockingReasons, observation.Blockers...)
			for i := range result.CriterionResults {
				for _, blocker := range observation.Blockers {
					result.CriterionResults[i].Reasons = append(result.CriterionResults[i].Reasons, blocker.Message)
					switch blocker.Code {
					case "candidate_changed", "baseline_changed", "stale":
						result.CriterionResults[i].Freshness = "stale"
					case "material_unavailable":
						result.CriterionResults[i].EvidenceAvailability = "unavailable"
					}
				}
			}
			break
		}
		result.Eligible = len(result.BlockingReasons) == 0
		result.Digest = evidenceDigest(map[string]any{"contractRevision": result.ContractRevision, "candidateSnapshotId": result.CandidateSnapshotID, "criterionResults": result.CriterionResults, "blockingReasons": result.BlockingReasons, "eligible": result.Eligible})
		if issue.CurrentReviewSnapshotID != nil {
			old, err := evidenceGet[store.ReviewSnapshot](ctx, tx, issue.ID, "review", *issue.CurrentReviewSnapshotID)
			if err == nil && old.Digest == result.Digest {
				result = old
				return nil
			}
		}
		sequence, err := tx.nextEvidenceSequence(ctx, issue.ID, "review")
		if err != nil {
			return err
		}
		if err = tx.insertEvidenceRecord(ctx, issue, "review", result.ID, sequence, result); err != nil {
			return err
		}
		issue.CurrentReviewSnapshotID = &result.ID
		summary := store.VerificationSummary{Eligible: result.Eligible}
		for i, c := range data.contract.Criteria {
			if !c.Required {
				continue
			}
			summary.RequiredTotal++
			entry := result.CriterionResults[i]
			if entry.Freshness != "fresh" {
				summary.Stale++
				continue
			}
			switch entry.EffectiveVerdict {
			case "pass":
				summary.Passed++
			case "fail":
				summary.Failed++
			case "inconclusive":
				summary.Inconclusive++
			default:
				summary.Pending++
			}
		}
		issue.VerificationSummary = &summary
		return tx.saveIssue(ctx, issue, time.Time{}, time.Now().UTC())
	})
	return result, err
}

func (d reviewData) criterionReview(c store.AcceptanceCriterion) (store.CriterionReviewEntry, []store.ReviewBlocker) {
	entry := store.CriterionReviewEntry{CriterionID: c.ID, EvidenceIDs: []string{}, EffectiveVerdict: "not_evaluated", Authority: "none", Freshness: "unknown", EvidenceAvailability: "available", Reasons: []string{}}
	blockers := []store.ReviewBlocker{}
	block := func(code, message string) {
		id := c.ID
		entry.Reasons = append(entry.Reasons, message)
		blockers = append(blockers, store.ReviewBlocker{Code: code, CriterionID: &id, Message: message})
	}
	references := append(append([]store.ReferenceMedia{}, d.contract.Goal.Media...), c.Rubric.Media...)
	referenceIDs := map[string]bool{}
	for _, ref := range references {
		referenceIDs[ref.MaterialID] = true
		if d.materials[ref.MaterialID].Availability != "available" {
			block("material_unavailable", "Reference material is unavailable")
		}
	}
	if c.EvaluationMode == "deterministic" && c.Checker == nil {
		block("checker_missing", "Confirm a fixed checker before deterministic verification")
	}
	var selected *store.Verification
	// Descending server sequence: never fall back from a newer error or canceled request.
	for i := range d.verifications {
		v := &d.verifications[i]
		input, ok := d.inputs[v.VerificationInputID]
		if v.CriterionID == c.ID && v.ContractRevision == d.contract.Revision && ok && d.issue.CurrentCandidateSnapshotID != nil && input.CandidateSnapshotID == *d.issue.CurrentCandidateSnapshotID {
			if selected == nil || v.Sequence > selected.Sequence {
				selected = v
			}
		}
	}
	if selected == nil {
		block("verification_pending", "No judgment for the current candidate and contract")
		return entry, blockers
	}
	v := *selected
	entry.VerificationID = &v.ID
	entry.EvidenceIDs = v.EvidenceIDs
	input := d.inputs[v.VerificationInputID]
	entry.Freshness = "fresh"
	if input.ContractDigest != d.contract.ContentDigest || input.ContractRevision != d.contract.Revision {
		entry.Freshness = "stale"
		block("stale", "Contract changed")
	}
	if input.BindingStatus == "unknown" || (c.EvaluationMode == "deterministic" && input.BindingStatus != "verified") {
		entry.Freshness = "unknown"
		block("input_unbound", "Verification inputs are not bound to this candidate")
	}
	for _, target := range input.Targets {
		if target.BindingStatus == "unknown" || (c.EvaluationMode == "deterministic" && target.BindingStatus != "verified") {
			block("input_unbound", "Target identity is not bound")
		}
	}
	switch v.Status {
	case "completed":
		if v.Result == nil {
			block("verification_error", "Completed verification has no result")
		} else {
			entry.EffectiveVerdict = v.Result.Verdict
			if c.EvaluationMode == "deterministic" {
				entry.Authority = "program"
			} else {
				entry.Authority = "agent_preliminary"
			}
			for _, a := range d.assessments {
				if c.EvaluationMode == "agent" && a.VerificationID == v.ID && a.VerificationInputID == input.ID && a.ContractRevision == d.contract.Revision {
					entry.EffectiveVerdict = a.Verdict
					entry.Authority = "human"
					entry.HumanAssessmentID = &a.ID
					break
				}
			}
			for _, id := range []string{v.Result.RawOutputMaterialID, v.Result.ReportMaterialID} {
				if d.materials[id].Availability != "available" {
					entry.EvidenceAvailability = "unavailable"
					block("material_unavailable", "Judgment output is unavailable")
				}
			}
			if len(v.Result.UnmetRequirementIDs) > 0 {
				block("evidence_missing", "Judgment reports missing required evidence")
			}
		}
	case "queued", "running":
		block("verification_pending", "The latest judgment is pending")
	default:
		block("verification_error", "The latest judgment failed or was canceled; older passes do not apply")
	}
	if c.Checker != nil && (v.Executor.Kind != "program" || v.Executor.CheckerDigest == nil || *v.Executor.CheckerDigest != c.Checker.DefinitionDigest) {
		block("stale", "Checker definition changed")
		entry.Freshness = "stale"
	}
	if c.EvaluationMode == "agent" && (v.Executor.Kind != "agent" || v.Executor.Isolated == nil || !*v.Executor.Isolated) {
		block("verification_error", "Judgment did not use an isolated agent")
	}
	for _, r := range c.EvidenceRequirements {
		distinct := map[string]bool{}
		for _, id := range v.EvidenceIDs {
			e, ok := d.evidence[id]
			if !ok || e.VerificationInputID != input.ID {
				continue
			}
			claimed := false
			for _, claim := range e.Claims {
				if claim.CriterionID == c.ID && claim.RequirementID == r.ID {
					claimed = true
				}
			}
			if !claimed || e.Source.Kind == "agent_authored" || e.Collection.Completeness != "complete" || e.Collection.Outcome != "completed" {
				continue
			}
			if r.BindingPolicy == "system_observed" && e.CandidateBinding != "system_observed" {
				continue
			}
			if e.CandidateBinding == "human_attested" && (e.BindingAttestation == nil || !store.IsHumanActor(e.BindingAttestation.Actor)) {
				continue
			}
			if d.materials[e.Collection.InputMaterialID].Availability != "available" {
				entry.EvidenceAvailability = "unavailable"
				block("material_unavailable", "Collection parameters are unavailable")
				continue
			}
			for _, ref := range e.Materials {
				if referenceIDs[ref.MaterialID] {
					continue
				}
				m, ok := d.materials[ref.MaterialID]
				if !ok || m.Availability != "available" {
					entry.EvidenceAvailability = "unavailable"
					block("material_unavailable", "Required original material is unavailable")
					continue
				}
				if c.MaxEvidenceAgeSeconds != nil {
					at, err := time.Parse(time.RFC3339Nano, m.CapturedAt)
					if err != nil || d.now.Sub(at) > time.Duration(*c.MaxEvidenceAgeSeconds)*time.Second {
						entry.Freshness = "stale"
						block("stale", "Evidence expired")
						continue
					}
				}
				for _, carrier := range r.AcceptedCarriers {
					if carrier == m.Carrier {
						distinct[m.Digest] = true
					}
				}
			}
		}
		if len(distinct) < r.MinimumCount {
			block("evidence_missing", fmt.Sprintf("Evidence requirement %s needs %d independent materials", r.ID, r.MinimumCount))
		}
	}
	if entry.EffectiveVerdict == "fail" {
		block("required_failed", "Criterion did not pass")
	}
	if entry.EffectiveVerdict == "inconclusive" || entry.EffectiveVerdict == "not_evaluated" {
		block("required_inconclusive", "Criterion is not conclusively satisfied")
	}
	return entry, blockers
}
