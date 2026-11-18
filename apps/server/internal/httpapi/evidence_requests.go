package httpapi

import (
	"encoding/json"
	"errors"
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

// decodeEvidenceRequest decodes a mutating request's body (decodeEvidenceJSON)
// and requires its Idempotency-Key header.
func decodeEvidenceRequest(w http.ResponseWriter, r *http.Request, name string, target any) bool {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if err == nil {
		err = decodeEvidenceJSON(raw, name, target)
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

var errExpectedOneObject = errors.New("expected one JSON object")

// decodeEvidenceJSON is the validation every Issue write applies to its JSON
// object, from the HTTP routes and the MCP issues tool alike: the model's
// schema when name is given, no unknown fields, exactly one object.
func decodeEvidenceJSON(raw []byte, name string, target any) error {
	if name != "" {
		if err := store.ValidateEvidenceJSON(name, raw); err != nil {
			return err
		}
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errExpectedOneObject
	}
	return nil
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
