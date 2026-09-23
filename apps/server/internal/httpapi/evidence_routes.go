package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func evidenceTaskID(issueID, key, action string) string {
	h := sha256.Sum256([]byte(issueID + "\x00" + key + "\x00" + action))
	return "task_" + hex.EncodeToString(h[:])
}
func (s *Server) handleEvidenceList(w http.ResponseWriter, r *http.Request) {
	st, ok := s.evidenceStore(w)
	if !ok {
		return
	}
	kind := r.PathValue("collection")
	switch kind {
	case "evidence":
	case "verifications":
		kind = "verification"
	case "verification-inputs":
		kind = "input"
	case "candidate-snapshots":
		kind = "candidate"
	case "materials":
		kind = "material"
	case "human-assessments":
		kind = "assessment"
	default:
		writeError(w, 404, "unknown evidence collection")
		return
	}
	if id := r.PathValue("recordId"); id != "" {
		item, err := st.GetEvidenceRecord(r.Context(), r.PathValue("id"), kind, id)
		writeResult(w, item, err)
		return
	}
	items, err := st.ListEvidenceRecords(r.Context(), r.PathValue("id"), kind)
	writeEvidencePage(w, r, items, err)
}
func (s *Server) handleEvidenceSnapshot(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ExpectedContractRevision int    `json:"expectedContractRevision"`
		AlignFromSnapshotID      string `json:"alignFromSnapshotId,omitempty"`
		HTTPTargets              []struct {
			Name                   string `json:"name"`
			EntrypointRelativePath string `json:"entrypointRelativePath"`
		} `json:"httpTargets,omitempty"`
	}
	if !decodeEvidenceRequest(w, r, "", &input) {
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
	issue, err = s.store.GetIssue(r.Context(), issue.ID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if issue.ContractState != "confirmed" || issue.CurrentContractRevision == nil || *issue.CurrentContractRevision != input.ExpectedContractRevision {
		writeError(w, 409, "contract_revision_conflict")
		return
	}
	contract, err := currentIssueContract(r.Context(), st, issue)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	request := map[string]any{"action": "seal", "taskId": evidenceTaskID(issue.ID, r.Header.Get("Idempotency-Key"), "seal"), "contract": contract}
	if input.AlignFromSnapshotID != "" {
		if issue.Status != "verifying" || issue.CurrentCandidateSnapshotID == nil {
			writeError(w, 409, "alignment_input_changed")
			return
		}
		if _, err = st.GetEvidenceRecord(r.Context(), issue.ID, "candidate", input.AlignFromSnapshotID); err != nil {
			writeEvidenceMutation(w, nil, err)
			return
		}
		request["alignFromSnapshotId"] = input.AlignFromSnapshotID
	}
	if len(input.HTTPTargets) > 0 {
		request["httpTargets"] = input.HTTPTargets
	}
	result, err := s.requestEvidenceWorker(r.Context(), issue, request)
	if err == nil {
		for _, m := range result.Materials {
			if err = st.RegisterMaterial(r.Context(), issue.ID, m); err != nil {
				break
			}
		}
	}
	if err == nil && (result.Candidate == nil || result.Input == nil) {
		err = fmt.Errorf("worker omitted candidate or input")
	}
	if err == nil {
		if input.AlignFromSnapshotID == "" {
			err = st.RegisterCandidate(r.Context(), issue.ID, *result.Candidate, *result.Input)
		} else {
			err = st.RegisterAlignedCandidate(r.Context(), issue.ID, input.AlignFromSnapshotID, *result.Candidate, *result.Input)
		}
	}
	if err == nil {
		s.publishEvidenceUpdate(issue, result.Candidate.ID, input.ExpectedContractRevision, "sealed")
	}
	writeEvidenceMutation(w, result, err)
}
func currentIssueContract(ctx context.Context, st store.EvidenceStore, issue store.Issue) (store.IssueContract, error) {
	var contract store.IssueContract
	if issue.CurrentContractRevision == nil {
		return contract, fmt.Errorf("contract_confirmation_required")
	}
	records, err := st.ListEvidenceRecords(ctx, issue.ID, "contract")
	if err != nil {
		return contract, err
	}
	for _, raw := range records {
		if err = json.Unmarshal(raw, &contract); err != nil {
			return contract, err
		}
		if contract.Revision == *issue.CurrentContractRevision {
			return contract, nil
		}
	}
	return contract, fmt.Errorf("contract_missing")
}
func (s *Server) handleVerifyEvidence(w http.ResponseWriter, r *http.Request) {
	actor := humanActor(r)
	var input struct {
		ExpectedContractRevision    int      `json:"expectedContractRevision"`
		ExpectedCandidateSnapshotID string   `json:"expectedCandidateSnapshotId"`
		CriterionIDs                []string `json:"criterionIds"`
	}
	if !decodeEvidenceRequest(w, r, "", &input) {
		return
	}
	if len(input.CriterionIDs) == 0 || len(input.CriterionIDs) > 100 {
		writeError(w, 400, "criterionIds must contain 1–100 criteria")
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
	// Resolve the device and check its tombstone before any contract/work
	// validation: a removed device is refused regardless of request shape, and
	// the in-transaction gate in RequestVerification closes the TOCTOU window
	// between this read and the queued-row write.
	workspace, err := s.store.GetWorkspace(r.Context(), issue.WorkspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	removed, err := s.store.DeviceRemoved(r.Context(), workspace.DeviceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if removed {
		writeError(w, http.StatusGone, "device_removed")
		return
	}
	contract, err := currentIssueContract(r.Context(), st, issue)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if s.hub.connectionFor(workspace.DeviceID) == nil {
		writeError(w, 503, "worker_offline")
		return
	}
	results := []store.Verification{}
	for _, id := range input.CriterionIDs {
		v, err := st.RequestVerification(r.Context(), issue.ID, input.ExpectedContractRevision, input.ExpectedCandidateSnapshotID, id, actor, r.Header.Get("Idempotency-Key"))
		if err != nil {
			writeEvidenceMutation(w, nil, err)
			return
		}
		results = append(results, v)
		s.publishEvidenceUpdate(issue, v.ID, v.Sequence, v.Status)
		if v.Status == "queued" {
			go s.dispatchVerification(issue, contract, v)
		}
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"items": results})
}
func (s *Server) dispatchVerification(issue store.Issue, contract store.IssueContract, v store.Verification) {
	// Worker holds one candidate/evidence lock per Issue while observing it.
	// Keep siblings queued here rather than racing its bounded file-lock wait.
	unlockIssueDispatch := s.lockIssueMutation("verification-issue/" + issue.ID)
	defer unlockIssueDispatch()
	unlockDispatch := s.lockIssueMutation("verification-dispatch/" + v.ID)
	defer unlockDispatch()
	st, ok := s.store.(store.EvidenceStore)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	current, err := st.StartVerification(ctx, issue.ID, v.ID)
	if err != nil {
		return
	}
	if current.Status != "running" {
		s.publishEvidenceUpdate(issue, current.ID, current.Sequence, current.Status)
		return
	}
	v = current
	s.publishEvidenceUpdate(issue, v.ID, v.Sequence, v.Status)
	raw, err := st.GetEvidenceRecord(ctx, issue.ID, "input", v.VerificationInputID)
	var input store.VerificationInput
	if err == nil {
		err = json.Unmarshal(raw, &input)
	}
	var result wsEvidenceResult
	if err == nil {
		action := "collect"
		request := map[string]any{"taskId": v.ID, "contract": contract, "verification": v, "input": input}
		if v.Mode == "agent" {
			action = "assess"
			evidence := []store.Evidence{}
			for _, id := range v.EvidenceIDs {
				raw, readErr := st.GetEvidenceRecord(ctx, issue.ID, "evidence", id)
				if readErr != nil {
					err = readErr
					break
				}
				var e store.Evidence
				if readErr = json.Unmarshal(raw, &e); readErr != nil {
					err = readErr
					break
				}
				evidence = append(evidence, e)
			}
			request["evidence"] = evidence
		}
		request["action"] = action
		if err == nil {
			result, err = s.requestEvidenceWorker(ctx, issue, request)
			if err != nil && result.Error == "" {
				finishCtx, finishCancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer finishCancel()
				_ = st.MarkVerificationInterrupted(finishCtx, issue.ID, v.ID)
				return
			}
		}
	}
	if err == nil {
		for _, m := range result.Materials {
			if err = st.RegisterMaterial(ctx, issue.ID, m); err != nil {
				break
			}
		}
	}
	if err == nil && result.Verification != nil {
		unlock := s.lockIssueMutation(issue.ID)
		err = st.CompleteVerification(ctx, issue.ID, *result.Verification, result.Evidence)
		unlock()
		if err == nil {
			s.publishEvidenceUpdate(issue, v.ID, v.Sequence, result.Verification.Status)
			return
		}
	}
	if err == nil {
		err = fmt.Errorf("worker omitted judgment")
	}
	v.Status = "failed"
	v.Error = &store.VerificationError{Code: "verification_transport_error", Message: err.Error(), Retryable: false}
	finished := time.Now().UTC().Format(time.RFC3339Nano)
	v.FinishedAt = &finished
	// Persist technical failure even after request timeout; do not replay the tool.
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer finishCancel()
	unlock := s.lockIssueMutation(issue.ID)
	defer unlock()
	_ = st.CompleteVerification(finishCtx, issue.ID, v, nil)
	s.publishEvidenceUpdate(issue, v.ID, v.Sequence, v.Status)
}
func (s *Server) handleHumanAssessment(w http.ResponseWriter, r *http.Request) {
	unlock := s.lockIssueMutation(r.PathValue("id"))
	defer unlock()
	actor := humanActor(r)
	var input store.HumanAssessmentInput
	if !decodeEvidenceRequest(w, r, "", &input) {
		return
	}
	st, ok := s.evidenceStore(w)
	if !ok {
		return
	}
	value, err := st.CreateHumanAssessment(r.Context(), r.PathValue("id"), input, actor, r.Header.Get("Idempotency-Key"))
	if err == nil {
		s.publishEvidenceUpdate(store.Issue{ID: value.IssueID, WorkspaceID: value.WorkspaceID}, value.ID, value.ContractRevision, value.Verdict)
	}
	writeEvidenceMutation(w, value, err)
}
func (s *Server) handleHumanEvidence(w http.ResponseWriter, r *http.Request) {
	unlock := s.lockIssueMutation(r.PathValue("id"))
	defer unlock()
	actor := humanActor(r)
	var input store.HumanEvidenceInput
	if !decodeEvidenceRequest(w, r, "", &input) {
		return
	}
	st, ok := s.evidenceStore(w)
	if !ok {
		return
	}
	value, err := st.RegisterHumanEvidence(r.Context(), r.PathValue("id"), input, actor, r.Header.Get("Idempotency-Key"))
	if err == nil {
		s.publishEvidenceUpdate(store.Issue{ID: value.IssueID, WorkspaceID: value.WorkspaceID}, value.ID, input.ExpectedContractRevision, "registered")
	}
	writeEvidenceMutation(w, value, err)
}

func (s *Server) handleMaterialUpload(w http.ResponseWriter, r *http.Request) {
	actor := humanActor(r)
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key == "" || len(key) > 200 {
		writeError(w, 400, "idempotency_key_required")
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
	name := r.URL.Query().Get("name")
	if name == "" || len(name) > 512 {
		writeError(w, 400, "material name required")
		return
	}
	carrier := r.URL.Query().Get("carrier")
	if carrier == "" {
		carrier = "file"
	}
	raw, _ := json.Marshal(carrier)
	if store.ValidateEvidenceJSON("CarrierKind", raw) != nil {
		writeError(w, 400, "invalid carrier")
		return
	}
	taskID := evidenceTaskID(issue.ID, key, "upload")
	body := http.MaxBytesReader(w, r.Body, 100<<20)
	offset := 0
	for {
		chunk := make([]byte, 256<<10)
		n, readErr := io.ReadFull(body, chunk)
		if n > 0 {
			_, err = s.requestEvidenceWorker(r.Context(), issue, map[string]any{"action": "upload_chunk", "taskId": taskID, "offset": offset, "bytesBase64": base64.StdEncoding.EncodeToString(chunk[:n])})
			if err != nil {
				writeEvidenceMutation(w, nil, err)
				return
			}
			offset += n
		}
		if readErr == io.EOF || readErr == io.ErrUnexpectedEOF {
			break
		}
		if readErr != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "upload exceeds 100 MiB or is incomplete")
			return
		}
	}
	result, err := s.requestEvidenceWorker(r.Context(), issue, map[string]any{"action": "upload_seal", "taskId": taskID, "name": name, "carrier": carrier, "byteSize": offset, "actor": actor})
	if err == nil {
		for _, material := range result.Materials {
			if err = st.RegisterMaterial(r.Context(), issue.ID, material); err != nil {
				break
			}
		}
	}
	if err != nil {
		writeEvidenceMutation(w, nil, err)
		return
	}
	if len(result.Materials) != 1 {
		writeError(w, 502, "worker omitted sealed material")
		return
	}
	s.publishEvidenceUpdate(issue, result.Materials[0].ID, 1, "available")
	writeJSON(w, 201, result.Materials[0])
}
func (s *Server) handleMaterialContent(w http.ResponseWriter, r *http.Request) {
	st, ok := s.evidenceStore(w)
	if !ok {
		return
	}
	issue, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	raw, err := st.GetEvidenceRecord(r.Context(), issue.ID, "material", r.PathValue("materialId"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	var material store.Material
	if err = json.Unmarshal(raw, &material); err != nil {
		writeResult(w, nil, err)
		return
	}
	// Always download active formats; never execute HTML/SVG in the application origin.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(material.ByteSize))
	if material.ByteSize == 0 {
		result, readErr := s.requestEvidenceWorker(r.Context(), issue, map[string]any{"action": "read", "taskId": evidenceTaskID(issue.ID, material.ID, "0"), "materialId": material.ID, "offset": 0})
		emptyDigest := sha256.Sum256(nil)
		if readErr != nil || result.ByteSize != 0 || result.BytesBase64 != "" || material.Digest != "sha256:"+hex.EncodeToString(emptyDigest[:]) {
			w.Header().Del("Content-Length")
			writeError(w, http.StatusServiceUnavailable, "material unavailable")
		}
		return
	}
	hash := sha256.New()
	for offset := 0; offset < material.ByteSize; {
		result, err := s.requestEvidenceWorker(r.Context(), issue, map[string]any{"action": "read", "taskId": evidenceTaskID(issue.ID, material.ID, strconv.Itoa(offset)), "materialId": material.ID, "offset": offset})
		if err != nil {
			if offset == 0 {
				w.Header().Del("Content-Length")
				writeError(w, 503, "material unavailable")
			}
			return
		}
		bytes, err := base64.StdEncoding.DecodeString(result.BytesBase64)
		if err != nil || len(bytes) == 0 || result.ByteSize != material.ByteSize {
			return
		}
		if offset+len(bytes) > material.ByteSize {
			return
		}
		hash.Write(bytes)
		offset += len(bytes)
		if offset == material.ByteSize && "sha256:"+hex.EncodeToString(hash.Sum(nil)) != material.Digest {
			return
		}
		if _, err = w.Write(bytes); err != nil {
			return
		}
	}
}
