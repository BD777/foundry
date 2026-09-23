package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

func TestLegacyAcceptCannotBypassStructuredReview(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	reg := store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_accept"}, Workspace: store.WorkspaceProjection{ID: "ws_accept", LocalPath: "/tmp/accept"}}
	if err := db.RegisterDaemon(ctx, reg); err != nil {
		t.Fatal(err)
	}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: reg.Workspace.ID, Title: "candidate"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, db, issue.ID)
	if _, err = db.StartIssueRun(ctx, issue.ID, store.Run{ID: "run_accept", IssueID: issue.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err = db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{RunID: "run_accept", EnvironmentID: "env_accept", EnvironmentRevision: 3, Artifact: store.AcceptanceArtifact{ID: "art_accept", IssueID: issue.ID}}); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	request := func(body string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/issues/"+issue.ID+"/accept", strings.NewReader(body))
		request.Header.Set("Idempotency-Key", "legacy-accept")
		server.Routes().ServeHTTP(response, request)
		return response
	}
	if response := request(`{"revision":2}`); response.Code != http.StatusConflict {
		t.Fatalf("stale revision accepted: %d", response.Code)
	}
	if response := request(`{"revision":3}`); response.Code != http.StatusConflict {
		t.Fatalf("offline acceptance succeeded: %d", response.Code)
	}
	connection := &daemonConnection{hub: server.hub, done: make(chan struct{}), send: make(chan wsEnvelope, 8), rpc: newDaemonRPC()}
	server.hub.connections[reg.Device.ID] = connection
	if response := request(`{"revision":3}`); response.Code != http.StatusConflict {
		t.Fatalf("connected device bypassed review: %d", response.Code)
	}
	if len(connection.send) != 0 {
		t.Fatal("legacy request reached integration worker")
	}
	current, _ := db.GetIssue(ctx, issue.ID)
	if current.Status != "verifying" {
		t.Fatalf("expected verifying, got %s", current.Status)
	}
}

func TestIssueSteerRequiresCurrentClaudeExecutionAndDeviceAcknowledgement(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	reg := store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_steer"}, Workspace: store.WorkspaceProjection{ID: "ws_steer"}}
	if err := db.RegisterDaemon(ctx, reg); err != nil {
		t.Fatal(err)
	}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: reg.Workspace.ID, Runtime: "claude", Title: "Steer"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, db, issue.ID)
	if _, err = db.StartIssueRun(ctx, issue.ID, store.Run{ID: "run_steer", IssueID: issue.ID, Runtime: "claude"}); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	request := func(body string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/issues/"+issue.ID+"/environment/steer", strings.NewReader(body)))
		return response
	}
	if response := request(`{"message":"check mobile","expectedRunId":"old"}`); response.Code != http.StatusConflict {
		t.Fatalf("stale steer: %d", response.Code)
	}
	if response := request(`{"message":" ","expectedRunId":"run_steer"}`); response.Code != http.StatusBadRequest {
		t.Fatalf("empty steer: %d", response.Code)
	}
	if response := request(`{"message":"check mobile","expectedRunId":"run_steer"}`); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("offline steer: %d", response.Code)
	}
	connection := &daemonConnection{hub: server.hub, done: make(chan struct{}), send: make(chan wsEnvelope, 8), rpc: newDaemonRPC()}
	server.hub.connections[reg.Device.ID] = connection
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- request(`{"message":"check mobile","expectedRunId":"run_steer"}`) }()
	select {
	case envelope := <-connection.send:
		var payload map[string]any
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if payload["message"] != "check mobile" || payload["expectedRunId"] != "run_steer" || payload["issueId"] != issue.ID {
			t.Fatalf("wrong target: %#v", payload)
		}
		connection.rpc.resolve(envelope.ID, json.RawMessage(`{"status":"steered","revision":0}`))
	case <-time.After(time.Second):
		t.Fatal("steer was not forwarded")
	}
	if response := <-result; response.Code != http.StatusOK {
		t.Fatalf("steer failed: %d %s", response.Code, response.Body.String())
	}
}

func TestIssueDispatchCapacitySpansRegisteredWorkspaces(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	server := NewServer(db)
	first := store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_capacity", RuntimeSettings: &store.AgentRuntimeSettings{MaxConcurrentTasks: 2}}, Workspace: store.WorkspaceProjection{ID: "ws_a"}}
	second := first
	second.Workspace.ID = "ws_b"
	for _, registration := range []store.DaemonRegistration{first, second} {
		if err := db.RegisterDaemon(ctx, registration); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 3; i++ {
			issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: registration.Workspace.ID, Title: "parallel"})
			if err != nil {
				t.Fatal(err)
			}
			testfixture.ConfirmContract(t, db, issue.ID)
		}
	}
	connection := &daemonConnection{hub: server.hub, done: make(chan struct{}), send: make(chan wsEnvelope, 16), deviceID: first.Device.ID, registration: first, registrations: map[string]store.DaemonRegistration{first.Workspace.ID: first, second.Workspace.ID: second}}
	var wait sync.WaitGroup
	for i := 0; i < 8; i++ {
		wait.Add(1)
		go func() { defer wait.Done(); connection.claimAndSend() }()
	}
	wait.Wait()
	if len(connection.send) != 2 {
		t.Fatalf("expected capacity 2, dispatched %d", len(connection.send))
	}
	seen := map[string]bool{}
	for len(connection.send) > 0 {
		var payload wsRunIssuePayload
		if err := json.Unmarshal((<-connection.send).Payload, &payload); err != nil {
			t.Fatal(err)
		}
		seen[payload.Issue.WorkspaceID] = true
	}
	if len(seen) != 2 {
		t.Fatalf("secondary workspace starved: %#v", seen)
	}
}

func TestAbandonEndpointRetainsIssueAndRejectsAcceptance(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	reg := store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_abandon"}, Workspace: store.WorkspaceProjection{ID: "ws_abandon"}}
	if err := db.RegisterDaemon(ctx, reg); err != nil {
		t.Fatal(err)
	}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: reg.Workspace.ID, Title: "Abandon pending issue"})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/issues/"+issue.ID+"/abandon", strings.NewReader(`{}`)))
	if response.Code != http.StatusOK {
		t.Fatalf("abandon: %d %s", response.Code, response.Body.String())
	}
	saved, _ := db.GetIssue(ctx, issue.ID)
	if saved.Status != "abandoned" {
		t.Fatalf("Issue missing: %#v", saved)
	}
	response = httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/issues/"+issue.ID+"/accept", strings.NewReader(`{}`))
	request.Header.Set("Idempotency-Key", "abandoned-accept")
	server.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("abandoned candidate accepted: %d", response.Code)
	}
}
