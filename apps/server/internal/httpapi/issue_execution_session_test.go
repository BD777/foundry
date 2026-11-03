package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

// An Issue's execution is an ordinary session: while it runs it is steered
// and stopped through the session's own endpoints, whatever its runtime;
// once it ended, what is said about it goes to its Issue.
func TestIssueExecutionIsSteeredAndStoppedAsASession(t *testing.T) {
	for _, runtime := range []string{"claude", "codex"} {
		t.Run(runtime, func(t *testing.T) {
			db := newTestStore(t)
			ctx := context.Background()
			server := NewServer(db)
			reg := store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_" + runtime}, Workspace: store.WorkspaceProjection{ID: "ws_" + runtime}}
			if err := db.RegisterDaemon(ctx, reg); err != nil {
				t.Fatal(err)
			}
			issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: reg.Workspace.ID, Title: "Steer", Runtime: runtime})
			if err != nil {
				t.Fatal(err)
			}
			testfixture.ConfirmContract(t, db, issue.ID)
			_, session, err := db.ClaimIssueExecution(ctx, reg.Device.ID, reg.Workspace.ID)
			if err != nil {
				t.Fatal(err)
			}
			started, err := db.StartAgentSession(ctx, session.ID)
			if err != nil {
				t.Fatal(err)
			}
			server.issueService.Observer().SessionChanged(ctx, sessions.Started, started)
			connection := &daemonConnection{hub: server.hub, done: make(chan struct{}), send: make(chan wsEnvelope, 8), rpc: newDaemonRPC()}
			server.hub.connections[reg.Device.ID] = connection
			// device answers the next request of kind with reply and returns
			// what the request carried.
			device := func(kind string, reply any) json.RawMessage {
				t.Helper()
				select {
				case envelope := <-connection.send:
					if envelope.Type != kind {
						t.Fatalf("device got %s, want %s", envelope.Type, kind)
					}
					raw, _ := json.Marshal(reply)
					connection.rpc.resolve(envelope.ID, raw)
					return envelope.Payload
				case <-time.After(5 * time.Second):
					t.Fatalf("no %s reached the device", kind)
					return nil
				}
			}

			steered := make(chan error, 1)
			go func() {
				_, err := server.sessionService.Send(ctx, session.ID, store.SendAgentSessionInput{Prompt: "Focus on the mobile layout", Delivery: store.DeliveryBoundary}, nil)
				steered <- err
			}()
			var steer wsSteerSessionPayload
			if err := json.Unmarshal(device(wsSteerSessionType, map[string]any{"sessionId": session.ID}), &steer); err != nil {
				t.Fatal(err)
			}
			if err := <-steered; err != nil {
				t.Fatalf("steer: %v", err)
			}
			if steer.SessionID != session.ID || steer.Message != "Focus on the mobile layout" || steer.Delivery != store.DeliveryBoundary || steer.InputID == "" {
				t.Fatalf("steer_session = %+v", steer)
			}

			stopped := make(chan error, 1)
			go func() {
				_, err := server.sessionService.Cancel(ctx, session.ID, "")
				stopped <- err
			}()
			var cancel wsCancelSessionPayload
			if err := json.Unmarshal(device(wsCancelSessionType, map[string]any{"sessionId": session.ID, "pending": true}), &cancel); err != nil {
				t.Fatal(err)
			}
			if err := <-stopped; err != nil {
				t.Fatalf("cancel: %v", err)
			}
			if cancel.SessionID != session.ID || cancel.InputID != session.Input.ID {
				t.Fatalf("cancel_session = %+v", cancel)
			}
			canceled, err := db.GetAgentSessionRecord(ctx, session.ID)
			if err != nil || canceled.Status != "canceled" {
				t.Fatalf("canceled session = %s, %v", canceled.Status, err)
			}

			// The device's report of the stop settles the Issue.
			server.hub.settleIssueSession(ctx, canceled, &store.CompleteIssueInput{Canceled: true, RunID: session.ID, Error: "Issue execution canceled; candidate files are retained"}, nil)
			current, err := db.GetIssue(ctx, issue.ID)
			if err != nil || current.Status != "blocked" || current.Run == nil || current.Run.Status != "canceled" {
				t.Fatalf("Issue after the stop = %s %#v, %v", current.Status, current.Run, err)
			}

			// An ended execution takes nothing more: its Issue continues.
			if _, err := server.sessionService.Send(ctx, session.ID, store.SendAgentSessionInput{Prompt: "run it again"}, nil); errorStatus(err) != http.StatusConflict || !errors.Is(err, store.ErrSessionControlledByIssue) {
				t.Fatalf("a message to an ended execution: %v", err)
			}
			if _, err := server.sessionService.Cancel(ctx, session.ID, ""); errorStatus(err) != http.StatusConflict || !errors.Is(err, store.ErrSessionControlledByIssue) {
				t.Fatalf("a stop of an ended execution: %v", err)
			}
			if _, err := db.SendAgentSessionInput(ctx, session.ID, store.SendAgentSessionInput{Prompt: "x"}); err == nil {
				t.Fatal("the store accepted input for an Issue execution")
			}
		})
	}
}

// The Issue conversation reads its executions in one request, each with its
// newest events, as a chat reads its sessions.
func TestIssueExecutionsAreReadInOneRequest(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	server := NewServer(db)
	reg := store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_read"}, Workspace: store.WorkspaceProjection{ID: "ws_read"}}
	if err := db.RegisterDaemon(ctx, reg); err != nil {
		t.Fatal(err)
	}
	issue, err := db.CreateIssue(ctx, store.CreateIssueInput{WorkspaceID: reg.Workspace.ID, Title: "Read", Runtime: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, db, issue.ID)
	var executions []store.AgentSession
	for attempt := range 2 {
		_, session, err := db.ClaimIssueExecution(ctx, reg.Device.ID, reg.Workspace.ID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.StartIssueRun(ctx, issue.ID, store.Run{ID: session.ID}); err != nil {
			t.Fatal(err)
		}
		for index := range 3 {
			if err := db.AppendAgentSessionEvent(ctx, store.AgentSessionEvent{ID: session.ID + "_step_" + string(rune('a'+index)), SessionID: session.ID, At: time.Now().UTC().Format(time.RFC3339Nano), Label: "Ran command", Detail: "step", Level: "info"}); err != nil {
				t.Fatal(err)
			}
		}
		executions = append(executions, session)
		if attempt == 0 {
			if _, err := db.CompleteIssue(ctx, issue.ID, store.CompleteIssueInput{RunID: session.ID, Canceled: true}); err != nil {
				t.Fatal(err)
			}
			if _, err := db.RequestIssueChanges(ctx, issue.ID, "Continue", session.ID, ""); err != nil {
				t.Fatal(err)
			}
		}
	}
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/issues/"+issue.ID+"/executions?eventsLimit=2", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("read executions: %d %s", response.Code, response.Body.String())
	}
	var pages []windowedAgentSession
	if err := json.Unmarshal(response.Body.Bytes(), &pages); err != nil {
		t.Fatal(err)
	}
	if len(pages) != 2 || pages[0].ID != executions[0].ID || pages[1].ID != executions[1].ID {
		t.Fatalf("executions = %+v", pages)
	}
	for _, page := range pages {
		if page.Role != store.AgentSessionRoleIssueExecution || len(page.Events) != 2 || page.EventsBefore == "" {
			t.Fatalf("execution %s: role %q, %d events, before %q", page.ID, page.Role, len(page.Events), page.EventsBefore)
		}
	}
}
