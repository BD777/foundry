package permission

import (
	"context"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/jsonempty"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestDefaultPackageAllowsAllExistingReachAndAllConnectorWrites(t *testing.T) {
	pkg := DefaultPackage("owner", "pkg")
	access := Access{Applicable: true, Package: pkg}
	for _, workspaceID := range []string{"ws_work", "ws_private"} {
		if !access.WorkspaceAllowed(workspaceID) {
			t.Errorf("default package excluded %s", workspaceID)
		}
	}
	if pkg.IdentityResources.Scope != store.PermissionListScopeAll || access.IdentityResourceListed() || !access.IdentityResourceAllowed("res_browser") {
		t.Fatalf("default package = %+v", pkg)
	}
	if access.ConnectorLevel("acct_any") != store.ConnectorAccessLevelWrite ||
		!access.AllowsConnector("acct_any") || !access.AllowsConnectorWrite("acct_any") {
		t.Fatalf("default connector level = %q", access.ConnectorLevel("acct_any"))
	}
	if pkg.ConnectorDefault != store.ConnectorAccessLevelWrite {
		t.Fatalf("default connector default = %q", pkg.ConnectorDefault)
	}
}

func TestConnectorDefaultAppliesToUnlistedAccounts(t *testing.T) {
	pkg := DefaultPackage("owner", "pkg")
	pkg.ConnectorDefault = store.ConnectorAccessLevelOff
	pkg.ConnectorAccounts = jsonempty.List[store.ConnectorAccountPermission]{
		{AccountID: "acct_read", Level: store.ConnectorAccessLevelRead},
	}
	access := Access{Applicable: true, Package: Normalize(pkg)}
	if access.AllowsConnector("acct_unlisted") || access.AllowsConnectorWrite("acct_unlisted") {
		t.Fatal("an unlisted account ignored the package's off default")
	}
	if !access.AllowsConnector("acct_read") || access.AllowsConnectorWrite("acct_read") {
		t.Fatal("an explicit account level did not override the package default")
	}

	pkg.ConnectorDefault = ""
	if got := Normalize(pkg).ConnectorDefault; got != store.ConnectorAccessLevelWrite {
		t.Fatalf("an old package without connectorDefault normalized to %q", got)
	}
}

func TestPackageRulesAndConnectorOverrides(t *testing.T) {
	pkg := DefaultPackage("owner", "pkg")
	pkg.Workspaces = store.PermissionListRule{Include: []string{"ws_company"}, Exclude: []string{"ws_company_private"}}
	pkg.IdentityResources = store.PermissionIdentityResources{Scope: store.PermissionListScopeListed, Allowed: jsonempty.List[string]{"res_company_browser"}}
	pkg.ConnectorAccounts = jsonempty.List[store.ConnectorAccountPermission]{
		{AccountID: "acct_off", Level: store.ConnectorAccessLevelOff},
		{AccountID: "acct_read", Level: store.ConnectorAccessLevelRead},
	}
	access := Access{Applicable: true, Package: Normalize(pkg)}
	if !access.WorkspaceAllowed("ws_company") || access.WorkspaceAllowed("ws_personal") || access.WorkspaceAllowed("ws_company_private") {
		t.Error("workspace include/exclude did not apply")
	}
	if !access.IdentityResourceAllowed("res_company_browser") || access.IdentityResourceAllowed("res_personal_browser") {
		t.Error("identity resource allowlist did not apply")
	}
	for resourceType, identity := range map[string]bool{
		"browser": true, "computer_use": true, "account": true, "mobile_device": true,
		"compute": false, "gpu": false, "container_runtime": false, "toolchain": false, "disk": false, "simulator": false,
	} {
		if IdentityResourceType(resourceType) != identity {
			t.Errorf("IdentityResourceType(%q) = %v", resourceType, !identity)
		}
	}
	if access.AllowsConnector("acct_off") || !access.AllowsConnector("acct_read") || access.AllowsConnectorWrite("acct_read") {
		t.Error("connector read/off overrides did not apply")
	}
}

type resolveStore struct {
	workspace store.WorkspaceProjection
	agent     store.PersonalAgent
	pkg       store.PermissionPackage
	// helpers are the sessions the assistant started; sessions are the
	// others GetAgentSessionSummary reads.
	helpers  map[string]bool
	sessions map[string]store.AgentSession
}

func (s resolveStore) GetWorkspace(_ context.Context, id string) (store.WorkspaceProjection, error) {
	if id == s.workspace.ID {
		return s.workspace, nil
	}
	return store.WorkspaceProjection{ID: id, Kind: store.WorkspaceKindProject}, nil
}
func (s resolveStore) AssistantForWorkspace(_ context.Context, id string) (store.PersonalAgent, error) {
	if id == s.agent.WorkspaceID {
		return s.agent, nil
	}
	return store.PersonalAgent{}, store.ErrNotFound
}
func (s resolveStore) AssistantForSession(_ context.Context, id string) (store.PersonalAgent, error) {
	if s.helpers[id] {
		return s.agent, nil
	}
	return store.PersonalAgent{}, store.ErrNotFound
}
func (s resolveStore) GetAgentSessionSummary(_ context.Context, id string) (store.AgentSession, error) {
	if session, ok := s.sessions[id]; ok {
		return session, nil
	}
	return store.AgentSession{}, store.ErrNotFound
}
func (s resolveStore) GetPermissionPackage(context.Context, string, string) (store.PermissionPackage, error) {
	return s.pkg, nil
}
func (s resolveStore) SavePermissionPackage(context.Context, store.PermissionPackage) (store.PermissionPackage, error) {
	return s.pkg, nil
}

func TestResolveUsesTheAssistantConversationOnly(t *testing.T) {
	pkg := DefaultPackage("owner", "pkg")
	st := resolveStore{
		workspace: store.WorkspaceProjection{ID: "ws_pa", Kind: store.WorkspaceKindPersonalAgent},
		agent:     store.PersonalAgent{UserID: "owner", WorkspaceID: "ws_pa", PermissionPackageID: pkg.ID},
		pkg:       pkg,
	}
	session := store.AgentSession{
		ID: "assistant", WorkspaceID: "ws_pa", CreatedByUserID: "owner",
		Role: store.AgentSessionRolePersonalAgent, Source: store.SessionSourceChat,
	}
	access, err := Resolve(context.Background(), st, session)
	if err != nil || !access.Applicable || !access.Home || !access.WorkspaceAllowed("ws_other") {
		t.Fatalf("assistant access = %+v (%v)", access, err)
	}
	// A session no assistant started keeps the ordinary rules.
	ordinary := store.AgentSession{ID: "ordinary", WorkspaceID: "ws_project", CreatedByUserID: "owner", Source: store.SessionSourceChat}
	access, err = Resolve(context.Background(), st, ordinary)
	if err != nil || access.Applicable {
		t.Fatalf("ordinary session followed the assistant package: %+v (%v)", access, err)
	}
}

// DEV-191 P0: a helper the assistant started, and what that helper starts,
// work under the assistant's package; another person's session does not.
func TestResolveCoversTheAssistantsHelpers(t *testing.T) {
	pkg := DefaultPackage("owner", "pkg")
	helper := store.AgentSession{ID: "helper", WorkspaceID: "ws_project", CreatedByUserID: "owner", Source: store.SessionSourceAgent, ParentSessionID: ""}
	child := store.AgentSession{ID: "child", WorkspaceID: "ws_project", CreatedByUserID: "owner", Source: store.SessionSourceAgent, ParentSessionID: "helper"}
	st := resolveStore{
		workspace: store.WorkspaceProjection{ID: "ws_project", Kind: store.WorkspaceKindProject},
		agent:     store.PersonalAgent{ID: "asst_work", UserID: "owner", WorkspaceID: "ws_pa", PermissionPackageID: pkg.ID},
		pkg:       pkg,
		helpers:   map[string]bool{"helper": true, "stranger": true},
		sessions:  map[string]store.AgentSession{"helper": helper},
	}
	for _, session := range []store.AgentSession{helper, child} {
		access, err := Resolve(context.Background(), st, session)
		if err != nil || !access.Applicable || access.Home || access.Agent.ID != "asst_work" {
			t.Fatalf("%s access = %+v (%v)", session.ID, access, err)
		}
	}
	stranger := store.AgentSession{ID: "stranger", WorkspaceID: "ws_project", CreatedByUserID: "someone_else", Source: store.SessionSourceAgent}
	if access, err := Resolve(context.Background(), st, stranger); err != nil || access.Applicable {
		t.Fatalf("another person's session took the package: %+v (%v)", access, err)
	}
}
