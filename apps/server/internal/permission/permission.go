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
	AssistantForWorkspace(context.Context, string) (store.PersonalAgent, error)
	AssistantForSession(context.Context, string) (store.PersonalAgent, error)
	GetAgentSessionSummary(context.Context, string) (store.AgentSession, error)
}

// Access is the permission package that applies to one session working for
// an assistant: the assistant's own conversation (Home) or a helper it
// started, and the sessions those start. Applicable is false for every
// other session, which keeps workspace-binding behavior unchanged.
type Access struct {
	Applicable bool
	// Home is the assistant's own top-level conversation in its home
	// workspace, which reaches every connector account the person holds;
	// a helper reaches only its workspace's bindings the package allows.
	Home    bool
	Agent   store.PersonalAgent
	Package store.PermissionPackage
}

// maxLineage bounds the parent chain Resolve follows from a session a
// helper started back to the helper.
const maxLineage = 8

// Resolve reads the assistant and package a session works for: the
// assistant's own conversation in its home workspace, or a helper the
// assistant started (store.AssistantForSession), or a session one of those
// started.
func Resolve(ctx context.Context, st Store, session store.AgentSession) (Access, error) {
	home, err := resolveHome(ctx, st, session)
	if err != nil || home.Applicable {
		return home, err
	}
	if session.CreatedByUserID == "" {
		return Access{}, nil
	}
	current := session
	for range maxLineage {
		agent, err := st.AssistantForSession(ctx, current.ID)
		if err == nil {
			if agent.UserID != session.CreatedByUserID {
				return Access{}, nil
			}
			return packageFor(ctx, st, agent, false)
		}
		if !errors.Is(err, store.ErrNotFound) {
			return Access{}, err
		}
		if current.ParentSessionID == "" {
			return Access{}, nil
		}
		current, err = st.GetAgentSessionSummary(ctx, current.ParentSessionID)
		if errors.Is(err, store.ErrNotFound) {
			return Access{}, nil
		}
		if err != nil {
			return Access{}, err
		}
	}
	return Access{}, nil
}

func resolveHome(ctx context.Context, st Store, session store.AgentSession) (Access, error) {
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
	agent, err := st.AssistantForWorkspace(ctx, session.WorkspaceID)
	if errors.Is(err, store.ErrNotFound) {
		return Access{}, nil
	}
	if err != nil {
		return Access{}, err
	}
	if agent.UserID == "" || agent.UserID != session.CreatedByUserID {
		return Access{}, nil
	}
	return packageFor(ctx, st, agent, true)
}

func packageFor(ctx context.Context, st Store, agent store.PersonalAgent, home bool) (Access, error) {
	if agent.PermissionPackageID == "" {
		return Access{}, fmt.Errorf("assistant %s has no permission package", agent.ID)
	}
	pkg, err := st.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil {
		return Access{}, fmt.Errorf("assistant %s permission package: %w", agent.ID, err)
	}
	return Access{Applicable: true, Home: home, Agent: agent, Package: pkg}, nil
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
// the person can already reach, every connector account at write, and
// identity resources following the device like every other resource. A
// later assistant's package narrows workspaces and identity resources to
// listed ones (sqlitestore createPersonalAgent).
func DefaultPackage(owner, id string) store.PermissionPackage {
	return Normalize(store.PermissionPackage{
		ID:    strings.TrimSpace(id),
		Owner: strings.TrimSpace(owner),
		Workspaces: store.PermissionListRule{
			Include: jsonempty.List[string]{},
			Exclude: jsonempty.List[string]{},
		},
		ConnectorAccounts: jsonempty.List[store.ConnectorAccountPermission]{},
		IdentityResources: store.PermissionIdentityResources{
			Scope:   store.PermissionListScopeAll,
			Allowed: jsonempty.List[string]{},
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
	if pkg.IdentityResources.Scope != store.PermissionListScopeListed {
		pkg.IdentityResources.Scope = store.PermissionListScopeAll
	}
	pkg.IdentityResources.Allowed = cleanIDs(pkg.IdentityResources.Allowed)
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
	if rule.Scope != store.PermissionListScopeListed {
		rule.Scope = ""
	}
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

// identityResourceTypes are the resource types that act as someone: a
// signed-in browser, screen control, a device CLI account, a phone. Every
// other type (compute, gpu, container_runtime, toolchain, disk, simulator)
// carries no identity and follows the device.
var identityResourceTypes = map[string]bool{
	"browser": true, "computer_use": true, "account": true, "mobile_device": true,
}

// IdentityResourceTypes lists the identity-bearing resource types, sorted.
func IdentityResourceTypes() []string {
	types := make([]string, 0, len(identityResourceTypes))
	for resourceType := range identityResourceTypes {
		types = append(types, resourceType)
	}
	slices.Sort(types)
	return types
}

// IdentityResourceType reports whether resources of this type carry an
// identity, so an assistant needs them listed to lease one.
func IdentityResourceType(resourceType string) bool {
	return identityResourceTypes[strings.TrimSpace(resourceType)]
}

// IdentityResourceListed reports whether the package names its identity
// resources one by one (scope listed) rather than letting them follow the
// device (scope all).
func (a Access) IdentityResourceListed() bool {
	return a.Applicable && a.Package.IdentityResources.Scope == store.PermissionListScopeListed
}

// IdentityResourceAllowed reports whether the package lets the assistant
// lease the identity resource resourceID: under scope all every one (the
// device rule still applies), under scope listed only the allowed ones.
func (a Access) IdentityResourceAllowed(resourceID string) bool {
	if !a.IdentityResourceListed() {
		return true
	}
	return slices.Contains([]string(a.Package.IdentityResources.Allowed), strings.TrimSpace(resourceID))
}

func ruleAllows(rule store.PermissionListRule, id string) bool {
	id = strings.TrimSpace(id)
	if id == "" || slices.Contains([]string(rule.Exclude), id) {
		return false
	}
	if rule.Scope == store.PermissionListScopeListed {
		return slices.Contains([]string(rule.Include), id)
	}
	return len(rule.Include) == 0 || slices.Contains([]string(rule.Include), id)
}
