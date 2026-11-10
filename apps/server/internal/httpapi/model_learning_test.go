package httpapi

import (
	"context"
	"net/http"
	"strings"
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

func TestModelLearningHTTPAndMCP(t *testing.T) {
	f := newExternalAccountsFixture(t)
	profile := saveLearningProfile(t, f)
	target := `"providerKind":"api","providerId":"` + profile.ID + `","runtime":"codex","model":"cheap-worker"`

	var note store.ModelNote
	f.call(f.alice, http.MethodPost, "/api/model-notes",
		`{`+target+`,"body":"Give exact files and commands."}`,
		http.StatusCreated, "append a note", &note)
	if note.ID == "" || note.AuthorName == "" || note.AuthorSessionID != "" || note.ProviderID != profile.ID {
		t.Fatalf("created note = %+v", note)
	}

	var page store.ModelNotePage
	path := "/api/model-notes?providerKind=api&providerId=" + profile.ID +
		"&runtime=codex&model=cheap-worker&limit=1"
	f.call(f.alice, http.MethodGet, path, "", http.StatusOK, "list notes", &page)
	if page.Total != 1 || len(page.Notes) != 1 || page.Notes[0].ID != note.ID {
		t.Fatalf("page = %+v", page)
	}
	f.call(f.bob, http.MethodGet, path, "", http.StatusNotFound, "another person's note", nil)
	f.call(f.bob, http.MethodPut, "/api/model-notes/"+note.ID, `{"body":"not mine"}`,
		http.StatusNotFound, "another person's edit", nil)

	var edited store.ModelNote
	f.call(f.alice, http.MethodPut, "/api/model-notes/"+note.ID,
		`{"body":"Require a diff and a rerun."}`, http.StatusOK, "edit a note", &edited)
	if edited.Body != "Require a diff and a rerun." || edited.UpdatedAt == "" {
		t.Fatalf("edited note = %+v", edited)
	}

	var global executionDefaultsView
	f.call(f.alice, http.MethodPut, "/api/execution-default",
		`{"providerId":"`+profile.ID+`","runtime":"codex","model":"cheap-worker","effort":"high"}`,
		http.StatusOK, "save the global execution default", &global)
	if global.Effective.Scope != "global" || global.Saved == nil || global.Effective.Effort != "high" {
		t.Fatalf("global default = %+v", global)
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

	alice := f.providerSession(store.CreateAgentSessionInput{CreatedByUserID: f.aliceID})
	alice.ok("append_model_note",
		`{`+target+`,"body":"Ask it to stop at unexpected operational blockers."}`, &note)
	if note.AuthorSessionID == "" || !strings.Contains(note.AuthorSessionID, "sess_") {
		t.Fatalf("MCP note author session = %+v", note)
	}
	alice.ok("get_model_notes", `{`+target+`,"limit":1}`, &page)
	if page.Total != 2 || len(page.Notes) != 1 || page.NextOffset != 1 {
		t.Fatalf("MCP notes page = %+v", page)
	}
	var effective executionDefaultsView
	alice.ok("get_execution_default", `{"workspaceId":"ws_alice"}`, &effective)
	if effective.Effective.Scope != "workspace" || effective.Effective.ProviderID != profile.ID {
		t.Fatalf("MCP execution default = %+v", effective)
	}

	bob := f.providerSession(store.CreateAgentSessionInput{
		CreatedByUserID: f.bobID, AgentID: "agent_bob", WorkspaceID: "ws_bob",
	})
	if text, failed, _ := bob.call("append_model_note",
		`{`+target+`,"body":"not mine"}`); !failed || !strings.Contains(text, "model provider not found") {
		t.Fatalf("bob append = %q, failed %v", text, failed)
	}

	f.call(f.alice, http.MethodDelete, "/api/model-notes/"+note.ID, "",
		http.StatusOK, "delete a note", nil)
}
