package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/builtinskills"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Sessions always get their agent's Foundry built-in skills; a workspace
// skill of the same name gives way.
func TestSessionsGetTheirAgentsBuiltinSkills(t *testing.T) {
	workspace := []store.SessionSkillRef{
		{SkillID: "skill-qa", Name: "qa", Revision: 1},
		{SkillID: "skill-own-creator", Name: "Skill-Creator", Revision: 3},
	}
	claude := withBuiltinSkills(workspace, "claude")
	names := map[string]string{}
	for _, ref := range claude {
		names[ref.Name] = ref.SkillID
	}
	if names["skill-creator"] != "builtin-claude-skill-creator" || names["qa"] != "skill-qa" {
		t.Fatalf("claude refs = %+v", claude)
	}
	if _, ok := names["Skill-Creator"]; ok || len(claude) != 3 || names["foundry"] != "builtin-claude-foundry" {
		t.Fatalf("the same-named workspace skill must give way: %+v", claude)
	}
	// Codex keeps its own skill-creator and gets Foundry's foundry skill.
	codex := withBuiltinSkills(workspace, "codex")
	if len(codex) != 3 || codex[0].SkillID != "builtin-codex-foundry" || codex[2].SkillID != "skill-own-creator" {
		t.Fatalf("codex refs = %+v", codex)
	}
}

func TestBuiltinSkillPackageIsServedFromTheServer(t *testing.T) {
	server := NewServer(newEmptyTestStore(t))
	skill := builtinskills.ForRuntime("claude")[0]
	request := httptest.NewRequest(http.MethodGet, "/api/skills/catalog/"+skill.ID+"/revisions/1/package", nil)
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status %d: %s", recorder.Code, recorder.Body.String())
	}
	sum := sha256.Sum256(recorder.Body.Bytes())
	if hex.EncodeToString(sum[:]) != skill.Checksum || recorder.Header().Get("X-Foundry-Skill-Checksum") != skill.Checksum {
		t.Fatal("served package does not match its checksum")
	}
	request = httptest.NewRequest(http.MethodGet, "/api/skills/catalog/"+skill.ID+"/revisions/2/package", nil)
	recorder = httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unknown revision status %d, want 404", recorder.Code)
	}
}
