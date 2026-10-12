package sqlitestore

import (
	"context"
	"errors"
	"fmt"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// resolveProjectedServerAgent resolves an agent id that names a server-owned
// profile projected onto one workspace. Such agents are deliberately never
// persisted (see httpapi.serverProfileProjections), so the agents table cannot
// answer for them.
//
// Nothing here trusts client input: the candidate id must equal the id the
// server itself derives for (the workspace's owning device, that workspace, a
// profile that exists and is enabled on that device). It runs inside the
// session-create transaction, so a binding revoked between the check and the
// insert cannot win, and the caller's removed-device gate still applies to the
// resolved device.
func (s *Store) resolveProjectedServerAgent(
	ctx context.Context,
	agentID string,
	workspaceID string,
) (store.AgentProjection, error) {
	workspace, err := s.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return store.AgentProjection{}, err
	}
	deviceID := workspace.DeviceID
	if deviceID == "" {
		return store.AgentProjection{}, store.ErrNotFound
	}
	// Only profiles the device is actually allowed to run can project an agent
	// for this workspace. Re-derived from rows inside the transaction.
	bindings, err := s.ListDeviceProfiles(ctx, deviceID)
	if err != nil {
		return store.AgentProjection{}, err
	}
	// The projected id normalises profile/device/workspace segments (dashes and
	// underscores collide). Two distinct profiles bound to the same device can
	// therefore derive the same id; that identity is ambiguous, so it must
	// never silently pick an account — reject any candidate with >1 match.
	var matches []store.AgentProjection
	for _, binding := range bindings {
		if !binding.Enabled || binding.ProfileID == "" {
			continue
		}
		profile, err := s.GetProfile(ctx, binding.ProfileID)
		if errors.Is(err, store.ErrProfileNotFound) {
			continue
		}
		if err != nil {
			return store.AgentProjection{}, err
		}
		if store.ServerAgentID(deviceID, workspaceID, profile.ID) != agentID {
			continue
		}
		matches = append(matches, store.AgentProjection{
			ID:           agentID,
			WorkspaceID:  workspaceID,
			DeviceID:     deviceID,
			Provider:     profile.Runtime,
			ProfileID:    profile.ID,
			ProfileLabel: profile.Label,
		})
	}
	if len(matches) == 0 {
		return store.AgentProjection{}, store.ErrNotFound
	}
	distinct := map[string]bool{}
	for _, match := range matches {
		distinct[match.ProfileID] = true
	}
	if len(distinct) > 1 {
		return store.AgentProjection{}, store.ErrNotFound
	}
	return matches[0], nil
}

// resolveSessionAgent finds the agent a session runs, most specific first:
// its agent id, else its profile, else the newest agent of its runtime. An
// agent is a daemon-reported row persisted in the agents table or the trusted
// server projection of a bound server profile. A named profile is never
// traded for another agent of the same runtime, and a provider that
// contradicts it is refused.
func (s *Store) resolveSessionAgent(
	ctx context.Context,
	input store.CreateAgentSessionInput,
) (store.AgentProjection, error) {
	var agent store.AgentProjection
	var err error
	switch {
	case input.AgentID == "" && input.ProfileID != "":
		agent, err = s.resolveProfileAgent(ctx, input.WorkspaceID, input.ProfileID)
		if err == nil && input.Provider != "" && agent.Provider != input.Provider {
			return store.AgentProjection{}, fmt.Errorf("%w: profile %s runs %s, not %s; omit provider or name a %s profile",
				store.ErrProfileRuntimeMismatch, input.ProfileID, agent.Provider, input.Provider, input.Provider)
		}
	default:
		agent, err = s.getAgent(ctx, input.AgentID, input.WorkspaceID, input.Provider)
		if err == nil {
			return agent, nil
		}
		if !errors.Is(err, store.ErrNotFound) || input.AgentID == "" || input.WorkspaceID == "" {
			return store.AgentProjection{}, err
		}
		agent, err = s.resolveProjectedServerAgent(ctx, input.AgentID, input.WorkspaceID)
	}
	if errors.Is(err, store.ErrNotFound) {
		// A removed device's agents were purged with it; say why.
		if workspace, lookup := s.GetWorkspace(ctx, input.WorkspaceID); lookup == nil && workspace.DeviceID != "" {
			if removed := s.assertDeviceNotRemoved(ctx, workspace.DeviceID); removed != nil {
				return store.AgentProjection{}, removed
			}
		}
	}
	return agent, err
}

// resolveProfileAgent finds a profile's agent in a workspace: the row its
// device reported, else the projection of a server profile bound to the
// workspace's device. Server profiles never have rows (see
// resolveProjectedServerAgent), so the table alone cannot answer.
func (s *Store) resolveProfileAgent(ctx context.Context, workspaceID string, profileID string) (store.AgentProjection, error) {
	if workspaceID == "" {
		return store.AgentProjection{}, store.ErrNotFound
	}
	agents, err := listJSON[store.AgentProjection](ctx, s.conn(), `SELECT payload_json FROM agents WHERE workspace_id = ? ORDER BY updated_at DESC, provider`, workspaceID)
	if err != nil {
		return store.AgentProjection{}, err
	}
	for _, agent := range agents {
		if agent.ProfileID == profileID {
			return agent, nil
		}
	}
	workspace, err := s.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return store.AgentProjection{}, err
	}
	if workspace.DeviceID == "" {
		return store.AgentProjection{}, store.ErrNotFound
	}
	return s.resolveProjectedServerAgent(ctx, store.ServerAgentID(workspace.DeviceID, workspaceID, profileID), workspaceID)
}

// ResolveSessionAgent is the read-only, transaction-free counterpart of the
// resolution createAgentSession repeats inside its write transaction. The
// HTTP layer uses it only to identify the execution device (the daemon
// connection guard); it never inserts work on this read, and the write path
// re-resolves, so a revoked binding cannot slip between the two.
func (s *Store) ResolveSessionAgent(
	ctx context.Context,
	input store.CreateAgentSessionInput,
) (store.AgentProjection, error) {
	return s.resolveSessionAgent(ctx, input)
}
