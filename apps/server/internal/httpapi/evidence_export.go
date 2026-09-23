package httpapi

import (
	"encoding/json"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
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
	if input.SourceKind != "" && input.SourceKind != "candidate_file" && input.SourceKind != "candidate_changes" {
		writeError(w, 400, "unsupported_export_source")
		return
	}
	if input.SourceKind == "candidate_changes" && (input.Carrier != "data" || input.RepoID != "" || input.RelativePath != "") {
		writeError(w, 400, "candidate_changes_requires_data_without_file_path")
		return
	}
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
	if issue.CurrentContractRevision == nil || *issue.CurrentContractRevision != input.ExpectedContractRevision || issue.ContractState != "confirmed" {
		writeError(w, 409, "contract_changed")
		return
	}
	contract, err := currentIssueContract(r.Context(), st, issue)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	raw, err := st.GetEvidenceRecord(r.Context(), issue.ID, "input", input.VerificationInputID)
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
			if err = st.RegisterMaterial(r.Context(), issue.ID, m); err != nil {
				break
			}
		}
	}
	if err == nil && len(result.Evidence) != 1 {
		err = fmt.Errorf("worker_export_missing")
	}
	if err == nil {
		err = st.RegisterExportEvidence(r.Context(), issue.ID, result.Evidence[0])
	}
	if err == nil {
		s.publishEvidenceUpdate(issue, result.Evidence[0].ID, input.ExpectedContractRevision, "registered")
	}
	writeEvidenceMutation(w, result, err)
}
