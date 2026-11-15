package assistant

import (
	"context"
	"errors"
	"fmt"
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
	// role holds every workspace the person can read and the assistant's
	// permission package allows, with the person's role there.
	role map[string]string
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
	scope := Scope{Agent: agent, SessionID: sessionID, Turn: turn, owned: map[string]bool{}, role: map[string]string{}}
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
			scope.role[workspaceID] = role
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

// Role is the person's role in a workspace the assistant reaches: "" for
// one the package leaves out or the person cannot read.
func (p Scope) Role(workspaceID string) string {
	return p.role[workspaceID]
}

// Reaches reports whether the person can read the workspace and the
// assistant's permission package allows it.
func (p Scope) Reaches(workspaceID string) bool {
	return p.Role(workspaceID) != ""
}

// CanStart reports whether a helper may run in the workspace: the package
// allows it and the person is at least a Member, as any session start needs.
func (p Scope) CanStart(workspaceID string) bool {
	return store.WorkspaceRoleAtLeast(p.Role(workspaceID), store.WorkspaceRoleMember)
}

// StartRefusal is why the assistant may not start a helper in workspaceID,
// or nil when it may. It reads as the dispatch refusal does, so the agent
// tells the person the same thing whichever mechanism it used.
func (p Scope) StartRefusal(workspaceID string) error {
	switch {
	case !p.Reaches(workspaceID):
		return &personalagent.Refusal{Status: http.StatusForbidden, Err: fmt.Errorf("not allowed: this assistant's permissions do not include project %s; the person adds it in the assistant's settings → Permissions.", workspaceID)}
	case !p.CanStart(workspaceID):
		return &personalagent.Refusal{Status: http.StatusForbidden, Err: fmt.Errorf("not allowed: the person is a %s in project %s; starting a helper needs Member", p.Role(workspaceID), workspaceID)}
	default:
		return nil
	}
}

// reaches reports whether the person can read the workspace and the
// assistant's permission package allows it.
func (p Scope) reaches(workspaceID string) bool { return p.Reaches(workspaceID) }

// manages reports whether the assistant may change the workspace: the
// person owns it and the device it is on.
func (p Scope) manages(workspace store.WorkspaceProjection) bool {
	return p.Role(workspace.ID) == store.WorkspaceRoleOwner && p.owned[workspace.DeviceID]
}

// device is what the person's settings let the assistant do on one of
// their devices; nothing on a device they do not own.
func (p Scope) device(deviceID string) store.PersonalAgentDeviceSettings {
	if !p.owned[deviceID] {
		return store.PersonalAgentDeviceSettings{DeviceID: deviceID}
	}
	return personalagent.DeviceSettings(p.Agent.Settings.Devices, deviceID, p.Agent.HomeDeviceID)
}
