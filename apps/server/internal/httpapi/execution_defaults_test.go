package httpapi

import (
	"context"
	"net/http"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func saveLearningProfile(t *testing.T, f *externalAccountsFixture) store.ProfileDefinition {
	t.Helper()
	profile, err := f.db.SaveProfile(context.Background(), store.SaveProfileInput{
		ID: "provider_worker", Runtime: "codex", Label: "Worker relay",
		AuthMode: "custom", ConnectionType: "openai_compatible",
		BaseURL: "https://worker.example", Model: "cheap-worker",
		Models: []string{"cheap-worker", "cheap-worker-fast"}, OwnerUserID: f.aliceID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return profile
}

func TestExecutionDefaultsHTTPAndMCP(t *testing.T) {
	f := newExternalAccountsFixture(t)
	profile := saveLearningProfile(t, f)

	var global executionDefaultsView
	f.call(f.alice, http.MethodPut, "/api/execution-default",
		`{"providerId":"`+profile.ID+`","runtime":"codex","model":"cheap-worker","effort":"high"}`,
		http.StatusOK, "save the global execution default", &global)
	if global.Effective.Scope != "global" || global.Saved == nil || global.Effective.Effort != "high" {
		t.Fatalf("global default = %+v", global)
	}
	if global.Effective.Alternatives == nil || len(global.Effective.Alternatives) != 0 {
		t.Fatalf("legacy global default alternatives = %+v", global.Effective.Alternatives)
	}
	var workspace executionDefaultsView
	f.call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/execution-default",
		`{"providerId":"`+profile.ID+`","runtime":"codex","model":"cheap-worker-fast","effort":"medium"}`,
		http.StatusOK, "save the workspace execution default", &workspace)
	if workspace.Effective.Scope != "workspace" || workspace.Effective.Model != "cheap-worker-fast" {
		t.Fatalf("workspace default = %+v", workspace)
	}
	f.call(f.alice, http.MethodGet, "/api/workspaces/ws_alice/execution-default", "",
		http.StatusOK, "read the workspace execution default", &workspace)
	if workspace.Saved == nil || workspace.Effective.ProviderID != profile.ID {
		t.Fatalf("read workspace default = %+v", workspace)
	}
	if workspace.Effective.Alternatives == nil || len(workspace.Effective.Alternatives) != 0 {
		t.Fatalf("legacy workspace default alternatives = %+v", workspace.Effective.Alternatives)
	}

	alice := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})
	var effective executionDefaultsView
	alice.ok("get_execution_default", `{"workspaceId":"ws_alice"}`, &effective)
	if effective.Effective.Scope != "workspace" || effective.Effective.ProviderID != profile.ID {
		t.Fatalf("MCP execution default = %+v", effective)
	}
}

func TestExecutionDefaultsAlternativesHTTPAndMCP(t *testing.T) {
	f := newExternalAccountsFixture(t)
	profile := saveLearningProfile(t, f)
	group, err := f.db.SaveWorkerGroup(context.Background(), store.StoredWorkerGroup{
		OwnerUserID: f.aliceID,
		Label:       "Strong workers",
		Members: []store.WorkerGroupMember{{
			ProviderKind: "api", ProviderID: profile.ID, Runtime: "codex", Model: "cheap-worker-fast",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}

	var global executionDefaultsView
	f.call(f.alice, http.MethodPut, "/api/execution-default",
		`{"providerId":"`+profile.ID+`","runtime":"codex","model":"cheap-worker","effort":"high","alternatives":[`+
			`{"providerId":"`+profile.ID+`","runtime":"codex","model":"cheap-worker-fast","effort":"medium"},`+
			`{"workerGroupId":"`+group.ID+`"}]}`,
		http.StatusOK, "save global alternatives", &global)
	if len(global.Effective.Alternatives) != 2 ||
		global.Effective.Alternatives[0].Model != "cheap-worker-fast" ||
		global.Effective.Alternatives[0].ID == "" ||
		global.Effective.Alternatives[1].WorkerGroupID != group.ID ||
		global.Effective.Alternatives[1].Group == nil ||
		global.Effective.Alternatives[1].Group.Label != group.Label {
		t.Fatalf("global alternatives = %+v", global.Effective.Alternatives)
	}

	var globalRead executionDefaultsView
	f.call(f.alice, http.MethodGet, "/api/execution-default", "",
		http.StatusOK, "read global alternatives", &globalRead)
	if len(globalRead.Effective.Alternatives) != 2 ||
		globalRead.Effective.Alternatives[1].Group == nil ||
		len(globalRead.Effective.Alternatives[1].Group.Members) != 1 {
		t.Fatalf("read global alternatives = %+v", globalRead.Effective.Alternatives)
	}

	var workspace executionDefaultsView
	f.call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/execution-default",
		`{"providerId":"`+profile.ID+`","runtime":"codex","model":"cheap-worker-fast","effort":"medium",`+
			`"alternatives":[{"workerGroupId":"`+group.ID+`"}]}`,
		http.StatusOK, "replace workspace alternatives", &workspace)
	if len(workspace.Effective.Alternatives) != 1 ||
		workspace.Effective.Alternatives[0].WorkerGroupID != group.ID ||
		workspace.Effective.Alternatives[0].Group == nil {
		t.Fatalf("workspace must replace global alternatives: %+v", workspace.Effective.Alternatives)
	}

	var workspaceRead executionDefaultsView
	f.call(f.alice, http.MethodGet, "/api/workspaces/ws_alice/execution-default", "",
		http.StatusOK, "read workspace alternatives", &workspaceRead)
	if len(workspaceRead.Effective.Alternatives) != 1 || workspaceRead.Saved == nil {
		t.Fatalf("read workspace alternatives = %+v", workspaceRead)
	}

	alice := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})
	var effective executionDefaultsView
	alice.ok("get_execution_default", `{"workspaceId":"ws_alice"}`, &effective)
	if len(effective.Effective.Alternatives) != 1 ||
		effective.Effective.Alternatives[0].Group == nil ||
		effective.Effective.Alternatives[0].Group.Members[0].Model != "cheap-worker-fast" {
		t.Fatalf("MCP alternatives = %+v", effective.Effective.Alternatives)
	}
}

func TestExecutionDefaultsRejectInvalidAlternative(t *testing.T) {
	f := newExternalAccountsFixture(t)
	profile := saveLearningProfile(t, f)

	f.call(f.alice, http.MethodPut, "/api/execution-default",
		`{"providerId":"`+profile.ID+`","runtime":"codex","model":"cheap-worker",`+
			`"alternatives":[{"providerId":"provider_missing","runtime":"codex","model":"missing-model"}]}`,
		http.StatusNotFound, "reject an alternative whose provider does not exist", nil)
}

func TestExecutionDefaultsRejectLegacyModelPoolField(t *testing.T) {
	f := newExternalAccountsFixture(t)
	profile := saveLearningProfile(t, f)

	f.call(f.alice, http.MethodPut, "/api/workspaces/ws_alice/execution-default",
		`{"providerKind":"api","providerId":"`+profile.ID+`","runtime":"codex","model":"cheap-worker","modelPoolId":"","effort":"high"}`,
		http.StatusBadRequest, "reject the legacy modelPoolId write body", nil)
}
