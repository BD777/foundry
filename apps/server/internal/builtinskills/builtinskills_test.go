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
		36: "134f23c7f7fb2e6c9ee90937f8ca3ffa775e034818357a95fbba0da8d41ed12f", // DEV-197 B1 + DEV-201: blocker reporting and generic-surface guidance
		31: "3e6b99a0b26d81f8f2ebdfa1e4295966f13107af788fae76b6098a5da67fede8", // session system alerts; MCP result budgets (paged session work, chat-capable models)
		32: "5b5204cd81e06b5b6b8961771d057cf26d09edc39af065b59952d9f9ca40f4fa", // connector_instances: configure connector instances with secrets by file reference
		33: "81808432bf9f736b7eddfd42907e387cce9b00b0b7a14e084042b93da1410edc", // connector_packages: enable an integration package on chosen devices
		34: "ea50663680d530308a05742a394f74ce323c2115316c167582f18ea425e87872", // edge_access: manage edge access credentials and provision Cloudflare Access
		35: "6ae8cc23fa521794a6bd86aecc63c704c9ad457a403aef8eeb17f8fe4cd6a340", // connector_packages: set_devices returns at once; get shows per-device progress
		30: "28f5a3b00864af197a8d05acfaaa746965b5b0a3c44066243f539063e8881374", // ASC-2: App Store Connect curl examples through the gateway
		29: "444f19bacb28eb3627771a23b1d64908d5a9a8abccb51fa494a096f19d1f1407", // MCP: skill repository source; assistant device removal always asks
		28: "973fe7f7d3c6aa9549dccaffb6132268c4f17bdf4dab7f1abb934a125a0ef81c", // DEV-155: connector stand-ins work for what a turn leaves running
		27: "141eadfb461c0a018bd7ddc4b14f0f22996faf89891a0fd670e0a57943ec307c", // DEV-151: model providers managed through the Foundry tools
		26: "be3f51ec1d28af37374fe6a1e5c1c464ed3319ce20dc2ca09394567bb89c1afa", // child questions and approvals reach the parent ("Foundry question:")
		21: "3322886e01f82e495be6c0b8f9bb48d66dd54a81b49f5e75ccb6cb333d2018f6", // DEV-111: device CLIs include connector extensions
		25: "348811c00affd940286c0398a83236c1ece2ed1c9e07de15fd0fc8372e577d92", // DEV-132/DEV-133: Tencent Cloud and Alibaba Cloud device CLIs
		24: "cd4f6ad3d3f0ce2c5d6029f1bde87dd69a0c1a755b896619e7b4b795ba26e03f", // DEV-136: GitHub scopes chosen in Connectors; gh auth refused in sessions
		23: "1a87ae2d326742a3c029477cd0aaba886c8d31256dba275201f57b77153c3d16", // DEV-126/DEV-128: Cloudflare through cf only; gh in the session environment
		22: "555db48402ba9d93e13d29b86af20e3dc705c18493b5f5f6b6a9061c02307f03", // DEV-114: GitHub CLI is a device CLI
		20: "17f24d26a6b2aa38746111b556139c6d664d11487cafd1e56da0a12e5b3e260e", // DEV-107 legacy round: launchers named after the browser
		19: "127e3e9cc77d9cdacb42d269fad42232e76128ebf21c1ffd346afc314d957008", // DEV-108: device and accounts move from session notes to a reference
		18: "1fa24b3087763f24a174fa704dea78b57e89e073ba13d102be273b794eb62e81", // DEV-105: no Skill isolation wording
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

func TestFoundryOrchestrationSkillPackageHasARecordedRevision(t *testing.T) {
	revisions := map[int]string{
		1: "17e7abd2df2ea05d301f29931c50a3d4827b275e32e31273c2680597a8964f36",
		2: "7d44e7eae02adf52271709f4fdef11eb12a8296f84a06aabc7515241da087c17", // a worker keeps one model id; 429 retries the same id
		3: "da8f045c00d119abd4e5608e247d22948f340f021a9eeb3735254f5a25d2039a", // model_guides: read the worker model's guide before briefing; worker groups
		4: "b626a2ab3574e548258b1564f342033dc752d2e6f9b86a7e915be15ad01d1ad8", // orchestrator stays out of the work: delegate by default; tighter trigger description
		5: "ed6674cbf74a097c599d4ba07dc10b03017b9f4dc63f5e78fa26742addc93f80", // explicit invocation only
		6: "845dd9654a2a0cd9cc86564797d82b4cfe341b59d8ba34bb98cecb4a165b537c", // execution models: default plus alternatives; guides describe their own model only
	}
	claude, _ := Lookup("builtin-claude-foundry-orchestration")
	codex, _ := Lookup("builtin-codex-foundry-orchestration")
	if claude.Revision != codex.Revision {
		t.Fatal("both runtimes must receive the same Foundry orchestration revision")
	}
	if claude.Checksum != codex.Checksum || claude.SourceDigest != codex.SourceDigest {
		t.Fatal("both runtimes must receive the same Foundry orchestration bytes")
	}
	if want := revisions[claude.Revision]; want != claude.Checksum {
		t.Fatalf("%s revision %d has unrecorded package %s; bump and record the new revision", claude.ID, claude.Revision, claude.Checksum)
	}
	description := strings.ToLower(claude.Description)
	for _, trigger := range []string{"orchestrator", "brief", "review", "explicitly", "/foundry-orchestration", "own subagents"} {
		if !strings.Contains(description, trigger) {
			t.Fatalf("description does not say %q: %q", trigger, claude.Description)
		}
	}
}

func TestBuiltInSkillsPackageLikeWorkspaceSkills(t *testing.T) {
	claude := ForRuntime("claude")
	if len(claude) != 3 || claude[0].Name != "skill-creator" || claude[1].Name != "foundry" || claude[2].Name != "foundry-orchestration" {
		t.Fatalf("claude built-ins = %+v, want skill-creator, foundry and foundry-orchestration", claude)
	}
	codex := ForRuntime("codex")
	if len(codex) != 2 || codex[0].Name != "foundry" || codex[0].ID != "builtin-codex-foundry" || codex[1].Name != "foundry-orchestration" {
		t.Fatalf("codex built-ins = %+v: Codex ships its own skill-creator; Foundry adds foundry and foundry-orchestration", codex)
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
	if want := []string{"SKILL.md", "references/device-and-accounts.md", "references/diagnosing.md", "references/model-providers.md"}; !slices.Equal(paths, want) {
		t.Fatalf("foundry package holds %v, want %v", paths, want)
	}
}
