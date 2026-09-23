package httpapi

import (
	"context"
	"encoding/json"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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
	if _, err := db.ClaimNextIssue(context.Background(), "dev", "ws_security"); err == nil {
		t.Fatal("draft became executable")
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
		Name: "empty.txt", Carrier: "text_log", MimeType: "text/plain", ByteSize: 0,
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
		request := httptest.NewRequest(http.MethodPost, "/api/issues/"+issue.ID+"/conversation/status", strings.NewReader(`{"message":"这里是什么状态？"}`))
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
	if _, err := db.ClaimNextIssue(ctx, "dev", "ws_status"); err == nil {
		t.Fatal("status question dispatched draft")
	}
}
