package httpapi

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A Codex session reports what it showed about its compatible endpoint's
// Responses WebSocket on its transcript; the server keeps it for the server
// profile that session ran, and only for that one.
func TestCodexTransportLearnedFromTheSessionThatRanIt(t *testing.T) {
	db := newSecretTestStore(t)
	ctx := context.Background()
	const deviceID, workspaceID = "dev_ws", "ws_ws"
	agents := []store.AgentProjection{{
		ID:          store.ServerAgentID(deviceID, workspaceID, "codex_local"),
		WorkspaceID: workspaceID, DeviceID: deviceID, Provider: "codex", ProfileID: "codex_local", Status: "healthy",
	}}
	device := store.DeviceProjection{ID: deviceID, Label: "box", Status: "connected", LastSeenLabel: "online"}
	workspace := store.WorkspaceProjection{ID: workspaceID, Name: "W", LocalPath: "/w"}
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{Device: device, Workspace: workspace, Agents: agents}); err != nil {
		t.Fatalf("register daemon: %v", err)
	}
	gateway, err := db.SaveProfile(ctx, store.SaveProfileInput{
		Runtime: "codex", Label: "Gateway", AuthMode: "custom",
		ConnectionType: "openai_compatible", BaseURL: "http://127.0.0.1:9/v1",
	})
	if err != nil {
		t.Fatalf("save profile: %v", err)
	}
	other, err := db.SaveProfile(ctx, store.SaveProfileInput{
		Runtime: "codex", Label: "Other", AuthMode: "custom",
		ConnectionType: "openai_compatible", BaseURL: "http://127.0.0.1:10/v1",
	})
	if err != nil {
		t.Fatalf("save other: %v", err)
	}
	if err := db.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: deviceID, ProfileIDs: []string{gateway.ID, other.ID}}); err != nil {
		t.Fatalf("bind: %v", err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		WorkspaceID: workspaceID, AgentID: store.ServerAgentID(deviceID, workspaceID, gateway.ID), Prompt: "hi", Source: "chat",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	live := httptest.NewServer(NewServer(db).Routes())
	t.Cleanup(live.Close)
	fake := connectFakeDevice(t, live, "", map[string]any{
		"activeSessionIds": []string{session.ID},
		"device":           device,
		"workspace":        workspace,
		"agents":           agents,
	}, nil)
	report := func(id string, transport store.CodexTransportReport) {
		fake.tell(t, wsSessionEventType, wsSessionEventPayload{Event: store.AgentSessionEvent{
			ID: id, SessionID: session.ID, Label: "Notice", Detail: "transport", Level: "info",
			Metadata: &store.AgentSessionEventMetadata{CodexTransport: &transport},
		}})
	}
	learned := func(id string) *store.CodexTransportObservation {
		t.Helper()
		profile, err := db.GetProfile(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return profile.CodexTransportLearned
	}

	// Another profile than the session's, and a base URL the profile does
	// not have, are not kept.
	report("evt_other", store.CodexTransportReport{ProfileID: other.ID, BaseURL: other.BaseURL, Transport: store.CodexTransportHTTPS})
	report("evt_url", store.CodexTransportReport{ProfileID: gateway.ID, BaseURL: "http://elsewhere/v1", Transport: store.CodexTransportHTTPS})
	if learned(other.ID) != nil || learned(gateway.ID) != nil {
		t.Fatal("a report for another profile or base URL was kept")
	}

	report("evt_fallback", store.CodexTransportReport{ProfileID: gateway.ID, BaseURL: gateway.BaseURL, Transport: store.CodexTransportHTTPS, Detail: "unexpected status 404 Not Found"})
	got := learned(gateway.ID)
	if got == nil || got.Transport != store.CodexTransportHTTPS || got.Detail != "unexpected status 404 Not Found" {
		t.Fatalf("learned = %+v, want https with Codex's reason", got)
	}
}

func TestProfileCodexTransportChoice(t *testing.T) {
	input := store.SaveProfileInput{Runtime: "codex", Label: "G", AuthMode: "custom", BaseURL: "https://g/v1"}
	if message := normalizeProfileInput(&input, true); message != "" || input.CodexTransport != store.CodexTransportAuto {
		t.Fatalf("empty is auto on a compatible Codex endpoint: %q %q", message, input.CodexTransport)
	}
	input.CodexTransport = "carrier-pigeon"
	if message := normalizeProfileInput(&input, true); message == "" {
		t.Fatal("an unknown transport was accepted")
	}
	claude := store.SaveProfileInput{Runtime: "claude", Label: "C", AuthMode: "custom", BaseURL: "https://c", CodexTransport: "https"}
	if message := normalizeProfileInput(&claude, true); message != "" || claude.CodexTransport != "" {
		t.Fatalf("a Claude profile keeps no Codex transport: %q %q", message, claude.CodexTransport)
	}
}
