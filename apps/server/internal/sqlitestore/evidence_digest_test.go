package sqlitestore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The worker digests with JSON.stringify; packages/worker/test/evidence-digest.test.mjs checks
// its digestObject against the same canonical texts.
func TestEvidenceCanonicalDigestMatchesJavaScript(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/protocol/test/evidence-digest-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Value     any    `json:"value"`
		Canonical string `json:"canonical"`
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for i, fixture := range fixtures {
		if got := canonicalEvidenceJSON(fixture.Value); got != fixture.Canonical {
			t.Fatalf("canonical drift fixture %d:\n go %s\n js %s", i, got, fixture.Canonical)
		}
		hash := sha256.Sum256([]byte(fixture.Canonical))
		if got := evidenceDigest(fixture.Value); got != "sha256:"+hex.EncodeToString(hash[:]) {
			t.Fatalf("digest drift fixture %d: %s", i, got)
		}
	}
}

// The encodings and digests were recorded with the hand-flattened unions (before B-21), whose
// encoder sorted a union's keys and filled its variant's nil required collections. With the
// generated unions:
//   - Go builds a value through From<Variant>: the encoding is byte for byte the recorded one,
//     including [] and {} for collections Go code left nil;
//   - a decoded value keeps the union's bytes as received, so it re-encodes to the recorded
//     JSON up to key order (same digest); input that omits a variant's required collection is
//     no longer filled in, so the schema rejects it.
func TestEvidenceModelEncodingUnchanged(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/protocol/test/evidence-union-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name    string          `json:"name"`
		Model   string          `json:"model"`
		Value   json.RawMessage `json:"value"`
		Encoded string          `json:"encoded"`
		Digest  string          `json:"digest"`
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	models := map[string]func() any{
		"CheckDefinition":   func() any { return &store.CheckDefinition{} },
		"EvidenceCitation":  func() any { return &store.EvidenceCitation{} },
		"ReferenceCitation": func() any { return &store.ReferenceCitation{} },
		"Verification":      func() any { return &store.Verification{} },
		"Material":          func() any { return &store.Material{} },
		"CheckReport":       func() any { return &store.CheckReport{} },
		"VerifierIdentity":  func() any { return &store.VerifierIdentity{} },
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			model := models[fixture.Model]()
			if err := json.Unmarshal(fixture.Value, model); err != nil {
				t.Fatal(err)
			}
			decoded, err := json.Marshal(model)
			if err != nil {
				t.Fatal(err)
			}
			complete := store.ValidateEvidenceJSON(fixture.Model, decoded) == nil
			if complete != !strings.Contains(fixture.Name, "without collections") {
				t.Fatalf("schema accepts the decoded value: %v", complete)
			}
			if complete && canonicalJSON(t, decoded) != canonicalJSON(t, []byte(fixture.Encoded)) {
				t.Fatalf("decoded value changed:\n got  %s\n want %s", decoded, fixture.Encoded)
			}
			rebuildUnions(t, model)
			encoded, err := json.Marshal(model)
			if err != nil {
				t.Fatal(err)
			}
			if string(encoded) != fixture.Encoded {
				t.Fatalf("encoding changed:\n got  %s\n want %s", encoded, fixture.Encoded)
			}
			if got := evidenceDigest(model); got != fixture.Digest {
				t.Fatalf("digest changed: %s, want %s", got, fixture.Digest)
			}
		})
	}
}

// Stored rows decode and re-encode byte for byte. Rows hold private data, so none are
// checked in: FOUNDRY_EVIDENCE_ROWS names a JSONL file of {"kind", "payload"} objects read
// from a database copy (see docs/refactor/phase6-openapi-design.md, S0).
func TestStoredEvidenceRoundTrip(t *testing.T) {
	path := os.Getenv("FOUNDRY_EVIDENCE_ROWS")
	if path == "" {
		t.Skip("FOUNDRY_EVIDENCE_ROWS is not set")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	models := map[string]func() any{
		"audit":        func() any { return &store.AuditEvent{} },
		"candidate":    func() any { return &store.CandidateSnapshot{} },
		"integration":  func() any { return &store.CandidateSnapshot{} },
		"contract":     func() any { return &store.IssueContract{} },
		"decision":     func() any { return &store.AcceptanceDecision{} },
		"evidence":     func() any { return &store.Evidence{} },
		"input":        func() any { return &store.VerificationInput{} },
		"material":     func() any { return &store.Material{} },
		"review":       func() any { return &store.ReviewSnapshot{} },
		"verification": func() any { return &store.Verification{} },
		"assessment":   func() any { return &store.HumanAssessment{} },
	}
	checked, skipped := map[string]int{}, map[string]int{}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var row struct {
			Kind    string `json:"kind"`
			Payload string `json:"payload"`
		}
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatal(err)
		}
		model, ok := models[row.Kind]
		if !ok {
			skipped[row.Kind]++
			continue
		}
		value := model()
		if err := json.Unmarshal([]byte(row.Payload), value); err != nil {
			t.Fatalf("%s: %v", row.Kind, err)
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if string(encoded) != row.Payload {
			t.Errorf("%s re-encodes differently:\n got  %s\n want %s", row.Kind, encoded, row.Payload)
		}
		checked[row.Kind]++
	}
	t.Logf("byte-equal rows by kind: %v; not evidence models: %v", checked, skipped)
}

func canonicalJSON(t *testing.T, raw []byte) string {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return canonicalEvidenceJSON(value)
}

// rebuildUnions sets every union of a fixture model the way Go code builds one: from its
// variant struct, through From<Variant>.
func rebuildUnions(t *testing.T, model any) {
	t.Helper()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	selector := func(s *store.MaterialSelector) {
		if s == nil {
			return
		}
		value, err := s.ValueByDiscriminator()
		must(err)
		switch v := value.(type) {
		case store.MaterialSelectorTextLines:
			must(s.FromMaterialSelectorTextLines(v))
		case store.MaterialSelectorPage:
			must(s.FromMaterialSelectorPage(v))
		case store.MaterialSelectorTimeRange:
			must(s.FromMaterialSelectorTimeRange(v))
		case store.MaterialSelectorImageRegion:
			must(s.FromMaterialSelectorImageRegion(v))
		case store.MaterialSelectorJSONPointer:
			must(s.FromMaterialSelectorJSONPointer(v))
		}
	}
	executor := func(e *store.VerifierIdentity) {
		value, err := e.ValueByDiscriminator()
		must(err)
		switch v := value.(type) {
		case store.VerifierIdentityProgram:
			must(e.FromVerifierIdentityProgram(v))
		case store.VerifierIdentityAgent:
			must(e.FromVerifierIdentityAgent(v))
		}
	}
	switch m := model.(type) {
	case *store.CheckDefinition:
		value, err := m.Configuration.ValueByDiscriminator()
		must(err)
		switch v := value.(type) {
		case store.CheckConfigurationCommand:
			must(m.Configuration.FromCheckConfigurationCommand(v))
		case store.CheckConfigurationProjectCommand:
			must(m.Configuration.FromCheckConfigurationProjectCommand(v))
		case store.CheckConfigurationHTTP:
			must(m.Configuration.FromCheckConfigurationHTTP(v))
		}
	case *store.EvidenceCitation:
		selector(m.Selector)
	case *store.ReferenceCitation:
		selector(m.Selector)
	case *store.VerifierIdentity:
		executor(m)
	case *store.Verification:
		executor(&m.Executor)
		if m.Result != nil {
			for _, finding := range m.Result.Findings {
				for i := range finding.EvidenceCitations {
					selector(finding.EvidenceCitations[i].Selector)
				}
				for i := range finding.ReferenceCitations {
					selector(finding.ReferenceCitations[i].Selector)
				}
			}
		}
	}
}
