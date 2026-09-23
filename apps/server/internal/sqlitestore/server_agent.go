package sqlitestore

import (
	"context"
	"errors"

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

// resolveSessionAgent finds the agent a new session runs, accepting either a
// daemon-reported row persisted in the agents table or the trusted server
// projection of a bound server profile.
func (s *Store) resolveSessionAgent(
	ctx context.Context,
	input store.CreateAgentSessionInput,
) (store.AgentProjection, error) {
	agent, err := s.getAgent(ctx, input.AgentID, input.WorkspaceID, input.Provider)
	if err == nil {
		return agent, nil
	}
	if !errors.Is(err, store.ErrNotFound) || input.AgentID == "" || input.WorkspaceID == "" {
		return store.AgentProjection{}, err
	}
	return s.resolveProjectedServerAgent(ctx, input.AgentID, input.WorkspaceID)
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
