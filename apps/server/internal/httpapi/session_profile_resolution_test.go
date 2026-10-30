package httpapi

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A device like linux-dev on dev (2026-10-12): daemon rows for Claude Local,
// Codex Local and a Codex gateway profile, plus a server profile bound to the
// device, which never has an agents row. Codex Local is reported first, so a
// lookup by runtime alone lands on it. The device then re-registers (hello)
// and stays connected, so sessions are created and dispatched.
type profileResolutionFixture struct {
	db      *sqlitestore.Store
	call    func(tool string, arguments any) (string, bool)
	server  store.ProfileDefinition
	parent  store.AgentSession
	gateway string
	seen    map[string]bool
}

const (
	profileResolutionDevice    = "dev_byte"
	profileResolutionWorkspace = "ws_byte"
)

func setupProfileResolutionFixture(t *testing.T) profileResolutionFixture {
	t.Helper()
	db := newSecretTestStore(t)
	ctx := context.Background()
	var agents []store.AgentProjection
	for _, profile := range [][2]string{{"claude", "claude_local"}, {"codex", "codex_local"}, {"codex", "codex_provider_llm_gateway"}} {
		agents = append(agents, store.AgentProjection{
			ID:          store.ServerAgentID(profileResolutionDevice, profileResolutionWorkspace, profile[1]),
			WorkspaceID: profileResolutionWorkspace, DeviceID: profileResolutionDevice,
			Provider: profile[0], ProfileID: profile[1], Status: "healthy",
		})
	}
	device := store.DeviceProjection{ID: profileResolutionDevice, Label: "linux-dev", Status: "connected", LastSeenLabel: "online"}
	workspace := store.WorkspaceProjection{ID: profileResolutionWorkspace, Name: "Foundry", LocalPath: "/work/foundry"}
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{Device: device, Workspace: workspace, Agents: agents}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
	server, err := db.SaveProfile(ctx, store.SaveProfileInput{
		Runtime: "claude", Label: "gemini-dev-sg",
		ConnectionType: "anthropic_compatible", BaseURL: "https://gateway.internal",
	})
	if err != nil {
		t.Fatalf("save profile: %v", err)
	}
	if err := db.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: profileResolutionDevice, ProfileIDs: []string{server.ID}}); err != nil {
		t.Fatalf("bind profile: %v", err)
	}
	parent, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: profileResolutionWorkspace, AgentID: agents[0].ID, Prompt: "parent", Source: "chat",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}
	token, err := db.MintAgentSessionToken(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewServer(db).Routes()
	live := httptest.NewServer(handler)
	t.Cleanup(live.Close)
	connectFakeDevice(t, live, "", map[string]any{
		"activeSessionIds": []string{parent.ID},
		"device":           device,
		"workspace":        workspace,
		"agents":           agents,
	}, nil)
	return profileResolutionFixture{
		db:      db,
		call:    mcpToolCaller(t, handler, token),
		server:  server,
		parent:  parent,
		gateway: "codex_provider_llm_gateway",
		seen:    map[string]bool{},
	}
}

// newChild is the one child session created since the last call.
func (f profileResolutionFixture) newChild(t *testing.T) store.AgentSession {
	t.Helper()
	sessions, err := f.db.ListAgentSessionSummaries(context.Background(), profileResolutionWorkspace)
	if err != nil {
		t.Fatal(err)
	}
	var created []store.AgentSession
	for _, session := range sessions {
		if session.ParentSessionID == f.parent.ID && session.Source != "naming" && !f.seen[session.ID] {
			f.seen[session.ID] = true
			created = append(created, session)
		}
	}
	if len(created) != 1 {
		t.Fatalf("created %d child sessions, want 1", len(created))
	}
	return created[0]
}

// A server profile has no agents row on any device, before or after a
// re-registration; naming it by profileId alone must still start a session
// on it, with or without the runtime it runs.
func TestCreateSessionByProfileIDReachesServerProfile(t *testing.T) {
	f := setupProfileResolutionFixture(t)
	for _, arguments := range []map[string]any{
		{"workspaceId": profileResolutionWorkspace, "profileId": f.server.ID, "prompt": "go"},
		{"workspaceId": profileResolutionWorkspace, "profileId": f.server.ID, "provider": "claude", "prompt": "go"},
	} {
		if text, isError := f.call("create_session", arguments); isError {
			t.Fatalf("create_session %v = %q", arguments, text)
		}
		if child := f.newChild(t); child.ProfileID != f.server.ID || child.Provider != "claude" {
			t.Fatalf("create_session %v ran %s/%s, want %s", arguments, child.Provider, child.ProfileID, f.server.ID)
		}
	}
}

// An explicit profile is never traded for another agent of the provider's
// runtime: a daemon profile wins over the runtime's first agent, and a
// provider that contradicts the profile is refused, saying so.
func TestCreateSessionProfileIDWinsOverProvider(t *testing.T) {
	f := setupProfileResolutionFixture(t)
	arguments := map[string]any{"workspaceId": profileResolutionWorkspace, "profileId": f.gateway, "provider": "codex", "prompt": "go"}
	if text, isError := f.call("create_session", arguments); isError {
		t.Fatalf("create_session %v = %q", arguments, text)
	}
	if child := f.newChild(t); child.ProfileID != f.gateway {
		t.Fatalf("create_session %v ran profile %s, want %s", arguments, child.ProfileID, f.gateway)
	}
	text, isError := f.call("create_session", map[string]any{"workspaceId": profileResolutionWorkspace, "profileId": f.server.ID, "provider": "codex", "prompt": "go"})
	if !isError || !strings.Contains(text, "profile "+f.server.ID+" runs claude, not codex") {
		t.Fatalf("contradictory provider/profile = %q, want it refused", text)
	}
}

// The sess_1791532977920187026 report: send_message with provider and
// profileId ran Codex Local, the runtime's first agent, instead of the profile.
func TestSendMessageProfileIDWinsOverProvider(t *testing.T) {
	f := setupProfileResolutionFixture(t)
	ctx := context.Background()
	child, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: profileResolutionWorkspace, AgentID: f.parent.AgentID, Prompt: "child", Source: "agent", ParentSessionID: f.parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.CompleteAgentSession(ctx, child.ID, "done", ""); err != nil {
		t.Fatal(err)
	}
	for _, target := range []struct{ provider, profile string }{
		{"codex", f.gateway},
		{"", f.server.ID},
	} {
		arguments := map[string]any{"sessionId": child.ID, "prompt": "continue", "profileId": target.profile}
		if target.provider != "" {
			arguments["provider"] = target.provider
		}
		if text, isError := f.call("send_message", arguments); isError {
			t.Fatalf("send_message %v = %q", arguments, text)
		}
		switched, err := f.db.GetAgentSessionSummary(ctx, child.ID)
		if err != nil {
			t.Fatal(err)
		}
		if switched.ProfileID != target.profile {
			t.Fatalf("send_message %v switched to %s/%s, want %s", arguments, switched.Provider, switched.ProfileID, target.profile)
		}
		if _, err := f.db.CompleteAgentSession(ctx, child.ID, "done", ""); err != nil {
			t.Fatal(err)
		}
	}
	text, isError := f.call("send_message", map[string]any{"sessionId": child.ID, "prompt": "continue", "profileId": f.gateway, "provider": "claude"})
	if !isError || !strings.Contains(text, "profile "+f.gateway+" runs codex, not claude") {
		t.Fatalf("contradictory provider/profile = %q, want it refused", text)
	}
}
