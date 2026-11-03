package store

import (
	"encoding/json"
	"os"
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
	})
	if ValidateEvidenceJSON("ContractContent", attested) == nil {
		t.Fatal("a deterministic criterion accepted human-attested evidence")
	}
	unchecked := agentCriterion(func(c *AcceptanceCriterion) {
		c.EvaluationMode = "deterministic"
		c.EvidenceRequirements[0].BindingPolicy = "system_observed"
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
