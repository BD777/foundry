package builtinskills

import (
	"slices"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
)

func TestBuiltInSkillsPackageLikeWorkspaceSkills(t *testing.T) {
	claude := ForRuntime("claude")
	if len(claude) != 2 || claude[0].Name != "skill-creator" || claude[1].Name != "foundry" {
		t.Fatalf("claude built-ins = %+v, want skill-creator and foundry", claude)
	}
	codex := ForRuntime("codex")
	if len(codex) != 1 || codex[0].Name != "foundry" || codex[0].ID != "builtin-codex-foundry" {
		t.Fatalf("codex built-ins = %+v: Codex ships its own skill-creator; Foundry adds only foundry", codex)
	}
	if codex[0].Checksum != claude[1].Checksum || claude[1].Source != "Foundry" {
		t.Fatal("both agents get the same foundry skill")
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

// The foundry skill makes an agent reach for it when it meets a Foundry id
// or link, or is asked to work through other sessions; the details load
// from its references only when needed.
func TestFoundrySkillTriggersOnFoundryIds(t *testing.T) {
	skill, ok := Lookup("builtin-claude-foundry")
	if !ok {
		t.Fatal("foundry skill missing")
	}
	for _, trigger := range []string{"sess_", "native_claude_", "native_codex_", "iss_", "ws_", "dev_", "/chats/"} {
		if !strings.Contains(skill.Description, trigger) {
			t.Fatalf("description does not mention %s: %q", trigger, skill.Description)
		}
	}
	for _, trigger := range []string{"what they changed", "Issues", "start, steer, wait on, verify or hand off sessions", "Not for splitting your own task"} {
		if !strings.Contains(skill.Description, trigger) {
			t.Fatalf("description does not say %q: %q", trigger, skill.Description)
		}
	}
	index, err := skillarchive.Inspect(skill.Package)
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{}
	for _, file := range index.Files {
		paths = append(paths, file.Path)
	}
	slices.Sort(paths)
	if want := []string{"SKILL.md", "references/diagnosing.md", "references/orchestration.md"}; !slices.Equal(paths, want) {
		t.Fatalf("foundry package holds %v, want %v", paths, want)
	}
}
