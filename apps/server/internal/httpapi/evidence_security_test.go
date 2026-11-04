package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestContractUsesExistingControlAccessAndServerAssignedActor(t *testing.T) {
	db := newTestStore(t)
	issue, err := db.CreateIssue(context.Background(), store.CreateIssueInput{WorkspaceID: "ws_security", SourceInput: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServerWithOptions(db, ServerOptions{})
	body := `{"baseRevision":1,"changeReason":"Specify real scope","content":{"goal":{"text":"Fix API validation","media":[]},"inScope":[],"outOfScope":[],"constraints":[],"criteria":[]}}`
	for _, credential := range []string{"", "wrong"} {
		request := httptest.NewRequest(http.MethodPost, "/api/issues/"+issue.ID+"/contracts", strings.NewReader(body))
		request.Header.Set("Idempotency-Key", "attempt")
		request.Header.Set("Authorization", "Bearer "+credential)
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("normal API authentication got %d: %s", response.Code, response.Body.String())
		}
	}
	withTestOwner(server)
	request := httptest.NewRequest(http.MethodPost, "/api/issues/"+issue.ID+"/contracts", strings.NewReader(body))
	request.Header.Set("Idempotency-Key", "real")
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("user proposal failed: %s", response.Body.String())
	}
	var c store.IssueContract
	if json.Unmarshal(response.Body.Bytes(), &c) != nil || c.CreatedBy.Kind != "user" || c.CreatedBy.ID != testOwner.ID {
		t.Fatal("user action actor was not assigned by server")
	}
	request = httptest.NewRequest(http.MethodPost, "/api/issues/"+issue.ID+"/contracts", strings.NewReader(strings.TrimSuffix(body, "}")+`,"actor":{"kind":"agent","id":"forged"}}`))
	request.Header.Set("Idempotency-Key", "forged-actor")
	response = httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("caller supplied actor accepted: %d %s", response.Code, response.Body.String())
	}
	if _, _, err := db.ClaimIssueExecution(context.Background(), "dev", "ws_security"); err == nil {
		t.Fatal("draft became executable")
	}
}

func TestContractDryRunReportsProblemsWithoutWriting(t *testing.T) {
	db := newTestStore(t)
	issue, err := db.CreateIssue(context.Background(), store.CreateIssueInput{WorkspaceID: "ws_dry_run", SourceInput: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServerWithOptions(db, ServerOptions{})
	withTestOwner(server)
	validate := func(body string) (int, []string) {
		request := httptest.NewRequest(http.MethodPost, "/api/issues/"+issue.ID+"/contracts/validate", strings.NewReader(body))
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, request)
		var result struct {
			Problems []string `json:"problems"`
		}
		_ = json.Unmarshal(response.Body.Bytes(), &result)
		return response.Code, result.Problems
	}
	empty := `{"goal":{"text":"","media":[]},"inScope":[],"outOfScope":[],"constraints":[],"criteria":[]}`
	if code, problems := validate(`{"content":` + empty + `}`); code != http.StatusOK || problems == nil || len(problems) != 0 {
		t.Fatalf("an empty draft is savable: %d %v", code, problems)
	}
	if code, problems := validate(`{"content":` + empty + `,"confirming":true}`); code != http.StatusOK || len(problems) != 1 {
		t.Fatalf("an empty draft cannot be confirmed: %d %v", code, problems)
	}
	if code, problems := validate(`{"content":{"goal":{"text":"x","media":[]}}}`); code != http.StatusOK || len(problems) != 1 {
		t.Fatalf("a schema violation is a problem: %d %v", code, problems)
	}
	if code, _ := validate(`{"content":` + empty + `,"write":true}`); code != http.StatusBadRequest {
		t.Fatalf("unknown request field accepted: %d", code)
	}
	contracts, err := db.ListEvidenceRecords(context.Background(), issue.ID, "contract")
	if err != nil || len(contracts) != 1 {
		t.Fatal("a dry run wrote a contract", len(contracts), err)
	}
}

// An export asks its source for a carrier the source produces: the change
// list is data, never a text_log.
func TestExportCarrierMustBeOneItsSourceProduces(t *testing.T) {
	db := newTestStore(t)
	issue, err := db.CreateIssue(context.Background(), store.CreateIssueInput{WorkspaceID: "ws_export_carrier", SourceInput: "Create hello.txt"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServerWithOptions(db, ServerOptions{})
	withTestOwner(server)
	for body, want := range map[string]string{
		`{"expectedContractRevision":1,"verificationInputId":"input","repoId":"","relativePath":"","claims":[],"carrier":"text_log","sourceKind":"candidate_changes"}`: "export_carrier_not_produced: candidate_changes produces [data]",
		`{"expectedContractRevision":1,"verificationInputId":"input","repoId":"repo","relativePath":"logo.png","claims":[],"carrier":"image"}`:                         "export_carrier_not_produced: candidate_file produces",
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/issues/"+issue.ID+"/evidence/export", strings.NewReader(body))
		request.Header.Set("Idempotency-Key", "export")
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), want) {
			t.Fatalf("export of an unproduced carrier: %d %s", response.Code, response.Body.String())
		}
	}
}

func TestEmptyMaterialDownloadStillRequiresAvailableWorker(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_empty", SourceInput: "Review empty output"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	material := store.Material{
		SchemaVersion: 1, ID: "empty_material", WorkspaceID: issue.WorkspaceID, IssueID: issue.ID,
		CreatedAt: now, CreatedBy: store.ActorRef{Kind: "daemon", ID: "worker", DisplayName: "Worker"},
		Name: "empty.txt", Carrier: "text_log", MIMEType: "text/plain", ByteSize: 0,
		Digest:          "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		StorageDeviceID: "worker", CapturedAt: now, Redaction: store.MaterialRedaction{Status: "none"},
		PreviewMaterialIDs: []string{}, Availability: "available", AvailabilityCheckedAt: now,
	}
	if err = db.RegisterMaterial(ctx, issue.ID, material); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/issues/"+issue.ID+"/materials/"+material.ID+"/content", nil)
	response := httptest.NewRecorder()
	NewServer(db).Routes().ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("offline zero-byte material was treated as available: %d %s", response.Code, response.Body.String())
	}
}

func TestStatusConversationNeedsNoExtraCredentialAndNeverDispatches(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: "ws_status", SourceInput: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	for range 2 {
		request := httptest.NewRequest(http.MethodPost, "/api/issues/"+issue.ID+"/messages", strings.NewReader(`{"text":"这里是什么状态？"}`))
		request.Header.Set("Idempotency-Key", "status-question")
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("status conversation failed: %d: %s", response.Code, response.Body.String())
		}
	}
	updated, err := db.GetIssue(ctx, issue.ID)
	if err != nil || len(updated.Messages) != 2 || updated.Status != issue.Status || updated.CurrentContractRevision != nil {
		t.Fatalf("status question changed execution state: %+v, %v", updated, err)
	}
	if _, _, err := db.ClaimIssueExecution(ctx, "dev", "ws_status"); err == nil {
		t.Fatal("status question dispatched draft")
	}
}
