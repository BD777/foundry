package store

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestSharedEvidenceFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/protocol/test/evidence-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name  string          `json:"name"`
		Model string          `json:"model"`
		Valid bool            `json:"valid"`
		Value json.RawMessage `json:"value"`
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			err := ValidateEvidenceJSON(fixture.Model, fixture.Value)
			if (err == nil) != fixture.Valid {
				t.Fatalf("expected valid=%v: %v", fixture.Valid, err)
			}
		})
	}
}

func TestConfirmedContractCannotTrustOnlyStatusProjection(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/protocol/test/evidence-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name  string         `json:"name"`
		Value map[string]any `json:"value"`
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	var contract map[string]any
	for _, fixture := range fixtures {
		if fixture.Name == "observable agent criterion" {
			contract = fixture.Value
		}
	}
	actor := ActorRef{Kind: "local_owner", ID: "owner", DisplayName: "Owner"}
	digest := "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	for key, value := range map[string]any{
		"schemaVersion": 1, "id": "contract", "workspaceId": "ws", "issueId": "issue",
		"createdAt": "2026-09-10T00:00:00Z", "createdBy": actor, "revision": 1,
		"origin": "user", "status": "confirmed", "contentDigest": digest,
		"confirmation": map[string]any{"actor": actor, "at": "2026-09-10T00:00:00Z", "contentDigest": digest},
	} {
		contract[key] = value
	}
	valid, _ := json.Marshal(contract)
	if err = ValidateEvidenceJSON("IssueContract", valid); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(map[string]any){
		"missing confirmation":    func(c map[string]any) { delete(c, "confirmation") },
		"empty criteria":          func(c map[string]any) { c["criteria"] = []any{} },
		"draft with confirmation": func(c map[string]any) { c["status"] = "draft" },
		"wrong digest": func(c map[string]any) {
			c["confirmation"].(map[string]any)["contentDigest"] = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		},
		"daemon actor": func(c map[string]any) {
			c["confirmation"].(map[string]any)["actor"].(map[string]any)["kind"] = "daemon"
		},
		"anonymous actor": func(c map[string]any) {
			c["confirmation"].(map[string]any)["actor"].(map[string]any)["id"] = ""
		},
	} {
		t.Run(name, func(t *testing.T) {
			var copy map[string]any
			_ = json.Unmarshal(valid, &copy)
			change(copy)
			invalid, _ := json.Marshal(copy)
			if ValidateEvidenceJSON("IssueContract", invalid) == nil {
				t.Fatal("invalid confirmed contract accepted")
			}
		})
	}
}

func TestProjectCommandCriterionMustStayRunnable(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/protocol/test/evidence-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name  string          `json:"name"`
		Value json.RawMessage `json:"value"`
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	var valid json.RawMessage
	for _, fixture := range fixtures {
		if fixture.Name == "project command criterion" {
			valid = fixture.Value
		}
	}
	if valid == nil {
		t.Fatal("project command fixture is missing")
	}
	read := func() ContractContent {
		var content ContractContent
		if err := json.Unmarshal(valid, &content); err != nil {
			t.Fatal(err)
		}
		return content
	}
	if err := ValidateContractContent(read(), true); err != nil {
		t.Fatal("a runnable project command was rejected:", err)
	}
	projectCommand := func(content ContractContent) CheckConfigurationProjectCommand {
		value, err := content.Criteria[0].Checker.Configuration.ValueByDiscriminator()
		config, ok := value.(CheckConfigurationProjectCommand)
		if err != nil || !ok {
			t.Fatalf("not a project command: %v %T", err, value)
		}
		return config
	}
	bundle := read()
	var withBundle map[string]any
	raw, _ = json.Marshal(projectCommand(bundle))
	_ = json.Unmarshal(raw, &withBundle)
	withBundle["checkerBundleMaterialId"] = "mat_bundle"
	raw, _ = json.Marshal(withBundle)
	if err := bundle.Criteria[0].Checker.Configuration.UnmarshalJSON(raw); err != nil {
		t.Fatal(err)
	}
	if raw, _ := json.Marshal(bundle); ValidateEvidenceJSON("ContractContent", raw) == nil {
		t.Fatal("accepted a project command carrying checker bundle fields")
	}
	noExit := read()
	config := projectCommand(noExit)
	config.ExpectedExitCodes = nil
	if err := noExit.Criteria[0].Checker.Configuration.FromCheckConfigurationProjectCommand(config); err != nil {
		t.Fatal(err)
	}
	if ValidateContractContent(noExit, true) == nil {
		t.Fatal("accepted a project command without a passing exit code")
	}
	unchecked := read()
	unchecked.Criteria[0].Checker = nil
	if ValidateContractContent(unchecked, true) == nil {
		t.Fatal("accepted a deterministic criterion with no checker to run")
	}
}

// A requirement no evidence source can satisfy is a problem: the clarifier's
// "only hello.txt changed" asked the change list (which produces data) for a
// text_log, so the export failed and the criterion could never pass.
func TestRequirementMustAcceptWhatItsSourceProduces(t *testing.T) {
	source := func(s EvidenceRequirementSource) *EvidenceRequirementSource { return &s }
	scope := func(r EvidenceRequirement) ContractContent {
		return ContractContent{
			Goal:    RichContent{Text: "Create hello.txt containing hi and change nothing else", Media: []ReferenceMedia{}},
			InScope: []string{}, OutOfScope: []string{}, Constraints: []string{},
			Criteria: []AcceptanceCriterion{{
				ID: "scope", Title: "Only hello.txt changed", Statement: "The candidate changes no file but hello.txt",
				Required: true, ProofKind: "constraint_compliance", EvaluationMode: "agent",
				Rubric:               RichContent{Text: "The change list holds exactly one entry, hello.txt", Media: []ReferenceMedia{}},
				EvidenceRequirements: []EvidenceRequirement{r},
			}},
		}
	}
	changes := EvidenceRequirement{ID: "changes", Description: "Git change list of the candidate", AcceptedCarriers: []CarrierKind{"text_log"}, MinimumCount: 1, BindingPolicy: "system_observed", Source: source(EvidenceRequirementSourceCandidateChanges)}
	err := ValidateContractContent(scope(changes), false)
	if err == nil || !strings.Contains(err.Error(), "scope/changes: source candidate_changes produces only data") {
		t.Fatalf("a change list asked for a text_log was not rejected: %v", err)
	}
	changes.AcceptedCarriers = []CarrierKind{"data"}
	if err := ValidateContractContent(scope(changes), true); err != nil {
		t.Fatal("the change list as data was rejected:", err)
	}
	unnamed := changes
	unnamed.Source = nil
	if err := ValidateContractContent(scope(unnamed), false); err != nil {
		t.Fatal("a draft requirement without a source was rejected:", err)
	}
	if err := ValidateContractContent(scope(unnamed), true); err == nil || !strings.Contains(err.Error(), "evidence source required") {
		t.Fatalf("an agent requirement without a source could be confirmed: %v", err)
	}
	upload := changes
	upload.Source = source(EvidenceRequirementSourceHumanUpload)
	if err := ValidateContractContent(scope(upload), true); err == nil {
		t.Fatal("a person's upload satisfied a system-observed requirement")
	}
	checker := changes
	checker.Source, checker.AcceptedCarriers = source(EvidenceRequirementSourceCheckerCommand), []CarrierKind{"text_log"}
	if err := ValidateContractContent(scope(checker), true); err == nil {
		t.Fatal("an agent criterion took a checker's output")
	}

	raw, err := os.ReadFile("../../../../packages/protocol/test/evidence-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name  string          `json:"name"`
		Value json.RawMessage `json:"value"`
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		if fixture.Name != "project command criterion" {
			continue
		}
		var program ContractContent
		if err := json.Unmarshal(fixture.Value, &program); err != nil {
			t.Fatal(err)
		}
		program.Criteria[0].EvidenceRequirements[0].AcceptedCarriers = []CarrierKind{"document"}
		if err := ValidateContractContent(program, true); err == nil || !strings.Contains(err.Error(), "source checker_command produces only text_log") {
			t.Fatalf("a project command was asked for a document: %v", err)
		}
		return
	}
	t.Fatal("project command fixture is missing")
}

// The rules beyond the schema, which only the server decides.
func TestContractRulesBeyondTheSchema(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/protocol/test/evidence-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name  string          `json:"name"`
		Value json.RawMessage `json:"value"`
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	named := map[string]json.RawMessage{}
	for _, fixture := range fixtures {
		named[fixture.Name] = fixture.Value
	}
	if problems := ContractProblems(named["empty draft is allowed"], false); len(problems) != 0 {
		t.Fatal("an empty draft was rejected:", problems)
	}
	if problems := ContractProblems(named["empty draft is allowed"], true); len(problems) == 0 {
		t.Fatal("an empty draft could be confirmed")
	}
	agentCriterion := func(change func(*AcceptanceCriterion)) []byte {
		var content ContractContent
		if err := json.Unmarshal(named["observable agent criterion"], &content); err != nil {
			t.Fatal(err)
		}
		change(&content.Criteria[0])
		raw, _ := json.Marshal(content)
		return raw
	}
	attested := agentCriterion(func(c *AcceptanceCriterion) {
		c.EvaluationMode = "deterministic"
		c.EvidenceRequirements[0].BindingPolicy = "system_or_human_attested"
		c.EvidenceRequirements[0].Source = nil
	})
	if ValidateEvidenceJSON("ContractContent", attested) == nil {
		t.Fatal("a deterministic criterion accepted human-attested evidence")
	}
	unchecked := agentCriterion(func(c *AcceptanceCriterion) {
		c.EvaluationMode = "deterministic"
		c.EvidenceRequirements[0].BindingPolicy = "system_observed"
		c.EvidenceRequirements[0].Source = nil
	})
	if problems := ContractProblems(unchecked, false); len(problems) != 0 {
		t.Fatal("a draft deterministic criterion without its checker was rejected:", problems)
	}
	if problems := ContractProblems(unchecked, true); len(problems) != 1 {
		t.Fatal("a deterministic criterion without its checker could be confirmed:", problems)
	}
	// Every problem is reported, not only the first.
	broken := agentCriterion(func(c *AcceptanceCriterion) {
		c.Rubric.Text = " "
		c.EvidenceRequirements[0].AcceptedCarriers = []CarrierKind{}
	})
	if problems := ContractProblems(broken, false); len(problems) != 2 {
		t.Fatal("expected both problems:", problems)
	}
	if problems := ContractProblems([]byte(`{"goal":{"text":"x","media":[]}}`), false); len(problems) != 1 {
		t.Fatal("a schema violation is the problem:", problems)
	}
}
