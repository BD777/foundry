package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
	"sort"
	"strings"
	"time"
)

func (s *Server) handleEvidenceReview(w http.ResponseWriter, r *http.Request) {
	st, ok := s.evidenceStore(w)
	if !ok {
		return
	}
	issue, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	unlock := s.lockIssueMutation(issue.ID)
	defer unlock()
	if issue.Status == "accepted" {
		decisions, readErr := st.ListEvidenceRecords(r.Context(), issue.ID, "decision")
		if readErr != nil {
			writeResult(w, nil, readErr)
			return
		}
		for _, raw := range decisions {
			var decision store.AcceptanceDecision
			if json.Unmarshal(raw, &decision) == nil && decision.Status == "integrated" {
				review, readErr := st.GetEvidenceRecord(r.Context(), issue.ID, "review", decision.ReviewSnapshotID)
				writeResult(w, review, readErr)
				return
			}
		}
	}
	materials, err := st.ListEvidenceRecords(r.Context(), issue.ID, "material")
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	seen := map[string]bool{}
	var inventoryErr error
	for offset := 0; ; offset += 100 {
		var inventory wsEvidenceResult
		inventory, inventoryErr = s.requestEvidenceWorker(r.Context(), issue, map[string]any{"action": "inventory", "offset": offset, "limit": 100, "taskId": evidenceTaskID(issue.ID, fmt.Sprint(offset), "inventory")})
		if inventoryErr != nil {
			break
		}
		for _, material := range inventory.Materials {
			seen[material.ID] = true
			if err = st.RegisterMaterial(r.Context(), issue.ID, material); err != nil {
				writeResult(w, nil, err)
				return
			}
		}
		if offset+100 >= inventory.Total {
			break
		}
	}
	for _, raw := range materials {
		var material store.Material
		if json.Unmarshal(raw, &material) != nil {
			continue
		}
		if inventoryErr != nil {
			if material.Availability == "available" {
				material.Availability = "offline"
				_ = st.RegisterMaterial(r.Context(), issue.ID, material)
			}
		} else if !seen[material.ID] && material.Availability != "deleted" {
			material.Availability = "missing"
			material.AvailabilityCheckedAt = time.Now().UTC().Format(time.RFC3339Nano)
			_ = st.RegisterMaterial(r.Context(), issue.ID, material)
		}
	}
	review, err := st.CurrentReview(r.Context(), r.PathValue("id"))
	if err == nil && review.CandidateSnapshotID != "" && !reviewHasPendingJudgment(review) {
		blockers := []store.ReviewBlocker{}
		var candidate store.CandidateSnapshot
		raw, readErr := st.GetEvidenceRecord(r.Context(), issue.ID, "candidate", review.CandidateSnapshotID)
		if readErr == nil {
			readErr = json.Unmarshal(raw, &candidate)
		}
		if readErr == nil {
			_, readErr = s.requestEvidenceWorker(r.Context(), issue, map[string]any{"action": "check_accept", "taskId": evidenceTaskID(issue.ID, review.ID, "check"), "candidate": candidate, "materialIds": []string{candidate.FileManifestMaterialID}})
		}
		if readErr != nil {
			code := "candidate_changed"
			if strings.Contains(readErr.Error(), "baseline_changed") {
				code = "baseline_changed"
			}
			if strings.Contains(readErr.Error(), "offline") {
				code = "material_unavailable"
			}
			blockers = append(blockers, store.ReviewBlocker{Code: code, Message: readErr.Error()})
		}
		err = st.RecordReviewObservation(r.Context(), issue.ID, review.CandidateSnapshotID, blockers)
		if err == nil {
			review, err = st.CurrentReview(r.Context(), issue.ID)
		}
	}
	writeResult(w, review, err)
}

func reviewHasPendingJudgment(review store.ReviewSnapshot) bool {
	for _, blocker := range review.BlockingReasons {
		if blocker.Code == "verification_pending" {
			// Already ineligible. Do not contend with an active collector for the
			// candidate lock; final review and Accept still recheck exact inputs.
			return true
		}
	}
	return false
}

func (s *Server) handleEvidenceAccept(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ReviewSnapshotID string             `json:"reviewSnapshotId"`
		ReviewDigest     string             `json:"reviewDigest"`
		Revision         *int               `json:"revision"`
		Rationale        *store.RichContent `json:"rationale,omitempty"`
	}
	if !decodeEvidenceRequest(w, r, "", &input) {
		return
	}
	if input.ReviewSnapshotID == "" || input.ReviewDigest == "" || input.Revision != nil {
		writeError(w, http.StatusConflict, "accept_protocol_upgrade_required: submit reviewSnapshotId and reviewDigest; environment revision alone is not accepted")
		return
	}
	actor := humanActor(r)
	st, ok := s.evidenceStore(w)
	if !ok {
		return
	}
	issue, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	unlock := s.lockIssueMutation(issue.ID)
	defer unlock()
	issue, err = s.store.GetIssue(r.Context(), issue.ID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	review, err := st.CurrentReview(r.Context(), issue.ID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	// Re-delivering a completed Accept is read-only. Never start a new integration.
	if issue.Status == "accepted" {
		decision, replayErr := st.ApproveReview(r.Context(), issue.ID, input.ReviewSnapshotID, input.ReviewDigest, actor, r.Header.Get("Idempotency-Key"), input.Rationale)
		if replayErr != nil {
			writeEvidenceMutation(w, nil, replayErr)
			return
		}
		if decision.Status == "integrated" {
			writeResult(w, issue, nil)
			return
		}
		writeError(w, http.StatusConflict, "acceptance_review_mismatch")
		return
	}
	// A recoverable journal remains tied to the approved immutable review, even
	// when live observations now see one of its already-applied repository heads.
	var existing *store.AcceptanceDecision
	records, err := st.ListEvidenceRecords(r.Context(), issue.ID, "decision")
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	for _, raw := range records {
		var decision store.AcceptanceDecision
		if json.Unmarshal(raw, &decision) == nil && decision.Status == "approved" && decision.ReviewSnapshotID == input.ReviewSnapshotID && decision.ReviewDigest == input.ReviewDigest {
			existing = &decision
			break
		}
	}
	if existing != nil {
		latestReview := review
		raw, readErr := st.GetEvidenceRecord(r.Context(), issue.ID, "review", existing.ReviewSnapshotID)
		if readErr == nil {
			readErr = json.Unmarshal(raw, &review)
		}
		if readErr != nil {
			writeResult(w, nil, readErr)
			return
		}
		if issue.ContractState != "confirmed" || issue.CurrentContractRevision == nil || *issue.CurrentContractRevision != review.ContractRevision || issue.CurrentCandidateSnapshotID == nil || *issue.CurrentCandidateSnapshotID != review.CandidateSnapshotID {
			_, _ = st.FinishAcceptance(r.Context(), issue.ID, existing.ID, "", "acceptance_input_changed")
			writeError(w, 409, "acceptance_input_changed")
			return
		}
		if !store.SameReviewJudgments(latestReview, review) {
			_, _ = st.FinishAcceptance(r.Context(), issue.ID, existing.ID, "", "verification_selection_changed")
			writeError(w, 409, "verification_selection_changed")
			return
		}
	}
	if review.ID != input.ReviewSnapshotID || review.Digest != input.ReviewDigest || !review.Eligible {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "review_not_eligible_or_changed", "review": review})
		return
	}
	raw, err := st.GetEvidenceRecord(r.Context(), issue.ID, "candidate", review.CandidateSnapshotID)
	var candidate store.CandidateSnapshot
	if err == nil {
		err = json.Unmarshal(raw, &candidate)
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	materialIDs, err := reviewMaterialIDs(r.Context(), st, issue, review, candidate)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	preflight := map[string]any{"action": "check_accept", "taskId": evidenceTaskID(issue.ID, r.Header.Get("Idempotency-Key"), "preflight"), "candidate": candidate, "materialIds": materialIDs}
	if existing != nil {
		preflight["decisionId"] = existing.ID
	}
	_, err = s.requestEvidenceWorker(r.Context(), issue, preflight)
	if err != nil {
		if existing != nil && (strings.Contains(err.Error(), "baseline_changed") || strings.Contains(err.Error(), "candidate_changed") || strings.Contains(err.Error(), "material_")) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _ = st.FinishAcceptance(ctx, issue.ID, existing.ID, "", err.Error())
		}
		writeEvidenceMutation(w, nil, err)
		return
	}
	decision, err := st.ApproveReview(r.Context(), issue.ID, input.ReviewSnapshotID, input.ReviewDigest, actor, r.Header.Get("Idempotency-Key"), input.Rationale)
	if err != nil {
		writeEvidenceMutation(w, nil, err)
		return
	}
	result, err := s.requestEvidenceWorker(r.Context(), issue, map[string]any{"action": "accept", "taskId": decision.ID, "decision": decision, "review": review, "candidate": candidate, "materialIds": materialIDs})
	if err != nil {
		if strings.Contains(err.Error(), "baseline_changed") || strings.Contains(err.Error(), "candidate_changed") || strings.Contains(err.Error(), "material_") {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _ = st.FinishAcceptance(ctx, issue.ID, decision.ID, "", err.Error())
		}
		writeEvidenceMutation(w, nil, err)
		return
	}
	if result.Status != "integrated" || result.IntegrationID == "" || result.IntegrationSnapshot == nil {
		writeError(w, 409, "integration_receipt_incomplete")
		return
	}
	integration := result.IntegrationSnapshot
	if integration.IssueID != issue.ID || integration.WorkspaceID != issue.WorkspaceID || integration.Purpose != "integration" || integration.ParentSnapshotID == nil || *integration.ParentSnapshotID != candidate.ID || integration.ContentDigest != candidate.ContentDigest {
		writeError(w, 409, "integration_receipt_mismatch")
		return
	}
	if err = st.RegisterIntegrationSnapshot(r.Context(), issue.ID, decision.ID, *integration); err != nil {
		writeEvidenceMutation(w, nil, err)
		return
	}
	if _, err = st.FinishAcceptance(r.Context(), issue.ID, decision.ID, result.IntegrationID, ""); err != nil {
		writeEvidenceMutation(w, nil, err)
		return
	}
	current, err := s.store.GetIssue(r.Context(), issue.ID)
	if err == nil {
		s.publishEvidenceUpdate(issue, decision.ID, review.ContractRevision, "integrated")
		s.events.Publish("issue_updated", current)
	}
	writeResult(w, current, err)
}

func reviewMaterialIDs(ctx context.Context, st store.EvidenceStore, issue store.Issue, review store.ReviewSnapshot, candidate store.CandidateSnapshot) ([]string, error) {
	ids := map[string]bool{candidate.FileManifestMaterialID: true}
	contract, err := currentIssueContract(ctx, st, issue)
	if err != nil {
		return nil, err
	}
	for _, ref := range contract.Goal.Media {
		ids[ref.MaterialID] = true
	}
	for _, c := range contract.Criteria {
		if !c.Required {
			continue
		}
		for _, ref := range c.Rubric.Media {
			ids[ref.MaterialID] = true
		}
		if c.Checker != nil {
			config := c.Checker.Configuration
			if config.CheckerBundleMaterialID != nil {
				ids[*config.CheckerBundleMaterialID] = true
			}
			for _, id := range config.FixtureMaterialIDs {
				ids[id] = true
			}
			if config.BodyMaterialID != nil {
				ids[*config.BodyMaterialID] = true
			}
		}
	}
	for _, entry := range review.CriterionResults {
		required := false
		for _, criterion := range contract.Criteria {
			if criterion.ID == entry.CriterionID {
				required = criterion.Required
			}
		}
		if !required {
			continue
		}
		if entry.VerificationID == nil {
			continue
		}
		raw, err := st.GetEvidenceRecord(ctx, issue.ID, "verification", *entry.VerificationID)
		if err != nil {
			return nil, err
		}
		var v store.Verification
		if err = json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		if v.Result != nil {
			ids[v.Result.RawOutputMaterialID] = true
			ids[v.Result.ReportMaterialID] = true
		}
		raw, err = st.GetEvidenceRecord(ctx, issue.ID, "input", v.VerificationInputID)
		if err != nil {
			return nil, err
		}
		var input store.VerificationInput
		if err = json.Unmarshal(raw, &input); err != nil {
			return nil, err
		}
		for _, dependency := range input.Dependencies {
			if dependency.Revalidation == "check_before_accept" {
				return nil, fmt.Errorf("dependency_revalidation_required")
			}
			if dependency.MaterialID != nil {
				ids[*dependency.MaterialID] = true
			}
		}
		for _, id := range entry.EvidenceIDs {
			raw, err := st.GetEvidenceRecord(ctx, issue.ID, "evidence", id)
			if err != nil {
				return nil, err
			}
			var e store.Evidence
			if err = json.Unmarshal(raw, &e); err != nil {
				return nil, err
			}
			ids[e.Collection.InputMaterialID] = true
			for _, m := range e.Materials {
				ids[m.MaterialID] = true
			}
		}
	}
	result := []string{}
	for id := range ids {
		result = append(result, id)
	}
	sort.Strings(result)
	return result, nil
}
