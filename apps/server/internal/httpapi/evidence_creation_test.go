package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIssueCreationIsIdempotentAndNeverAutoConfirms(t *testing.T) {
	db := newTestStore(t)
	server := NewServer(db)
	send := func(key, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/issues", strings.NewReader(body))
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, req)
		return response
	}
	if response := send("", `{"sourceInput":"hi"}`); response.Code != http.StatusBadRequest {
		t.Fatal("creation accepted a missing idempotency key")
	}
	body := `{"workspaceId":"ws_create","sourceInput":"hi"}`
	first := send("create", body)
	second := send("create", body)
	if first.Code != http.StatusCreated || second.Code != http.StatusCreated || first.Body.String() != second.Body.String() {
		t.Fatalf("create replay mismatch: %s / %s", first.Body.String(), second.Body.String())
	}
	if response := send("create", `{"workspaceId":"ws_create","sourceInput":"changed goal"}`); response.Code != http.StatusConflict {
		t.Fatal("same creation key changed its content")
	}
	issues, err := db.ListIssues(context.Background(), "ws_create")
	if err != nil || len(issues) != 1 || issues[0].ContractState != "draft" || len(issues[0].AcceptanceCriteria) != 0 {
		t.Fatalf("unexpected creation result: %+v %v", issues, err)
	}
}
