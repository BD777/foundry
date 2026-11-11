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
	if !access.SkillVisible("any-skill") || access.DirectLeaseAllowed("dev_work") {
		t.Fatalf("default package = %+v", pkg)
	}
	if access.ConnectorLevel("acct_any") != store.ConnectorAccessLevelWrite ||
		!access.AllowsConnector("acct_any") || !access.AllowsConnectorWrite("acct_any") {
		t.Fatalf("default connector level = %q", access.ConnectorLevel("acct_any"))
	}
}

func TestPackageRulesAndConnectorOverrides(t *testing.T) {
	pkg := DefaultPackage("owner", "pkg")
	pkg.Workspaces = store.PermissionListRule{Include: []string{"ws_company"}, Exclude: []string{"ws_company_private"}}
	pkg.Skills = store.PermissionListRule{Include: []string{"skills_company"}, Exclude: []string{"skill_secret"}}
	pkg.DevicesResources.DirectLeaseAllowed = jsonempty.List[string]{"dev_company"}
	pkg.ConnectorAccounts = jsonempty.List[store.ConnectorAccountPermission]{
		{AccountID: "acct_off", Level: store.ConnectorAccessLevelOff},
		{AccountID: "acct_read", Level: store.ConnectorAccessLevelRead},
	}
	access := Access{Applicable: true, Package: Normalize(pkg)}
	if !access.WorkspaceAllowed("ws_company") || access.WorkspaceAllowed("ws_personal") || access.WorkspaceAllowed("ws_company_private") {
		t.Error("workspace include/exclude did not apply")
	}
	if !access.SkillVisible("skills_company") || access.SkillVisible("skill_secret") || access.SkillVisible("other") {
		t.Error("skill include/exclude did not apply")
	}
	if !access.DirectLeaseAllowed("dev_company") || access.DirectLeaseAllowed("dev_other") {
		t.Error("direct lease allowlist did not apply")
	}
	if access.AllowsConnector("acct_off") || !access.AllowsConnector("acct_read") || access.AllowsConnectorWrite("acct_read") {
		t.Error("connector read/off overrides did not apply")
	}
}

type resolveStore struct {
	workspace store.WorkspaceProjection
	agent     store.PersonalAgent
	pkg       store.PermissionPackage
}

func (s resolveStore) GetWorkspace(context.Context, string) (store.WorkspaceProjection, error) {
	return s.workspace, nil
}
func (s resolveStore) PersonalAgentForWorkspace(context.Context, string) (store.PersonalAgent, error) {
	return s.agent, nil
}
func (s resolveStore) GetAgentSessionSummary(context.Context, string) (store.AgentSession, error) {
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
	if err != nil || !access.Applicable || !access.WorkspaceAllowed("ws_other") {
		t.Fatalf("assistant access = %+v (%v)", access, err)
	}
	helper := session
	helper.ID, helper.Role, helper.Source, helper.ParentSessionID = "helper", "", store.SessionSourceAgent, "assistant"
	access, err = Resolve(context.Background(), st, helper)
	if err != nil || access.Applicable {
		t.Fatalf("helper inherited the assistant package: %+v (%v)", access, err)
	}
}
