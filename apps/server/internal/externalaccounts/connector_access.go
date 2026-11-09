package externalaccounts

import (
	"context"
	"errors"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// ConnectorAccessStore resolves the workspace and Personal Agent a session
// belongs to.
type ConnectorAccessStore interface {
	GetWorkspace(context.Context, string) (store.WorkspaceProjection, error)
	PersonalAgentForWorkspace(context.Context, string) (store.PersonalAgent, error)
}

// Policy is the Personal Agent's connector access. A zero Policy applies
// the ordinary workspace-binding rule.
type Policy struct {
	personalAgent bool
	disabled      map[string]bool
}

// ResolvePolicy reads the policy for a session's workspace. Another
// person's session in the assistant's workspace never receives it.
func ResolvePolicy(ctx context.Context, st ConnectorAccessStore, workspaceID, sessionOwner string) (Policy, error) {
	workspace, err := st.GetWorkspace(ctx, workspaceID)
	if errors.Is(err, store.ErrNotFound) {
		return Policy{}, nil
	}
	if err != nil {
		return Policy{}, err
	}
	if workspace.Kind != store.WorkspaceKindPersonalAgent {
		return Policy{}, nil
	}
	agent, err := st.PersonalAgentForWorkspace(ctx, workspaceID)
	if errors.Is(err, store.ErrNotFound) {
		return Policy{}, nil
	}
	if err != nil {
		return Policy{}, err
	}
	if agent.UserID == "" || agent.UserID != sessionOwner {
		return Policy{}, nil
	}
	disabled := make(map[string]bool, len(agent.ConnectorOptOut))
	for _, accountID := range agent.ConnectorOptOut {
		if accountID = strings.TrimSpace(accountID); accountID != "" {
			disabled[accountID] = true
		}
	}
	return Policy{personalAgent: true, disabled: disabled}, nil
}

// PersonalAgent reports whether this is the session owner's Personal Agent.
func (p Policy) PersonalAgent() bool { return p.personalAgent }

// Allows reports whether the assistant may use accountID.
func (p Policy) Allows(accountID string) bool {
	return p.personalAgent && accountID != "" && !p.disabled[accountID]
}

// Bound is the one rule for whether a connector account counts as bound:
// an ordinary workspace binding, or an allowed account in the person's
// Assistant workspace.
func (p Policy) Bound(accountID string, boundWorkspaces []string, workspaceID string) bool {
	if p.personalAgent {
		return p.Allows(accountID)
	}
	for _, bound := range boundWorkspaces {
		if bound == workspaceID {
			return true
		}
	}
	return false
}

// DeviceAccountID names one device login in the opt-out list.
func DeviceAccountID(deviceID, kind string) string {
	return "device:" + strings.TrimSpace(deviceID) + ":" + strings.TrimSpace(kind)
}
