package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
)

func (s *Server) handleIssueStatusQuestion(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Message string `json:"message"`
	}
	if !decodeEvidenceRequest(w, r, "", &input) {
		return
	}
	st, ok := s.evidenceStore(w)
	if !ok {
		return
	}
	unlock := s.lockIssueMutation(r.PathValue("id"))
	defer unlock()
	issue, err := st.RecordIssueStatusQuestion(r.Context(), r.PathValue("id"), input.Message, r.Header.Get("Idempotency-Key"))
	if err == nil {
		s.events.Publish("issue_updated", issue)
	}
	writeEvidenceMutation(w, issue, err)
}

func (s *Server) handleEvidenceClarification(w http.ResponseWriter, r *http.Request) {
	actor := humanActor(r)
	var input struct {
		ExpectedRevision      int    `json:"expectedRevision"`
		ExpectedContentDigest string `json:"expectedContentDigest"`
		Message               string `json:"message"`
		ChangeReason          string `json:"changeReason"`
	}
	if !decodeEvidenceRequest(w, r, "", &input) {
		return
	}
	if strings.TrimSpace(input.Message) == "" || len(input.Message) > 16000 || strings.TrimSpace(input.ChangeReason) == "" {
		writeError(w, 400, "clarification message and revision reason required")
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
	replayed, found, err := st.ReplayClarification(r.Context(), issue.ID, input.ExpectedRevision, input.ExpectedContentDigest, input.Message, input.ChangeReason, actor, r.Header.Get("Idempotency-Key"))
	if err != nil || found {
		writeEvidenceMutation(w, replayed, err)
		return
	}
	if issue.Status == "accepted" || issue.Status == "abandoned" || issue.DraftContractRevision == nil ||
		*issue.DraftContractRevision != input.ExpectedRevision || (issue.Run != nil && issue.Run.Status == "running") ||
		(issue.Runtime != "claude" && issue.Runtime != "codex") {
		writeError(w, 409, "clarification requires a draft and an available selected Agent harness")
		return
	}
	contracts, err := st.ListEvidenceRecords(r.Context(), issue.ID, "contract")
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	var draft map[string]any
	for _, raw := range contracts {
		var candidate map[string]any
		if json.Unmarshal(raw, &candidate) == nil && candidate["revision"] == float64(input.ExpectedRevision) {
			draft = candidate
			break
		}
	}
	if draft == nil || draft["contentDigest"] != input.ExpectedContentDigest || draft["status"] != "draft" {
		writeError(w, 409, "clarification_draft_changed")
		return
	}
	messages := []map[string]string{}
	for _, m := range issue.Messages {
		if strings.HasPrefix(m.ID, "clarify_") {
			messages = append(messages, map[string]string{"role": m.Role, "text": m.Text})
		}
	}
	if len(messages) > 60 {
		writeError(w, 409, "clarification_context_full: edit the current contract draft directly")
		return
	}
	messages = append(messages, map[string]string{"role": "user", "text": input.Message})
	profile := issue.ProfileID
	if profile == "" {
		profile = issue.Runtime + "_local"
	}
	// The request host is not trusted for credentials; it only adds a deny-port.
	controlURL := "http://" + r.Host
	result, err := s.requestEvidenceWorker(r.Context(), issue, map[string]any{"action": "clarify", "taskId": evidenceTaskID(issue.ID, r.Header.Get("Idempotency-Key"), "clarify"),
		"draft": draft, "messages": messages, "harness": issue.Runtime, "profileId": profile, "requestedModel": issue.Model, "controlServerURL": controlURL})
	if err != nil {
		writeEvidenceMutation(w, nil, err)
		return
	}
	for _, m := range result.Materials {
		if err = st.RegisterMaterial(r.Context(), issue.ID, m); err != nil {
			writeEvidenceMutation(w, nil, err)
			return
		}
	}
	if result.Clarification == nil {
		writeError(w, 502, "clarification_response_missing")
		return
	}
	updated, err := st.RecordClarification(r.Context(), issue.ID, input.ExpectedRevision, input.ExpectedContentDigest, input.Message, input.ChangeReason, *result.Clarification, actor, r.Header.Get("Idempotency-Key"))
	if err == nil {
		s.events.Publish("issue_updated", updated)
		s.publishEvidenceUpdate(updated, result.TaskID, input.ExpectedRevision, "clarified")
	}
	writeEvidenceMutation(w, updated, err)
}
