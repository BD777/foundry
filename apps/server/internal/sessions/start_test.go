package sessions

import (
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A child inherits its parent's profile. With two Claude profiles on one
// device the profile must decide, not whichever Claude agent is listed first.
func TestSessionAgentFollowsTheProfileNotTheFirstOfItsRuntime(t *testing.T) {
	agents := []store.AgentProjection{
		{ID: "agent_official", DeviceID: "dev_a", Provider: "claude", ProfileID: "claude_local"},
		{ID: "agent_relay", DeviceID: "dev_a", Provider: "claude", ProfileID: "cc_relay"},
	}
	agent, ok := pickSessionAgent(agents, store.CreateAgentSessionInput{Provider: "claude", ProfileID: "cc_relay"})
	if !ok || agent.ID != "agent_relay" {
		t.Fatalf("picked %+v, want the relay profile's agent", agent)
	}
	if _, ok := pickSessionAgent(agents, store.CreateAgentSessionInput{Provider: "codex", ProfileID: "cc_relay"}); ok {
		t.Fatal("a profile of another runtime must not match")
	}
	if agent, _ := pickSessionAgent(agents, store.CreateAgentSessionInput{Provider: "claude"}); agent.ID != "agent_official" {
		t.Fatalf("runtime only = %+v, want the first agent of that runtime", agent)
	}
}
