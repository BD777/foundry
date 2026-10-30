package builtinskills

import (
	"slices"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/skillarchive"
)

// Package URLs include the revision. Keep that identity immutable when any
// bundled file changes, not just SKILL.md, for both native runtimes.
func TestFoundrySkillPackageHasARecordedRevision(t *testing.T) {
	revisions := map[int]string{
		17: "975c6f8424fc5a1269b534b3cbf540b097aee24aef270c2048549e3fcd345f75", // DEV-101: tools and skill slimmed
		16: "a62ca731a4cb4815dede1ade1d61f19008ccd037b2a0099164528150bde39cae", // DEV-101: no wait_session or handoff_session
		15: "9375f79ce619fb38e3b17f35820d0750e3b3280d25f023368df728dcee2aa504", // DEV-101: end the turn instead of waiting on a session
		14: "730718e10dc5d029504afad020702a7d1700919bce248661f967e9adad8dd927", // DEV-090: children report their turns
		13: "92444a928f1b87d55a01094960d5eb819472390b0118532ccc69567a89c3322c", // revision 11 again, after DEV-079 P0 was reverted
		12: "17ee519baab5cdc18aecd97956a5cc4409a05bbce961503013ba2ce91c1a1637",
		11: "92444a928f1b87d55a01094960d5eb819472390b0118532ccc69567a89c3322c",
		10: "7f6db7f886625443a44a69255370fd6cc3e95395232dc518c0f330adeded3a8f",
		9:  "a7b7aa0c4b78df946c2c33834b7e7789443b65b89b5490b57b2852b04575ba19",
		8:  "0e377373c1133ad32346039809a1969fa532dc11a8ece400d33060daed7cb43e",
		7:  "c2751ade1b3f42c8006dfd355e080c374ab5fba0ac1976c728a8810a87981f97",
		6:  "4d8b1ae40dd7c7531e860e513a1d53cf535ffb0052815e10d5772f992366858f",
	}
	claude, _ := Lookup("builtin-claude-foundry")
	codex, _ := Lookup("builtin-codex-foundry")
	if claude.Revision != codex.Revision {
		t.Fatal("both runtimes must receive the same Foundry revision")
	}
	for _, skill := range []Skill{claude, codex} {
		if want, ok := revisions[skill.Revision]; !ok || want != skill.Checksum {
			t.Fatalf("%s revision %d has unrecorded package %s; bump and record the new revision", skill.ID, skill.Revision, skill.Checksum)
		}
	}
}

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
	for _, trigger := range []string{"what they changed", "Issues", "start, steer or verify sessions"} {
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
	if want := []string{"SKILL.md", "references/diagnosing.md"}; !slices.Equal(paths, want) {
		t.Fatalf("foundry package holds %v, want %v", paths, want)
	}
}
