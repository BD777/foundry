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

// Claude sessions always get Foundry's built-in skills; a workspace skill of
// the same name gives way, and other agents are left as they are.
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
	if _, ok := names["Skill-Creator"]; ok || len(claude) != 2 {
		t.Fatalf("the same-named workspace skill must give way: %+v", claude)
	}
	codex := withBuiltinSkills(workspace, "codex")
	if len(codex) != 2 || codex[1].SkillID != "skill-own-creator" {
		t.Fatalf("codex refs changed: %+v", codex)
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
