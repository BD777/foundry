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
	bundle := read()
	id := "mat_bundle"
	bundle.Criteria[0].Checker.Configuration.CheckerBundleMaterialID = &id
	if ValidateContractContent(bundle, true) == nil {
		t.Fatal("accepted a project command carrying checker bundle fields")
	}
	noExit := read()
	noExit.Criteria[0].Checker.Configuration.ExpectedExitCodes = nil
	if ValidateContractContent(noExit, true) == nil {
		t.Fatal("accepted a project command without a passing exit code")
	}
	unchecked := read()
	unchecked.Criteria[0].Checker = nil
	if ValidateContractContent(unchecked, true) == nil {
		t.Fatal("accepted a deterministic criterion with no checker to run")
	}
}
