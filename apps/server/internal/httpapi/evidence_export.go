package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) handleEvidenceExport(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ExpectedContractRevision int                   `json:"expectedContractRevision"`
		VerificationInputID      string                `json:"verificationInputId"`
		RepoID                   string                `json:"repoId"`
		RelativePath             string                `json:"relativePath"`
		Claims                   []store.EvidenceClaim `json:"claims"`
		Carrier                  string                `json:"carrier"`
		SourceKind               string                `json:"sourceKind,omitempty"`
	}
	if !decodeEvidenceRequest(w, r, "", &input) {
		return
	}
	source := store.EvidenceRequirementSourceCandidateFile
	if input.SourceKind != "" {
		source = store.EvidenceRequirementSource(input.SourceKind)
	}
	if source != store.EvidenceRequirementSourceCandidateFile && source != store.EvidenceRequirementSourceCandidateChanges {
		writeError(w, 400, "unsupported_export_source")
		return
	}
	if source == store.EvidenceRequirementSourceCandidateChanges && (input.RepoID != "" || input.RelativePath != "") {
		writeError(w, 400, "candidate_changes_has_no_file_path")
		return
	}
	if !slices.Contains(store.SourceCarriers(source), store.CarrierKind(input.Carrier)) {
		writeError(w, 400, fmt.Sprintf("export_carrier_not_produced: %s produces %v", source, store.SourceCarriers(source)))
		return
	}
	issue, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	unlock := s.issueService.Lock(issue.ID)
	defer unlock()
	if issue.CurrentContractRevision == nil || *issue.CurrentContractRevision != input.ExpectedContractRevision || issue.ContractState != "confirmed" {
		writeError(w, 409, "contract_changed")
		return
	}
	contract, err := currentIssueContract(r.Context(), s.store, issue)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	for _, claim := range input.Claims {
		if declared := claimedRequirementSource(contract, claim); declared != nil && *declared != source {
			writeError(w, 400, fmt.Sprintf("export_source_mismatch: requirement %s/%s takes its material from %s", claim.CriterionID, claim.RequirementID, *declared))
			return
		}
	}
	raw, err := s.store.GetEvidenceRecord(r.Context(), issue.ID, "input", input.VerificationInputID)
	var bound store.VerificationInput
	if err == nil {
		err = json.Unmarshal(raw, &bound)
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	result, err := s.requestEvidenceWorker(r.Context(), issue, map[string]any{"action": "file_export", "sourceKind": input.SourceKind, "taskId": evidenceTaskID(issue.ID, r.Header.Get("Idempotency-Key"), "export"), "contract": contract, "input": bound, "repoId": input.RepoID, "relativePath": input.RelativePath, "claims": input.Claims, "carrier": input.Carrier})
	if err == nil {
		for _, m := range result.Materials {
			if err = s.store.RegisterMaterial(r.Context(), issue.ID, m); err != nil {
				break
			}
		}
	}
	if err == nil && len(result.Evidence) != 1 {
		err = fmt.Errorf("worker_export_missing")
	}
	if err == nil {
		err = s.store.RegisterExportEvidence(r.Context(), issue.ID, result.Evidence[0])
	}
	if err == nil {
		s.issues.EvidenceChanged(issue, result.Evidence[0].ID, input.ExpectedContractRevision, "registered")
	}
	writeEvidenceMutation(w, result, err)
}

// claimedRequirementSource is the source the claimed requirement names; nil
// when it names none or is not in the contract (the Worker rejects that claim).
func claimedRequirementSource(contract store.IssueContract, claim store.EvidenceClaim) *store.EvidenceRequirementSource {
	for _, criterion := range contract.Criteria {
		if criterion.ID != claim.CriterionID {
			continue
		}
		for _, r := range criterion.EvidenceRequirements {
			if r.ID == claim.RequirementID {
				return r.Source
			}
		}
	}
	return nil
}
