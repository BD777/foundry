package sqlitestore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"strings"
	"time"
)

func validateRecordScope(issue store.Issue, model string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err = store.ValidateEvidenceJSON(model, raw); err != nil {
		return err
	}
	var record store.EvidenceRecord
	_ = json.Unmarshal(raw, &record)
	if record.IssueID != issue.ID || record.WorkspaceID != issue.WorkspaceID {
		return fmt.Errorf("cross_issue_reference")
	}
	return nil
}
func (s *Store) RegisterMaterial(ctx context.Context, issueID string, m store.Material) error {
	return s.withTx(ctx, func(tx *Store) error {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return err
		}
		if err = validateRecordScope(issue, "Material", m); err != nil {
			return err
		}
		old, lookupErr := evidenceGet[store.Material](ctx, tx, issue.ID, "material", m.ID)
		if lookupErr == nil {
			if old.Digest != m.Digest || old.ByteSize != m.ByteSize || old.StorageDeviceID != m.StorageDeviceID {
				return fmt.Errorf("immutable_material_conflict")
			}
			old.Availability = m.Availability
			old.AvailabilityCheckedAt = m.AvailabilityCheckedAt
			return tx.updateEvidenceProjection(ctx, m.ID, old)
		}
		if !errors.Is(lookupErr, store.ErrNotFound) {
			return lookupErr
		}
		sequence, err := tx.nextEvidenceSequence(ctx, issue.ID, "material")
		if err != nil {
			return err
		}
		return tx.insertEvidenceRecord(ctx, issue, "material", m.ID, sequence, m)
	})
}
func (s *Store) RegisterCandidate(ctx context.Context, issueID string, c store.CandidateSnapshot, input store.VerificationInput) error {
	return s.withTx(ctx, func(tx *Store) error {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return err
		}
		if err = tx.requireConfirmedContract(ctx, issue); err != nil {
			return err
		}
		if issue.Status == "accepted" || issue.Status == "abandoned" {
			return fmt.Errorf("terminal_issue")
		}
		if err = validateRecordScope(issue, "CandidateSnapshot", c); err != nil {
			return err
		}
		if err = validateRecordScope(issue, "VerificationInput", input); err != nil {
			return err
		}
		contract, err := tx.contractByRevision(ctx, issue.ID, *issue.CurrentContractRevision)
		if err != nil {
			return err
		}
		if input.CandidateSnapshotID != c.ID || input.CandidateDigest != c.ContentDigest || input.ContractRevision != contract.Revision || input.ContractDigest != contract.ContentDigest {
			return fmt.Errorf("input_identity_mismatch")
		}
		if issue.Run == nil || issue.Run.EnvironmentID != c.EnvironmentID || issue.Run.EnvironmentRevision != c.EnvironmentRevision {
			return fmt.Errorf("candidate_changed")
		}
		if _, err = tx.GetEvidenceRecord(ctx, issue.ID, "material", c.FileManifestMaterialID); err != nil {
			return err
		}
		for _, record := range []struct {
			kind, id string
			value    any
		}{{"candidate", c.ID, c}, {"input", input.ID, input}} {
			if old, err := tx.GetEvidenceRecord(ctx, issue.ID, record.kind, record.id); err == nil {
				var v any
				_ = json.Unmarshal(old, &v)
				if evidenceDigest(v) != evidenceDigest(record.value) {
					return fmt.Errorf("immutable_snapshot_conflict")
				}
				continue
			} else if !errors.Is(err, store.ErrNotFound) {
				return err
			}
			sequence, err := tx.nextEvidenceSequence(ctx, issue.ID, record.kind)
			if err != nil {
				return err
			}
			if err = tx.insertEvidenceRecord(ctx, issue, record.kind, record.id, sequence, record.value); err != nil {
				return err
			}
		}
		issue.CurrentCandidateSnapshotID = &c.ID
		issue.CurrentReviewSnapshotID = nil
		issue.VerificationSummary = nil
		return tx.saveIssue(ctx, issue, time.Time{}, time.Now().UTC())
	})
}

func (s *Store) RequestVerification(ctx context.Context, issueID string, revision int, snapshotID, criterionID string, actor store.ActorRef, requestID string) (store.Verification, error) {
	var result store.Verification
	err := s.evidenceRequest(ctx, issueID+"/verify/"+criterionID, requestID, []any{revision, snapshotID, criterionID, actor}, func(tx *Store) (any, error) {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return nil, err
		}
		// Creating queued verification is work creation, so it must be gated
		// inside this transaction. The HTTP handler's earlier tombstone check
		// cannot close the TOCTOU window on its own: a removal can commit
		// between that check and this write, which would otherwise enqueue a
		// verifier on a removed device and deadlock future removals against
		// the very busy counter the enqueue created.
		if err := tx.assertWorkspaceDeviceNotRemoved(ctx, issue.WorkspaceID); err != nil {
			return nil, err
		}
		if err = tx.requireConfirmedContract(ctx, issue); err != nil {
			return nil, err
		}
		if issue.CurrentCandidateSnapshotID == nil || *issue.CurrentCandidateSnapshotID != snapshotID || *issue.CurrentContractRevision != revision {
			return nil, fmt.Errorf("verification_input_changed")
		}
		contract, err := tx.contractByRevision(ctx, issue.ID, revision)
		if err != nil {
			return nil, err
		}
		var criterion *store.AcceptanceCriterion
		for i := range contract.Criteria {
			if contract.Criteria[i].ID == criterionID {
				criterion = &contract.Criteria[i]
				break
			}
		}
		if criterion == nil {
			return nil, fmt.Errorf("unknown_criterion")
		}
		inputs, err := evidenceList[store.VerificationInput](ctx, tx, issue.ID, "input")
		if err != nil {
			return nil, err
		}
		var input *store.VerificationInput
		for i := range inputs {
			if inputs[i].CandidateSnapshotID == snapshotID && inputs[i].ContractRevision == revision {
				input = &inputs[i]
				break
			}
		}
		if input == nil {
			return nil, fmt.Errorf("input_missing")
		}
		previous, err := evidenceList[store.Verification](ctx, tx, issue.ID, "verification")
		if err != nil {
			return nil, err
		}
		for _, v := range previous {
			if v.CriterionID == criterionID && (v.Status == "queued" || v.Status == "running") {
				return nil, fmt.Errorf("verification_already_active")
			}
		}
		sequence, err := tx.nextEvidenceSequence(ctx, issue.ID, "verification")
		if err != nil {
			return nil, err
		}
		v := store.Verification{SchemaVersion: 1, ID: evidenceID("verify"), WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, CreatedAt: evidenceNow(), CreatedBy: actor, Sequence: sequence, CriterionID: criterionID, ContractRevision: revision, VerificationInputID: input.ID, EvidenceIDs: []string{}, Mode: criterion.EvaluationMode, Status: "queued"}
		if criterion.EvaluationMode == "deterministic" {
			if criterion.Checker == nil {
				return nil, fmt.Errorf("checker_missing")
			}
			name, version, digest := "foundry-check", "1", criterion.Checker.DefinitionDigest
			v.Executor = store.VerifierIdentity{Kind: "program", Name: &name, Version: &version, CheckerDigest: &digest}
			// Reserve the trusted collector's exact output ID before dispatch.
			// Historical passes/evidence are never silently mixed into a new run.
			v.EvidenceIDs = []string{evidenceID("ev")}
		} else {
			isolated := true
			profileID := issue.ProfileID
			if profileID == "" {
				profileID = issue.Runtime + "_local"
			}
			sessionID := evidenceID("verifier_session")
			template := "foundry-verification/v2"
			digest := evidenceDigest([]any{contract.ContentDigest, criterionID, input.InputDigest})
			v.Executor = store.VerifierIdentity{Kind: "agent", Harness: &issue.Runtime, ProfileID: &profileID, RequestedModel: &issue.Model, SessionID: &sessionID, PromptTemplateVersion: &template, PromptDigest: &digest, Isolated: &isolated}
		}
		evidence, err := evidenceList[store.Evidence](ctx, tx, issue.ID, "evidence")
		if err != nil {
			return nil, err
		}
		for _, e := range evidence {
			if v.Mode == "deterministic" {
				break
			}
			if e.VerificationInputID != input.ID {
				continue
			}
			for _, claim := range e.Claims {
				if claim.CriterionID == criterionID {
					v.EvidenceIDs = append(v.EvidenceIDs, e.ID)
					break
				}
			}
		}
		for _, p := range previous {
			if p.CriterionID == criterionID {
				v.SupersedesVerificationID = &p.ID
				break
			}
		}
		if err = tx.insertEvidenceRecord(ctx, issue, "verification", v.ID, sequence, v); err != nil {
			return nil, err
		}
		issue.CurrentReviewSnapshotID = nil
		if err = tx.saveIssue(ctx, issue, time.Time{}, time.Now().UTC()); err != nil {
			return nil, err
		}
		err = tx.auditEvidence(ctx, issue, actor, requestID, "verification_requested", "verification", v.ID, "", "")
		return v, err
	}, &result)
	return result, err
}
func (s *Store) CompleteVerification(ctx context.Context, issueID string, v store.Verification, evidence []store.Evidence) error {
	return s.withTx(ctx, func(tx *Store) error {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return err
		}
		if err = validateRecordScope(issue, "Verification", v); err != nil {
			return err
		}
		original, err := evidenceGet[store.Verification](ctx, tx, issue.ID, "verification", v.ID)
		if err != nil {
			return err
		}
		if original.Status == "completed" || original.Status == "failed" || original.Status == "canceled" {
			if evidenceDigest(original) == evidenceDigest(v) {
				return nil
			}
			return fmt.Errorf("immutable_verification_conflict")
		}
		expectedExecutor := original.Executor
		if original.Mode == "agent" {
			expectedExecutor.ReportedModel = v.Executor.ReportedModel
			expectedExecutor.PromptDigest = v.Executor.PromptDigest
			if v.Executor.SessionID == nil || *v.Executor.SessionID == "" {
				return fmt.Errorf("verifier_session_required")
			}
			expectedExecutor.SessionID = v.Executor.SessionID
		}
		if original.CreatedAt != v.CreatedAt || evidenceDigest(original.CreatedBy) != evidenceDigest(v.CreatedBy) || original.Sequence != v.Sequence || original.VerificationInputID != v.VerificationInputID || original.CriterionID != v.CriterionID || original.ContractRevision != v.ContractRevision || original.Mode != v.Mode || evidenceDigest(expectedExecutor) != evidenceDigest(v.Executor) {
			return fmt.Errorf("verification_task_mismatch")
		}
		if v.Status != "completed" && v.Status != "failed" && v.Status != "canceled" {
			return fmt.Errorf("verification_not_terminal")
		}
		if (v.Status == "completed") != (v.Result != nil) || (v.Status == "failed" && v.Error == nil) {
			return fmt.Errorf("invalid_verification_outcome")
		}
		allowed := map[string]store.Evidence{}
		for _, id := range original.EvidenceIDs {
			e, err := evidenceGet[store.Evidence](ctx, tx, issue.ID, "evidence", id)
			if original.Mode == "deterministic" && errors.Is(err, store.ErrNotFound) {
				allowed[id] = store.Evidence{} // Reserved, not yet collected.
				continue
			}
			if err != nil {
				return err
			}
			allowed[id] = e
		}
		contract, err := tx.contractByRevision(ctx, issue.ID, v.ContractRevision)
		if err != nil {
			return err
		}
		requirements := map[string]bool{}
		for _, criterion := range contract.Criteria {
			if criterion.ID != v.CriterionID {
				continue
			}
			if criterion.EvaluationMode != v.Mode {
				return fmt.Errorf("verification_mode_mismatch")
			}
			for _, requirement := range criterion.EvidenceRequirements {
				requirements[requirement.ID] = true
			}
		}
		if v.Mode == "agent" && len(evidence) != 0 {
			return fmt.Errorf("agent_cannot_create_tool_evidence")
		}
		for _, e := range evidence {
			reserved, ok := allowed[e.ID]
			if !ok || reserved.ID != "" {
				return fmt.Errorf("unreserved_collection")
			}
			if err = validateRecordScope(issue, "Evidence", e); err != nil {
				return err
			}
			if e.VerificationInputID != v.VerificationInputID || e.Source.Kind != "tool_capture" || e.CandidateBinding != "system_observed" {
				return fmt.Errorf("untrusted_collection")
			}
			for _, claim := range e.Claims {
				if claim.CriterionID != v.CriterionID || !requirements[claim.RequirementID] {
					return fmt.Errorf("collection_claim_mismatch")
				}
			}
			for _, m := range e.Materials {
				if _, err = tx.GetEvidenceRecord(ctx, issue.ID, "material", m.MaterialID); err != nil {
					return err
				}
			}
			if _, err = tx.GetEvidenceRecord(ctx, issue.ID, "material", e.Collection.InputMaterialID); err != nil {
				return err
			}
			sequence, err := tx.nextEvidenceSequence(ctx, issue.ID, "evidence")
			if err != nil {
				return err
			}
			if err = tx.insertEvidenceRecord(ctx, issue, "evidence", e.ID, sequence, e); err != nil {
				return err
			}
			if err = tx.auditEvidence(ctx, issue, e.CreatedBy, e.ID, "evidence_registered", "evidence", e.ID, evidenceDigest(e), ""); err != nil {
				return err
			}
			allowed[e.ID] = e
		}
		if len(v.EvidenceIDs) != len(allowed) {
			return fmt.Errorf("fixed_evidence_set_mismatch")
		}
		seen := map[string]bool{}
		for _, id := range v.EvidenceIDs {
			if _, ok := allowed[id]; !ok {
				return fmt.Errorf("unregistered_evidence")
			}
			if seen[id] {
				return fmt.Errorf("duplicate_evidence_id")
			}
			seen[id] = true
			if v.Status == "completed" && allowed[id].ID == "" {
				return fmt.Errorf("reserved_evidence_missing")
			}
		}
		if v.Result != nil {
			if v.Result.Verdict == "pass" && len(v.Result.Findings) == 0 {
				return fmt.Errorf("pass_requires_cited_findings")
			}
			for _, id := range v.Result.UnmetRequirementIDs {
				if !requirements[id] {
					return fmt.Errorf("unknown_unmet_requirement")
				}
			}
			for _, id := range []string{v.Result.RawOutputMaterialID, v.Result.ReportMaterialID} {
				if _, err = tx.GetEvidenceRecord(ctx, issue.ID, "material", id); err != nil {
					return err
				}
			}
			refs := map[string]bool{}
			for _, ref := range contract.Goal.Media {
				refs[ref.MaterialID] = true
			}
			for _, c := range contract.Criteria {
				if c.ID == v.CriterionID {
					for _, ref := range c.Rubric.Media {
						refs[ref.MaterialID] = true
					}
				}
			}
			for _, finding := range v.Result.Findings {
				if v.Result.Verdict == "pass" && (finding.Verdict != "pass" || len(finding.EvidenceCitations) == 0) {
					return fmt.Errorf("pass_requires_cited_passing_findings")
				}
				for _, cite := range finding.EvidenceCitations {
					e, ok := allowed[cite.EvidenceID]
					found := false
					for _, m := range e.Materials {
						if m.MaterialID == cite.MaterialID {
							found = true
						}
					}
					if !ok || !found {
						return fmt.Errorf("invalid_evidence_citation")
					}
				}
				for _, cite := range finding.ReferenceCitations {
					if !refs[cite.MaterialID] {
						return fmt.Errorf("invalid_reference_citation")
					}
				}
			}
		}
		if err = tx.updateEvidenceProjection(ctx, v.ID, v); err != nil {
			return err
		}
		return tx.auditEvidence(ctx, issue, store.ActorRef{Kind: "system", ID: "foundry", DisplayName: "Foundry"}, v.ID, "verification_completed", "verification", v.ID, evidenceDigest(v), "")
	})
}

func (s *Store) CreateHumanAssessment(ctx context.Context, issueID string, input store.HumanAssessmentInput, actor store.ActorRef, requestID string) (store.HumanAssessment, error) {
	var result store.HumanAssessment
	if !store.IsHumanActor(actor) {
		return result, fmt.Errorf("user_action_required")
	}
	if strings.TrimSpace(input.Rationale.Text) == "" || input.Rationale.Media == nil || len(input.EvidenceCitations) == 0 {
		return result, fmt.Errorf("rationale_and_evidence_required")
	}
	if input.Verdict != "pass" && input.Verdict != "fail" && input.Verdict != "inconclusive" {
		return result, fmt.Errorf("invalid_verdict")
	}
	err := s.evidenceRequest(ctx, issueID+"/assessment", requestID, []any{input, actor}, func(tx *Store) (any, error) {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return nil, err
		}
		if err = tx.requireConfirmedContract(ctx, issue); err != nil {
			return nil, err
		}
		v, err := evidenceGet[store.Verification](ctx, tx, issue.ID, "verification", input.VerificationID)
		if err != nil {
			return nil, err
		}
		if v.Mode != "agent" || v.Status != "completed" || v.Result == nil {
			return nil, fmt.Errorf("only_completed_agent_judgments_can_be_assessed")
		}
		if *issue.CurrentContractRevision != v.ContractRevision {
			return nil, fmt.Errorf("stale_verification")
		}
		latest, err := evidenceList[store.Verification](ctx, tx, issue.ID, "verification")
		if err != nil {
			return nil, err
		}
		for _, other := range latest {
			if other.CriterionID == v.CriterionID && other.Sequence > v.Sequence {
				return nil, fmt.Errorf("newer_verification_exists")
			}
		}
		bound, err := evidenceGet[store.VerificationInput](ctx, tx, issue.ID, "input", v.VerificationInputID)
		if err != nil {
			return nil, err
		}
		if issue.CurrentCandidateSnapshotID == nil || *issue.CurrentCandidateSnapshotID != bound.CandidateSnapshotID {
			return nil, fmt.Errorf("candidate_changed")
		}
		for _, citation := range input.EvidenceCitations {
			found := false
			for _, id := range v.EvidenceIDs {
				if id != citation.EvidenceID {
					continue
				}
				e, err := evidenceGet[store.Evidence](ctx, tx, issue.ID, "evidence", id)
				if err != nil {
					return nil, err
				}
				for _, m := range e.Materials {
					if m.MaterialID == citation.MaterialID {
						found = true
					}
				}
			}
			if !found {
				return nil, fmt.Errorf("citation_not_in_fixed_evidence")
			}
		}
		if err = validateRichRationale(ctx, tx, issue, input.Rationale); err != nil {
			return nil, err
		}
		a := store.HumanAssessment{SchemaVersion: 1, ID: evidenceID("assessment"), WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, CreatedAt: evidenceNow(), CreatedBy: actor, CriterionID: v.CriterionID, ContractRevision: v.ContractRevision, VerificationInputID: v.VerificationInputID, VerificationID: v.ID, Verdict: input.Verdict, Rationale: input.Rationale, EvidenceCitations: input.EvidenceCitations}
		if err = validateRecordScope(issue, "HumanAssessment", a); err != nil {
			return nil, err
		}
		old, err := evidenceList[store.HumanAssessment](ctx, tx, issue.ID, "assessment")
		if err != nil {
			return nil, err
		}
		for _, previous := range old {
			if previous.VerificationID == v.ID {
				a.SupersedesAssessmentID = &previous.ID
				break
			}
		}
		sequence, err := tx.nextEvidenceSequence(ctx, issue.ID, "assessment")
		if err != nil {
			return nil, err
		}
		if err = tx.insertEvidenceRecord(ctx, issue, "assessment", a.ID, sequence, a); err != nil {
			return nil, err
		}
		err = tx.auditEvidence(ctx, issue, actor, requestID, "human_assessed", "assessment", a.ID, evidenceDigest(a), input.Rationale.Text)
		return a, err
	}, &result)
	return result, err
}

func validateRichRationale(ctx context.Context, s *Store, issue store.Issue, rationale store.RichContent) error {
	raw, err := json.Marshal(rationale)
	if err != nil {
		return err
	}
	if err = store.ValidateEvidenceJSON("RichContent", raw); err != nil {
		return err
	}
	for _, ref := range rationale.Media {
		if ref.Role != "context" {
			return fmt.Errorf("rationale_media_is_explanation_only: register actual results as Evidence")
		}
		material, err := evidenceGet[store.Material](ctx, s, issue.ID, "material", ref.MaterialID)
		if err != nil {
			return err
		}
		if material.Availability != "available" {
			return fmt.Errorf("rationale_material_unavailable")
		}
	}
	return nil
}

func (s *Store) RegisterHumanEvidence(ctx context.Context, issueID string, input store.HumanEvidenceInput, actor store.ActorRef, requestID string) (store.Evidence, error) {
	var result store.Evidence
	if !store.IsHumanActor(actor) || strings.TrimSpace(input.Attestation) == "" || len(input.MaterialIDs) == 0 || len(input.Claims) == 0 {
		return result, fmt.Errorf("human_attestation_and_materials_required")
	}
	err := s.evidenceRequest(ctx, issueID+"/evidence", requestID, []any{input, actor}, func(tx *Store) (any, error) {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return nil, err
		}
		if err = tx.requireConfirmedContract(ctx, issue); err != nil {
			return nil, err
		}
		bound, err := evidenceGet[store.VerificationInput](ctx, tx, issue.ID, "input", input.VerificationInputID)
		if err != nil {
			return nil, err
		}
		if *issue.CurrentContractRevision != input.ExpectedContractRevision || bound.ContractRevision != input.ExpectedContractRevision || issue.CurrentCandidateSnapshotID == nil || *issue.CurrentCandidateSnapshotID != bound.CandidateSnapshotID {
			return nil, fmt.Errorf("input_changed")
		}
		c, err := tx.contractByRevision(ctx, issue.ID, input.ExpectedContractRevision)
		if err != nil {
			return nil, err
		}
		referenceIDs := map[string]bool{}
		for _, ref := range c.Goal.Media {
			referenceIDs[ref.MaterialID] = true
		}
		for _, criterion := range c.Criteria {
			for _, ref := range criterion.Rubric.Media {
				referenceIDs[ref.MaterialID] = true
			}
		}
		for _, id := range input.MaterialIDs {
			if referenceIDs[id] {
				return nil, fmt.Errorf("reference_material_is_not_actual_evidence")
			}
		}
		for _, claim := range input.Claims {
			found := false
			for _, criterion := range c.Criteria {
				if criterion.ID != claim.CriterionID || criterion.EvaluationMode != "agent" {
					continue
				}
				for _, r := range criterion.EvidenceRequirements {
					if r.ID == claim.RequirementID && r.BindingPolicy == "system_or_human_attested" {
						found = true
					}
				}
			}
			if !found {
				return nil, fmt.Errorf("human_evidence_not_allowed_for_requirement")
			}
		}
		e := store.Evidence{SchemaVersion: 1, ID: evidenceID("ev"), WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, CreatedAt: evidenceNow(), CreatedBy: actor, Title: input.Title, Description: input.Description, VerificationInputID: bound.ID, Claims: input.Claims, Materials: []store.EvidenceMaterialRef{}, Source: store.EvidenceSource{Kind: "human_upload", Producer: actor}, CandidateBinding: "human_attested", BindingAttestation: &store.EvidenceBindingAttestation{Actor: actor, At: evidenceNow(), Statement: input.Attestation}, Collection: store.CollectionRecord{Operation: "upload", CollectorName: "foundry-upload", CollectorVersion: "1", InputMaterialID: input.CollectionInputMaterialID, StartedAt: evidenceNow(), FinishedAt: evidenceNow(), Outcome: "completed", Completeness: "complete"}}
		for _, id := range append(append([]string{}, input.MaterialIDs...), input.CollectionInputMaterialID) {
			m, err := evidenceGet[store.Material](ctx, tx, issue.ID, "material", id)
			if err != nil {
				return nil, err
			}
			if m.Availability != "available" {
				return nil, fmt.Errorf("material_unavailable")
			}
		}
		for _, id := range input.MaterialIDs {
			e.Materials = append(e.Materials, store.EvidenceMaterialRef{MaterialID: id, Role: "primary"})
		}
		if err = validateRecordScope(issue, "Evidence", e); err != nil {
			return nil, err
		}
		sequence, err := tx.nextEvidenceSequence(ctx, issue.ID, "evidence")
		if err != nil {
			return nil, err
		}
		if err = tx.insertEvidenceRecord(ctx, issue, "evidence", e.ID, sequence, e); err != nil {
			return nil, err
		}
		err = tx.auditEvidence(ctx, issue, actor, requestID, "evidence_registered", "evidence", e.ID, evidenceDigest(e), input.Attestation)
		return e, err
	}, &result)
	return result, err
}
