package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/testfixture"
)

func skillRepositorySourceSession(t *testing.T, f *externalAccountsFixture, input store.CreateAgentSessionInput) string {
	t.Helper()
	if input.WorkspaceID == "" {
		input.WorkspaceID = "ws_alice"
	}
	if input.AgentID == "" {
		input.AgentID = "agent_alice"
	}
	input.Provider = "claude"
	input.Prompt = "change a skill repository source"
	session, err := f.db.CreateAgentSession(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	token, err := f.db.MintAgentSessionToken(context.Background(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func skillRepositorySourceTestRepo(t *testing.T, f *externalAccountsFixture) store.SkillRepository {
	t.Helper()
	repo, err := f.db.CreateSkillRepository(context.Background(), store.SkillRepository{
		URL:   "https://github.com/acme/skills",
		Label: "github.com/acme/skills",
		Mode:  "pick",
	}, f.aliceID)
	if err != nil {
		t.Fatal(err)
	}
	return repo
}

func repositorySourceToolNames() []string {
	names := make([]string, 0, len(repositorySourceMCPTools))
	for name := range repositorySourceMCPTools {
		names = append(names, name)
	}
	return names
}

func TestSkillRepositorySourceToolChangesTheSourceForAnAdminChat(t *testing.T) {
	f := newExternalAccountsFixture(t)
	repo := skillRepositorySourceTestRepo(t, f)
	call := mcpToolCaller(t, f.handler, skillRepositorySourceSession(t, f, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID,
	}))

	text, isError := call("set_skill_repository_source", map[string]any{
		"repositoryId": repo.ID,
		"deviceId":     "dev_alice",
	})
	if isError {
		t.Fatal(text)
	}
	var answer struct {
		ID          string `json:"id"`
		URL         string `json:"url"`
		DeviceID    string `json:"deviceId"`
		DeviceName  string `json:"deviceName"`
		Registry    string `json:"registry"`
		CheckStatus string `json:"checkStatus"`
	}
	if err := json.Unmarshal([]byte(text), &answer); err != nil {
		t.Fatal(err)
	}
	if answer.ID != repo.ID || answer.URL != repo.URL || answer.DeviceID != "dev_alice" ||
		answer.DeviceName != "Device" || answer.Registry != "" || answer.CheckStatus != "waiting" {
		t.Fatalf("answer = %+v", answer)
	}
	stored, err := f.db.GetSkillRepository(context.Background(), repo.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.FetchDeviceID != "dev_alice" || !stored.CheckWaiting {
		t.Fatalf("stored source = %+v", stored)
	}
}

func TestSkillRepositorySourceToolRefusesNonAdminsIssueExecutionsAndVerifiers(t *testing.T) {
	f := newExternalAccountsFixture(t)
	repo := skillRepositorySourceTestRepo(t, f)
	arguments := map[string]any{"repositoryId": repo.ID, "deviceId": "dev_bob"}

	bob := mcpToolCaller(t, f.handler, skillRepositorySourceSession(t, f, store.CreateAgentSessionInput{
		CreatedByUserID: f.bobID,
		WorkspaceID:     "ws_bob",
		AgentID:         "agent_bob",
	}))
	if text, isError := bob("set_skill_repository_source", arguments); !isError ||
		!strings.Contains(text, "This action needs the instance Admin role.") {
		t.Fatalf("non-admin = %q, error %v", text, isError)
	}

	issue, err := f.db.CreateIssue(context.Background(), store.CreateIssueInput{
		WorkspaceID:     "ws_alice",
		Title:           "source permission test",
		SourceInput:     "change a skill repository source",
		Runtime:         "claude",
		CreatedByUserID: f.aliceID,
	})
	if err != nil {
		t.Fatal(err)
	}
	testfixture.ConfirmContract(t, f.db, issue.ID)
	_, execution, err := f.db.ClaimIssueExecution(context.Background(), "dev_alice", "ws_alice")
	if err != nil {
		t.Fatal(err)
	}
	executionToken, err := f.db.MintAgentSessionToken(context.Background(), execution.ID)
	if err != nil {
		t.Fatal(err)
	}
	verifierToken := skillRepositorySourceSession(t, f, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID,
		Verification:    true,
		Source:          store.SessionSourceVerification,
	})
	for name, token := range map[string]string{
		"Issue execution": executionToken,
		"verifier":        verifierToken,
	} {
		call := mcpToolCaller(t, f.handler, token)
		if text, isError := call("set_skill_repository_source", arguments); !isError ||
			!strings.Contains(text, "not available") {
			t.Fatalf("%s = %q, error %v", name, text, isError)
		}
	}
	stored, err := f.db.GetSkillRepository(context.Background(), repo.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.FetchDeviceID != "" {
		t.Fatalf("a refused call changed the source: %+v", stored)
	}
}

func TestSkillRepositorySourceToolAndHTTPRouteAnswerUnknownDevicesTheSame(t *testing.T) {
	f := newExternalAccountsFixture(t)
	repo := skillRepositorySourceTestRepo(t, f)
	call := mcpToolCaller(t, f.handler, skillRepositorySourceSession(t, f, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID,
	}))

	text, isError := call("set_skill_repository_source", map[string]any{
		"repositoryId": repo.ID,
		"deviceId":     "dev_missing",
	})
	if !isError || text != "device not found" {
		t.Fatalf("MCP unknown device = %q, error %v", text, isError)
	}

	recorder := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut,
		"/api/skill-repositories/"+repo.ID+"/source", `{"deviceId":"dev_missing"}`))
	expectStatus(t, recorder, http.StatusNotFound, "HTTP unknown source device")
	var refusal struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &refusal); err != nil {
		t.Fatal(err)
	}
	if refusal.Error != text {
		t.Fatalf("HTTP said %q, MCP said %q", refusal.Error, text)
	}

	recorder = doAuthCall(t, f.handler, f.as(f.alice, http.MethodPut,
		"/api/skill-repositories/"+repo.ID+"/source", `{"deviceId":"dev_alice"}`))
	expectStatus(t, recorder, http.StatusOK, "HTTP source change")
	var changed store.SkillRepository
	if err := json.Unmarshal(recorder.Body.Bytes(), &changed); err != nil {
		t.Fatal(err)
	}
	if changed.ID != repo.ID || changed.FetchDeviceID != "dev_alice" || changed.FetchDeviceName != "Device" || !changed.CheckWaiting {
		t.Fatalf("HTTP source change = %+v", changed)
	}
}
