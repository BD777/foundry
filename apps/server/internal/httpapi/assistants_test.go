package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// defaultAssistantOf is the owner's default assistant, which fixtures set up.
func defaultAssistantOf(t *testing.T, server *Server, ownerID string) store.PersonalAgent {
	t.Helper()
	agent, err := server.store.DefaultAssistant(context.Background(), ownerID)
	if err != nil {
		t.Fatalf("default assistant of %s: %v", ownerID, err)
	}
	return agent
}

// A person's assistants (DEV-191): the list starts with the default one,
// which /api/personal-agent and /api/assistants/{id} both answer; another
// one reaches no workspace until the person adds them, is no one else's to
// read or delete, and only it can be deleted.
func TestAssistantsListCreateAndDelete(t *testing.T) {
	f := newAssistantFixture(t)
	call := func(session, method, path, body string, want int, into any) {
		t.Helper()
		recorder := doAuthCall(t, f.handler, f.as(session, method, path, body))
		expectStatus(t, recorder, want, method+" "+path)
		if into != nil {
			if err := json.Unmarshal(recorder.Body.Bytes(), into); err != nil {
				t.Fatalf("%s %s: %v %s", method, path, err, recorder.Body)
			}
		}
	}
	list := func() []store.AssistantSummary {
		t.Helper()
		var answer store.AssistantList
		call(f.alice, http.MethodGet, "/api/assistants", "", http.StatusOK, &answer)
		return answer.Assistants
	}

	assistants := list()
	if len(assistants) != 1 || !assistants[0].IsDefault || assistants[0].WorkspaceID != "ws_pa" || assistants[0].ID == "" {
		t.Fatalf("assistants = %+v", assistants)
	}
	defaultID := assistants[0].ID
	defaultAgent := defaultAssistantOf(t, f.server, f.aliceID)
	defaultAgent.Settings.FeishuAppID = "xapp_default"
	if _, err := f.server.store.SavePersonalAgentSettings(context.Background(), defaultAgent.ID, defaultAgent.Settings); err != nil {
		t.Fatal(err)
	}
	if assistants = list(); len(assistants) != 1 || assistants[0].FeishuAppID != "xapp_default" {
		t.Fatalf("assistant summaries do not expose the Feishu binding: %+v", assistants)
	}
	var alias, byID store.PersonalAgentOverview
	call(f.alice, http.MethodGet, "/api/personal-agent", "", http.StatusOK, &alias)
	call(f.alice, http.MethodGet, "/api/assistants/"+defaultID, "", http.StatusOK, &byID)
	if alias.Agent == nil || byID.Agent == nil || alias.Agent.ID != defaultID || byID.Agent.ID != defaultID {
		t.Fatalf("alias %+v and by id %+v differ from %s", alias.Agent, byID.Agent, defaultID)
	}

	var created store.PersonalAgent
	call(f.alice, http.MethodPost, "/api/assistants", `{"name":"Research","homeDeviceId":"dev_alice"}`, http.StatusCreated, &created)
	if created.ID == "" || created.ID == defaultID || created.IsDefault || created.Name != "Research" || created.WorkspaceID == "" || created.WorkspaceID == "ws_pa" {
		t.Fatalf("created = %+v", created)
	}
	var pkg store.PermissionPackage
	call(f.alice, http.MethodGet, "/api/assistants/"+created.ID+"/permission-package", "", http.StatusOK, &pkg)
	if pkg.Workspaces.Scope != store.PermissionListScopeListed || len(pkg.Workspaces.Include) != 0 {
		t.Fatalf("a new assistant's workspaces = %+v", pkg.Workspaces)
	}
	if pkg.ConnectorDefault != store.ConnectorAccessLevelOff {
		t.Fatalf("a new assistant's connector default = %q", pkg.ConnectorDefault)
	}
	var defaultPkg store.PermissionPackage
	call(f.alice, http.MethodGet, "/api/personal-agent/permission-package", "", http.StatusOK, &defaultPkg)
	if defaultPkg.ID == pkg.ID || defaultPkg.Workspaces.Scope == store.PermissionListScopeListed ||
		defaultPkg.ConnectorDefault != store.ConnectorAccessLevelWrite {
		t.Fatalf("the default assistant's package changed: %+v", defaultPkg)
	}
	if assistants = list(); len(assistants) != 2 || assistants[0].ID != defaultID || assistants[1].ID != created.ID {
		t.Fatalf("after create: %+v", assistants)
	}

	call(f.bob, http.MethodGet, "/api/assistants/"+created.ID, "", http.StatusNotFound, nil)
	call(f.bob, http.MethodGet, "/api/assistants/"+created.ID+"/permission-package", "", http.StatusNotFound, nil)
	call(f.bob, http.MethodDelete, "/api/assistants/"+created.ID, "", http.StatusNotFound, nil)

	call(f.alice, http.MethodDelete, "/api/assistants/"+defaultID, "", http.StatusConflict, nil)
	call(f.alice, http.MethodDelete, "/api/assistants/"+created.ID, "", http.StatusNoContent, nil)
	call(f.alice, http.MethodGet, "/api/assistants/"+created.ID, "", http.StatusNotFound, nil)
	if assistants = list(); len(assistants) != 1 || assistants[0].ID != defaultID {
		t.Fatalf("after delete: %+v", assistants)
	}
}
