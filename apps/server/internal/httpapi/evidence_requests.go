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
