package externalaccounts

import (
	"context"
	"errors"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// ConnectorAccessStore resolves the permission package a session belongs to.
type ConnectorAccessStore interface {
	permission.Store
}

// Policy is the assistant permission package applied to connector access. A
// zero Policy applies the ordinary workspace-binding rule.
type Policy struct {
	access permission.Access
}

// ResolvePolicy reads the assistant's package for this session. Every other
// session keeps the ordinary workspace-binding rule.
func ResolvePolicy(ctx context.Context, st ConnectorAccessStore, session store.AgentSession) (Policy, error) {
	access, err := permission.Resolve(ctx, st, session)
	if errors.Is(err, store.ErrNotFound) {
		return Policy{}, nil
	}
	return Policy{access: access}, err
}

// PersonalAgent reports whether this is the assistant's own conversation,
// which reaches every account the person holds rather than its workspace's
// bindings.
func (p Policy) PersonalAgent() bool { return p.access.Applicable && p.access.Home }

// Assistant reports whether an assistant's package applies: its own
// conversation or a helper it started.
func (p Policy) Assistant() bool { return p.access.Applicable }

// Allows reports whether the assistant may use accountID.
func (p Policy) Allows(accountID string) bool {
	return !p.access.Applicable || (accountID != "" && p.access.AllowsConnector(accountID))
}

// Write reports whether the assistant may change things through accountID.
func (p Policy) Write(accountID string) bool {
	return !p.access.Applicable || p.access.AllowsConnectorWrite(accountID)
}

// Bound is the one rule for whether a connector account counts as bound:
// an ordinary workspace binding, an allowed account in the assistant's own
// conversation, or for a helper a binding of its workspace the assistant's
// package allows.
func (p Policy) Bound(accountID string, boundWorkspaces []string, workspaceID string) bool {
	if p.PersonalAgent() {
		return p.Allows(accountID)
	}
	return slices.Contains(boundWorkspaces, workspaceID) && p.Allows(accountID)
}

// DeviceAccountID names one device login in the opt-out list.
func DeviceAccountID(deviceID, kind string) string {
	return "device:" + strings.TrimSpace(deviceID) + ":" + strings.TrimSpace(kind)
}
