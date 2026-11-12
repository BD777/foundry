package assistant

import (
	"context"
	"errors"
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Scope is what the person's assistant manages beyond an agent's scope
// (docs/personal-agent.md §5), and only through its own tools: on devices
// the person owns, the workspaces the person owns, and new workspaces
// where the person's settings allow. The agent routes are unchanged: the
// assistant never reaches the REST management routes. Sessions it starts
// are ordinary agents and never inherit it.
type Scope struct {
	Agent store.PersonalAgent
	// SessionID is the assistant conversation the tool call came from.
	SessionID string
	Turn      store.SessionInput
	owned     map[string]bool
	// owner holds every workspace the person can read and the assistant's
	// permission package allows: true where they are its Owner.
	owner map[string]bool
}

// ErrNotAssistant refuses an assistant tool to anything but the person's
// assistant conversation.
var ErrNotAssistant = &personalagent.Refusal{Status: http.StatusForbidden, Err: errors.New("only the person's assistant can do this")}

// ScopeFor is the assistant's scope in one of its conversations, whose
// current input is turn.
func (s *Service) ScopeFor(ctx context.Context, agent store.PersonalAgent, sessionID string, turn store.SessionInput) (Scope, error) {
	// A disabled account's assistant loses access with it.
	if user, err := s.store.GetUser(ctx, agent.UserID); err != nil || !user.Active() {
		return Scope{}, ErrNotAssistant
	}
	scope := Scope{Agent: agent, SessionID: sessionID, Turn: turn, owned: map[string]bool{}, owner: map[string]bool{}}
	roles, err := s.store.WorkspaceRolesForUser(ctx, agent.UserID)
	if err != nil {
		return Scope{}, err
	}
	pkg, err := s.store.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil {
		return Scope{}, err
	}
	access := permission.Access{Applicable: true, Agent: agent, Package: pkg}
	for workspaceID, role := range roles {
		if access.WorkspaceAllowed(workspaceID) {
			scope.owner[workspaceID] = role == store.WorkspaceRoleOwner
		}
	}
	devices, err := s.store.DevicesOwnedBy(ctx, agent.UserID)
	if err != nil {
		return Scope{}, err
	}
	for _, deviceID := range devices {
		scope.owned[deviceID] = true
	}
	return scope, nil
}

// reaches reports whether the person can read the workspace and the
// assistant's permission package allows it.
func (p Scope) reaches(workspaceID string) bool {
	_, visible := p.owner[workspaceID]
	return visible
}

// manages reports whether the assistant may change the workspace: the
// person owns it and the device it is on.
func (p Scope) manages(workspace store.WorkspaceProjection) bool {
	return p.owner[workspace.ID] && p.owned[workspace.DeviceID]
}

// device is what the person's settings let the assistant do on one of
// their devices; nothing on a device they do not own.
func (p Scope) device(deviceID string) store.PersonalAgentDeviceSettings {
	if !p.owned[deviceID] {
		return store.PersonalAgentDeviceSettings{DeviceID: deviceID}
	}
	return personalagent.DeviceSettings(p.Agent.Settings.Devices, deviceID, p.Agent.HomeDeviceID)
}
