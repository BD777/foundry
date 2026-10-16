package httpapi

import (
	"context"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNativeAccountResumeIsPersonOnly(t *testing.T) {
	if agentRouteAllowed(http.MethodPost, "/api/agent-profiles/resume-account") {
		t.Fatal("an agent must not override the account block")
	}
}

func TestNativeAccountTerminalSignalIsExplicit(t *testing.T) {
	for _, message := range []string{"403 forbidden", "401 expired", "429 rate limit", "account_on_hold", "The tool printed organization has been disabled"} {
		if nativeAccountTerminalError(message) != "" {
			t.Fatalf("ambiguous error classified as suspension: %s", message)
		}
	}
	if nativeAccountTerminalError("Your account is on hold and can't use Claude Code. (error type account_on_hold)") != "account_on_hold" {
		t.Fatal("explicit native hold not recognized")
	}
}

func TestNativeAccountResumeEndpointAndDispatchGate(t *testing.T) {
	ctx := context.Background()
	db := newEmptyTestStore(t)
	err := db.RegisterDaemon(ctx, store.DaemonRegistration{Device: store.DeviceProjection{ID: "dev_hold", Label: "Hold", Status: "connected"}, Workspace: store.WorkspaceProjection{ID: "ws_hold", Name: "Hold", LocalPath: t.TempDir(), Baseline: "main"}, AgentProfiles: []store.AgentProfileProjection{{ID: "claude_local", DeviceID: "dev_hold", Runtime: "claude", ConnectionType: "local_login", AccountLabel: "test@example.com", Status: "healthy"}}})
	if err != nil {
		t.Fatal(err)
	}
	session := store.AgentSession{ID: "sess_hold", DeviceID: "dev_hold", Provider: "claude", ProfileID: "claude_local", Input: store.SessionInput{ID: "input_hold"}}
	if err := db.BindNativeAccount(ctx, session); err != nil {
		t.Fatal(err)
	}
	if err := db.ObserveNativeAccountHold(ctx, session.ID, session.Input.ID, "account_on_hold"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	connection := &daemonConnection{hub: server.hub}
	if _, err := connection.sessionLaunchSpec(ctx, session); err == nil || !strings.Contains(err.Error(), "suspended") {
		t.Fatalf("launch bypassed account hold: %v", err)
	}
	rows, _ := db.ListAgentProfiles(ctx, "dev_hold")
	hold := rows[0].AccountHold
	for _, tc := range []struct {
		id     string
		status int
	}{{"outdated", http.StatusConflict}, {hold.ID, http.StatusOK}, {hold.ID, http.StatusConflict}} {
		body := fmt.Sprintf(`{"deviceId":"dev_hold","profileId":"claude_local","holdId":%q}`, tc.id)
		request := httptest.NewRequest(http.MethodPost, "/api/agent-profiles/resume-account", strings.NewReader(body))
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, request)
		if response.Code != tc.status {
			t.Fatalf("resume %s: %d %s", tc.id, response.Code, response.Body.String())
		}
	}
	if err := db.BindNativeAccount(ctx, session); err != nil {
		t.Fatalf("manual resume did not unblock: %v", err)
	}
}
