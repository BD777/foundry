package sessions

import (
	"context"
	"errors"
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Start creates a session on the agent its input names and hands it
// to that agent's device, or leaves it waiting while that device is offline
// (DispatchOrWait). A refusal is a Refusal; a session its connected
// device could not take comes back failed, with StatusConflict.
func (s *Service) Start(ctx context.Context, input store.CreateAgentSessionInput) (store.AgentSession, error) {
	if err := s.ResolveDevice(ctx, &input); err != nil {
		return store.AgentSession{}, err
	}
	return s.DispatchNew(ctx, input, true, nil)
}

// DispatchNew creates and dispatches a resolved input
// (CreateAndDispatch), with its refusals as Refusals: a session its
// connected device could not take comes back failed, with StatusConflict;
// a removed device is StatusGone.
func (s *Service) DispatchNew(ctx context.Context, input store.CreateAgentSessionInput, reconcile bool, beforeDispatch func(context.Context) error) (store.AgentSession, error) {
	session, err := s.CreateAndDispatch(ctx, input, reconcile, beforeDispatch)
	switch {
	case err == nil:
		return session, nil
	case errors.Is(err, ErrLocalDaemonNotConnected):
		return session, &Refusal{http.StatusConflict, err}
	case errors.Is(err, store.ErrDeviceRemoved):
		return store.AgentSession{}, &Refusal{http.StatusGone, errors.New("device_removed")}
	default:
		return store.AgentSession{}, err
	}
}

// pickSessionAgent chooses the agent a request names, most specific first:
// its agent id, else its profile (within the requested runtime), else the
// first agent of its runtime.
func pickSessionAgent(agents []store.AgentProjection, input store.CreateAgentSessionInput) (store.AgentProjection, bool) {
	match := func(ok func(store.AgentProjection) bool) (store.AgentProjection, bool) {
		for _, agent := range agents {
			if ok(agent) {
				return agent, true
			}
		}
		return store.AgentProjection{}, false
	}
	switch {
	case input.AgentID != "":
		return match(func(agent store.AgentProjection) bool { return agent.ID == input.AgentID })
	case input.ProfileID != "":
		return match(func(agent store.AgentProjection) bool {
			return agent.ProfileID == input.ProfileID && (input.Provider == "" || agent.Provider == input.Provider)
		})
	case input.Provider != "":
		return match(func(agent store.AgentProjection) bool { return agent.Provider == input.Provider })
	}
	return store.AgentProjection{}, false
}

// ResolveDevice finds the agent a new session runs on and checks its
// device is reachable by the caller; an offline one is not refused, its
// session waits for it. It may pin input.AgentID. A refusal is a
// statusError; any other err is an ordinary failure. Callers authorize the
// workspace first; an agent picked here always belongs to it, so a session
// token reaches exactly the devices of workspaces its scope grants.
func (s *Service) ResolveDevice(ctx context.Context, input *store.CreateAgentSessionInput) error {
	_, err := s.sessionDevice(ctx, input, false)
	return err
}

// PickDevice is ResolveDevice for work that does not wait: it
// also refuses a device that is offline. With anyAgent, a request no agent
// answers (none named, none found, or its device removed) takes the
// workspace's first connected agent, else its first, pinning it; a
// workspace without agents is left to the dispatch to fail.
func (s *Service) PickDevice(ctx context.Context, input *store.CreateAgentSessionInput, anyAgent bool) error {
	deviceID, err := s.sessionDevice(ctx, input, anyAgent)
	if err != nil || deviceID == "" {
		return err
	}
	if !s.devices.Connected(deviceID) {
		return &Refusal{http.StatusConflict, ErrLocalDaemonNotConnected}
	}
	return nil
}

// sessionDevice is the device the session input runs on, as
// PickDevice resolves it, connected or not; "" for a workspace
// without agents (anyAgent).
func (s *Service) sessionDevice(ctx context.Context, input *store.CreateAgentSessionInput, anyAgent bool) (string, error) {
	if refusal := s.policy.UnservedWorkspace(ctx, input.WorkspaceID); refusal != nil {
		return "", &Refusal{http.StatusConflict, refusal}
	}
	// A runtime without a profile, or an integration's message naming
	// nothing, runs under an account that can work on the device
	// (Policy.ChooseSessionAccount), never the runtime's first. MCP callers get
	// the same for a request naming nothing (httpapi's resolveNewSession); a
	// person's REST request naming nothing stays refused.
	if input.Provider != "" || anyAgent {
		if err := s.policy.ChooseSessionAccount(ctx, input); err != nil {
			return "", err
		}
	}
	agents, err := s.store.ListAgents(ctx, input.WorkspaceID, "")
	if err != nil {
		return "", err
	}
	deviceID := ""
	if agent, ok := pickSessionAgent(agents, *input); ok {
		deviceID = agent.DeviceID
		if input.AgentID == "" && input.ProfileID != "" {
			input.AgentID, input.Provider = agent.ID, agent.Provider
		}
	}
	// Server-owned profile agents are projected per snapshot, never persisted
	// as agents rows (see httpapi's serverProfileProjections). Resolve that id from the
	// trusted workspace -> device -> enabled binding -> profile chain so a
	// picker selection can start a session; client fields never authorise it.
	if deviceID == "" && (input.AgentID != "" || input.ProfileID != "") {
		resolved, resolveErr := s.store.ResolveSessionAgent(ctx, *input)
		switch {
		case resolveErr == nil:
			deviceID = resolved.DeviceID
			if input.AgentID == "" {
				input.AgentID, input.Provider = resolved.ID, resolved.Provider
			}
		case errors.Is(resolveErr, store.ErrProfileRuntimeMismatch):
			return "", &Refusal{http.StatusBadRequest, resolveErr}
		case errors.Is(resolveErr, store.ErrDeviceRemoved) && !anyAgent:
			return "", &Refusal{http.StatusGone, errors.New("device_removed")}
		case !errors.Is(resolveErr, store.ErrNotFound) &&
			!errors.Is(resolveErr, store.ErrProfileNotFound) &&
			!errors.Is(resolveErr, store.ErrDeviceRemoved):
			return "", resolveErr
		}
	}
	if deviceID == "" && anyAgent {
		if len(agents) == 0 {
			return "", nil
		}
		agent := agents[0]
		for _, candidate := range agents {
			if s.devices.Connected(candidate.DeviceID) {
				agent = candidate
				break
			}
		}
		deviceID, input.AgentID, input.Provider = agent.DeviceID, agent.ID, agent.Provider
	}
	if deviceID == "" {
		return "", &Refusal{http.StatusBadRequest, errors.New("no agent is available for the selected runtime and profile")}
	}
	return deviceID, nil
}
