package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// User actions use the existing local control-plane entry point. Agent proposals
// carry their own actor in the clarification flow; request bodies cannot set it.
func localOwnerActor() store.ActorRef {
	return store.ActorRef{Kind: "local_owner", ID: "local_owner", DisplayName: "Local owner"}
}
func decodeEvidenceRequest(w http.ResponseWriter, r *http.Request, name string, target any) bool {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if err == nil && name != "" {
		err = store.ValidateEvidenceJSON(name, raw)
	}
	if err == nil {
		decoder := json.NewDecoder(strings.NewReader(string(raw)))
		decoder.DisallowUnknownFields()
		err = decoder.Decode(target)
		if err == nil {
			var extra any
			if decoder.Decode(&extra) != io.EOF {
				writeError(w, http.StatusBadRequest, "expected one JSON object")
				return false
			}
		}
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return false
	}
	if strings.TrimSpace(r.Header.Get("Idempotency-Key")) == "" {
		writeError(w, http.StatusBadRequest, "idempotency_key_required")
		return false
	}
	return true
}
func (s *Server) evidenceStore(w http.ResponseWriter) (store.EvidenceStore, bool) {
	value, ok := s.store.(store.EvidenceStore)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "evidence store unavailable")
	}
	return value, ok
}
func (s *Server) handleContracts(w http.ResponseWriter, r *http.Request) {
	st, ok := s.evidenceStore(w)
	if !ok {
		return
	}
	if r.Method == http.MethodGet {
		items, err := st.ListEvidenceRecords(r.Context(), r.PathValue("id"), "contract")
		writeEvidencePage(w, r, items, err)
		return
	}
	actor := humanActor(r)
	issue, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	unlock := s.lockIssueMutation(issue.ID)
	defer unlock()
	var input store.ContractDraftInput
	if !decodeEvidenceRequest(w, r, "ContractDraftInput", &input) {
		return
	}
	c, err := st.CreateContract(r.Context(), r.PathValue("id"), input, actor, r.Header.Get("Idempotency-Key"))
	if err == nil {
		s.publishEvidenceUpdate(issue, c.ID, c.Revision, c.Status)
	}
	writeEvidenceMutation(w, c, err)
}
func (s *Server) handleLegacyContractImport(w http.ResponseWriter, r *http.Request) {
	actor := humanActor(r)
	st, ok := s.evidenceStore(w)
	if !ok {
		return
	}
	var input struct{}
	if !decodeEvidenceRequest(w, r, "", &input) {
		return
	}
	issue, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	unlock := s.lockIssueMutation(issue.ID)
	defer unlock()
	contract, err := st.ImportLegacyContract(r.Context(), issue.ID, actor, r.Header.Get("Idempotency-Key"))
	if err == nil {
		s.publishEvidenceUpdate(issue, contract.ID, contract.Revision, "draft")
	}
	writeEvidenceMutation(w, contract, err)
}
func (s *Server) handleContractAction(w http.ResponseWriter, r *http.Request) {
	st, ok := s.evidenceStore(w)
	if !ok {
		return
	}
	actor := humanActor(r)
	issue, lookupErr := s.store.GetIssue(r.Context(), r.PathValue("id"))
	if lookupErr != nil {
		writeResult(w, nil, lookupErr)
		return
	}
	unlock := s.lockIssueMutation(issue.ID)
	defer unlock()
	revision, err := strconv.Atoi(r.PathValue("revision"))
	if err != nil || revision < 1 {
		writeError(w, 400, "invalid revision")
		return
	}
	var input struct {
		ExpectedContentDigest string `json:"expectedContentDigest"`
		Reason                string `json:"reason"`
	}
	if !decodeEvidenceRequest(w, r, "", &input) {
		return
	}
	var c store.IssueContract
	switch r.PathValue("action") {
	case "confirm":
		c, err = st.ConfirmContract(r.Context(), r.PathValue("id"), revision, input.ExpectedContentDigest, actor, r.Header.Get("Idempotency-Key"))
	case "discard":
		c, err = st.DiscardContract(r.Context(), r.PathValue("id"), revision, input.Reason, actor, r.Header.Get("Idempotency-Key"))
	default:
		writeError(w, 404, "unknown contract action")
		return
	}
	if err == nil && c.Status == "confirmed" {
		go s.hub.DispatchReady()
	}
	if err == nil {
		s.publishEvidenceUpdate(issue, c.ID, c.Revision, c.Status)
	}
	writeEvidenceMutation(w, c, err)
}
func writeEvidenceMutation(w http.ResponseWriter, value any, err error) {
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, value)
}
func writeEvidencePage(w http.ResponseWriter, r *http.Request, items []json.RawMessage, err error) {
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	if size < 1 {
		size = 20
	}
	if size > 100 {
		size = 100
	}
	start := len(items)
	if page <= (len(items)/size)+1 {
		start = (page - 1) * size
	}
	if start > len(items) {
		start = len(items)
	}
	end := start + size
	if end > len(items) {
		end = len(items)
	}
	writeJSON(w, 200, map[string]any{"items": items[start:end], "page": page, "pageSize": size, "total": len(items)})
}
