// Package permission is the one resolver for an assistant's access. It reads
// the persisted permission package and exposes the decisions connector
// dispatch, gateways, MCP reach and assistant tools need.
package permission

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/jsonempty"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Store is what resolving one assistant's package needs.
type Store interface {
	store.PermissionPackageStore
	GetWorkspace(context.Context, string) (store.WorkspaceProjection, error)
	PersonalAgentForWorkspace(context.Context, string) (store.PersonalAgent, error)
	GetAgentSessionSummary(context.Context, string) (store.AgentSession, error)
}

// Access is the permission package that applies to one assistant session.
// Applicable is false for every other session, which keeps workspace-binding
// behavior unchanged.
type Access struct {
	Applicable bool
	Agent      store.PersonalAgent
	Package    store.PermissionPackage
}

// Resolve reads the workspace, assistant and package for session. It applies
// only to the assistant's own top-level conversation in its own workspace.
func Resolve(ctx context.Context, st Store, session store.AgentSession) (Access, error) {
	if !IsAssistantSession(session) {
		return Access{}, nil
	}
	workspace, err := st.GetWorkspace(ctx, session.WorkspaceID)
	if errors.Is(err, store.ErrNotFound) {
		return Access{}, nil
	}
	if err != nil {
		return Access{}, err
	}
	if workspace.Kind != store.WorkspaceKindPersonalAgent {
		return Access{}, nil
	}
	agent, err := st.PersonalAgentForWorkspace(ctx, session.WorkspaceID)
	if errors.Is(err, store.ErrNotFound) {
		return Access{}, nil
	}
	if err != nil {
		return Access{}, err
	}
	if agent.UserID == "" || agent.UserID != session.CreatedByUserID {
		return Access{}, nil
	}
	if agent.PermissionPackageID == "" {
		return Access{}, fmt.Errorf("assistant %s has no permission package", agent.UserID)
	}
	pkg, err := st.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil {
		return Access{}, fmt.Errorf("assistant %s permission package: %w", agent.UserID, err)
	}
	return Access{Applicable: true, Agent: agent, Package: pkg}, nil
}

// IsAssistantSession mirrors assistant.Conversation without importing the
// assistant package: a top-level conversation the owner started, not a
// helper, Issue, verifier or utility run.
func IsAssistantSession(session store.AgentSession) bool {
	if session.Role != "" && session.Role != store.AgentSessionRolePersonalAgent {
		return false
	}
	if session.ParentSessionID != "" || session.CreatedByUserID == "" {
		return false
	}
	if session.IssueID != "" || session.Source == store.SessionSourceVerification || store.IsUtilitySessionSource(session.Source) {
		return false
	}
	return session.Source == "" || session.Source == store.SessionSourceChat
}

// DefaultPackage is the built-in package for one assistant: every workspace
// and skill the person can already reach, every connector account at write,
// and no direct resource lease.
func DefaultPackage(owner, id string) store.PermissionPackage {
	return Normalize(store.PermissionPackage{
		ID:    strings.TrimSpace(id),
		Owner: strings.TrimSpace(owner),
		Workspaces: store.PermissionListRule{
			Include: jsonempty.List[string]{},
			Exclude: jsonempty.List[string]{},
		},
		ConnectorAccounts: jsonempty.List[store.ConnectorAccountPermission]{},
		DevicesResources: store.PermissionDeviceResources{
			DirectLeaseAllowed: jsonempty.List[string]{},
		},
		Skills: store.PermissionListRule{
			Include: jsonempty.List[string]{},
			Exclude: jsonempty.List[string]{},
		},
	})
}

// Normalize removes empty and duplicate ids and guarantees collections are
// JSON arrays rather than null. Invalid connector levels are left for
// Validate to reject.
func Normalize(pkg store.PermissionPackage) store.PermissionPackage {
	pkg.ID = strings.TrimSpace(pkg.ID)
	pkg.Owner = strings.TrimSpace(pkg.Owner)
	pkg.Workspaces = normalizeRule(pkg.Workspaces)
	pkg.Skills = normalizeRule(pkg.Skills)
	pkg.DevicesResources.DirectLeaseAllowed = cleanIDs(pkg.DevicesResources.DirectLeaseAllowed)
	seen := map[string]bool{}
	accounts := make(jsonempty.List[store.ConnectorAccountPermission], 0, len(pkg.ConnectorAccounts))
	for _, account := range pkg.ConnectorAccounts {
		account.AccountID = strings.TrimSpace(account.AccountID)
		account.Level = strings.TrimSpace(account.Level)
		if account.AccountID == "" || seen[account.AccountID] {
			continue
		}
		seen[account.AccountID] = true
		accounts = append(accounts, account)
	}
	pkg.ConnectorAccounts = accounts
	return pkg
}

func normalizeRule(rule store.PermissionListRule) store.PermissionListRule {
	rule.Include = cleanIDs(rule.Include)
	rule.Exclude = cleanIDs(rule.Exclude)
	return rule
}

func cleanIDs(ids jsonempty.List[string]) jsonempty.List[string] {
	out := make(jsonempty.List[string], 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// Validate checks a normalized package.
func Validate(pkg store.PermissionPackage) error {
	if pkg.ID == "" || pkg.Owner == "" {
		return errors.New("a permission package needs an id and owner")
	}
	for _, account := range pkg.ConnectorAccounts {
		if account.AccountID == "" {
			return errors.New("a connector permission needs an account id")
		}
		switch account.Level {
		case store.ConnectorAccessLevelOff, store.ConnectorAccessLevelRead, store.ConnectorAccessLevelWrite:
		default:
			return fmt.Errorf("unknown connector access level %q", account.Level)
		}
	}
	return nil
}

// ConnectorLevel returns the account's explicit level, or write when the
// package has no override for it.
func (a Access) ConnectorLevel(accountID string) string {
	if !a.Applicable {
		return store.ConnectorAccessLevelWrite
	}
	accountID = strings.TrimSpace(accountID)
	for _, account := range a.Package.ConnectorAccounts {
		if account.AccountID == accountID {
			return account.Level
		}
	}
	return store.ConnectorAccessLevelWrite
}

// AllowsConnector reports whether reads may use accountID.
func (a Access) AllowsConnector(accountID string) bool {
	return a.ConnectorLevel(accountID) != store.ConnectorAccessLevelOff
}

// AllowsConnectorWrite reports whether accountID may change things.
func (a Access) AllowsConnectorWrite(accountID string) bool {
	return a.ConnectorLevel(accountID) == store.ConnectorAccessLevelWrite
}

// WorkspaceAllowed applies include/exclude to a workspace the person can
// already reach. An empty include list means all.
func (a Access) WorkspaceAllowed(workspaceID string) bool {
	if !a.Applicable {
		return true
	}
	return ruleAllows(a.Package.Workspaces, workspaceID)
}

// SkillVisible applies the assistant's skill rule.
func (a Access) SkillVisible(skillID string) bool {
	if !a.Applicable {
		return true
	}
	return ruleAllows(a.Package.Skills, skillID)
}

// DirectLeaseAllowed reports whether the assistant may lease a device's
// resources itself. The default is none.
func (a Access) DirectLeaseAllowed(deviceID string) bool {
	if !a.Applicable {
		return true
	}
	return slices.Contains([]string(a.Package.DevicesResources.DirectLeaseAllowed), strings.TrimSpace(deviceID))
}

func ruleAllows(rule store.PermissionListRule, id string) bool {
	id = strings.TrimSpace(id)
	if id == "" || slices.Contains([]string(rule.Exclude), id) {
		return false
	}
	return len(rule.Include) == 0 || slices.Contains([]string(rule.Include), id)
}
