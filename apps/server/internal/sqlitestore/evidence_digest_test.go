package sqlitestore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
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

// The encodings and digests were recorded with the models generated before the OpenAPI
// contract; the generated models must reproduce them, including [] and {} for the required
// collections of a union variant that Go code left nil.
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
