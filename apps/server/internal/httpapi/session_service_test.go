package httpapi

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A request that names no agent is refused for people and agents, while
// Feishu, whose messages never name one, takes the workspace's first
// connected agent, else its first.
func TestSessionDevicePickingFallsBackOnlyForIntegrations(t *testing.T) {
	db, _ := lineageFixture(t)
	server := NewServer(db)
	ctx := context.Background()
	unnamed := store.CreateAgentSessionInput{WorkspaceID: "ws_lineage", Prompt: "hello"}

	input := unnamed
	if err := server.resolveSessionDevice(ctx, &input); errorStatus(err) != http.StatusBadRequest {
		t.Fatalf("a person's unnamed agent = %v, want 400", err)
	}

	input = unnamed
	if err := server.pickSessionDevice(ctx, &input, true); !errors.Is(err, ErrLocalDaemonNotConnected) {
		t.Fatalf("Feishu with its only agent offline = %v, want the conflict", err)
	}
	if input.AgentID != "agent_lineage" || input.Provider != "claude" {
		t.Fatalf("Feishu's fallback pinned %q/%q, want agent_lineage/claude", input.AgentID, input.Provider)
	}

	server.hub.connections["dev_lineage"] = newDaemonConnection(server.hub, nil)
	input = unnamed
	if err := server.pickSessionDevice(ctx, &input, true); err != nil {
		t.Fatalf("Feishu with its agent connected = %v, want it picked", err)
	}
	if input.AgentID != "agent_lineage" {
		t.Fatalf("Feishu's fallback pinned %q, want agent_lineage", input.AgentID)
	}
}
