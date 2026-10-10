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

func TestIssueInAWorkspaceWithoutGitNeedsConfirmation(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registration := store.DaemonRegistration{
		Capabilities: []string{store.DaemonCapabilityWorkspaceGitSetup},
		Device:       store.DeviceProjection{ID: "dev_git"},
		Workspace:    store.WorkspaceProjection{ID: "ws_git", LocalPath: "/home/me/notes"},
	}
	if err := db.RegisterDaemon(ctx, registration); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	connection := &daemonConnection{hub: server.hub, done: make(chan struct{}), send: make(chan wsEnvelope, 8), rpc: newDaemonRPC(), deviceID: "dev_git", registration: registration}
	server.hub.connections["dev_git"] = connection

	var actions []string
	// The worker: the folder has no Git until initialize_git runs.
	ready := false
	worker := func(t *testing.T) {
		t.Helper()
		select {
		case envelope := <-connection.send:
			var payload map[string]any
			if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
				t.Fatal(err)
			}
			action, _ := payload["action"].(string)
			if envelope.Type != wsIssueEnvironmentType || payload["workspaceId"] != "ws_git" {
				t.Fatalf("unexpected request %s %#v", envelope.Type, payload)
			}
			actions = append(actions, action)
			if action == "initialize_git" {
				ready = true
			}
			status := "needs_git"
			if ready {
				status = "ready"
			}
			connection.rpc.resolve(envelope.ID, json.RawMessage(`{"status":"`+status+`","revision":0}`))
		case <-time.After(5 * time.Second):
			t.Fatal("the worker was not asked")
		}
	}
	create := func(key, body string, answers int) *httptest.ResponseRecorder {
		result := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			request := httptest.NewRequest(http.MethodPost, "/api/issues", strings.NewReader(body))
			request.Header.Set("Idempotency-Key", key)
			response := httptest.NewRecorder()
			server.Routes().ServeHTTP(response, request)
			result <- response
		}()
		for range answers {
			worker(t)
		}
		return <-result
	}
	issues := func() int {
		items, err := db.ListIssues(ctx, "ws_git")
		if err != nil {
			t.Fatal(err)
		}
		return len(items)
	}

	response := create("first", `{"workspaceId":"ws_git","sourceInput":"Fix the README"}`, 1)
	if response.Code != http.StatusConflict {
		t.Fatalf("an Issue was created without Git: %d %s", response.Code, response.Body.String())
	}
	var refusal map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &refusal); err != nil {
		t.Fatal(err)
	}
	if refusal["code"] != "workspace_needs_git" || refusal["error"] != "this workspace needs Git first; confirm to initialize" || refusal["path"] != "/home/me/notes" {
		t.Fatalf("unclear refusal: %#v", refusal)
	}
	if issues() != 0 || ready || strings.Join(actions, ",") != "git_status" {
		t.Fatalf("a refused creation changed something: %d issues, actions %v", issues(), actions)
	}

	response = create("first", `{"workspaceId":"ws_git","sourceInput":"Fix the README","initializeGit":true}`, 2)
	if response.Code != http.StatusCreated {
		t.Fatalf("confirmed creation: %d %s", response.Code, response.Body.String())
	}
	if issues() != 1 || strings.Join(actions, ",") != "git_status,git_status,initialize_git" {
		t.Fatalf("confirmed creation: %d issues, actions %v", issues(), actions)
	}

	// Once Git is there, nothing is asked for.
	response = create("second", `{"workspaceId":"ws_git","sourceInput":"Another"}`, 1)
	if response.Code != http.StatusCreated || issues() != 2 {
		t.Fatalf("creation in a ready workspace: %d %s", response.Code, response.Body.String())
	}
}

func TestIssueCreationDoesNotAskAWorkerThatSetsUpGitItself(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	registration := store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_old"}, Workspace: store.WorkspaceProjection{ID: "ws_old"}}
	if err := db.RegisterDaemon(ctx, registration); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	connection := &daemonConnection{hub: server.hub, done: make(chan struct{}), send: make(chan wsEnvelope, 8), rpc: newDaemonRPC(), deviceID: "dev_old", registration: registration}
	server.hub.connections["dev_old"] = connection
	request := httptest.NewRequest(http.MethodPost, "/api/issues", strings.NewReader(`{"workspaceId":"ws_old","sourceInput":"hi"}`))
	request.Header.Set("Idempotency-Key", "old")
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusCreated || len(connection.send) != 0 {
		t.Fatalf("older worker: %d %s, %d requests", response.Code, response.Body.String(), len(connection.send))
	}
}
