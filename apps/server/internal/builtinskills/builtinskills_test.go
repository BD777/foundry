package builtinskills

import (
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
)

func TestBuiltInSkillsPackageLikeWorkspaceSkills(t *testing.T) {
	claude := ForRuntime("claude")
	if len(claude) != 1 || claude[0].Name != "skill-creator" {
		t.Fatalf("claude built-ins = %+v, want skill-creator", claude)
	}
	if len(ForRuntime("codex")) != 0 {
		t.Fatal("codex ships its own skill-creator; Foundry adds none")
	}
	skill := claude[0]
	if skill.Description == "" || skill.ID != "builtin-claude-skill-creator" {
		t.Fatalf("skill = %+v", skill)
	}
	index, err := skillarchive.Inspect(skill.Package)
	if err != nil {
		t.Fatalf("package does not pass the catalog's own archive checks: %v", err)
	}
	if len(index.Files) != 18 {
		t.Fatalf("package has %d files, want the 18 vendored ones", len(index.Files))
	}
	again, _, err := skillarchive.PackDir(files, "skill-creator")
	if err != nil || string(again) != string(skill.Package) {
		t.Fatal("packing the same folder must give the same bytes")
	}
	if _, ok := Lookup(skill.ID); !ok {
		t.Fatal("lookup by id failed")
	}
}
