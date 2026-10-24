package httpapi

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

// The protocol's normalizeProviderBaseUrl reads the same fixtures
// (packages/protocol/test/provider-endpoint.test.mjs), so the web preview is
// what the server saves.
func TestNormalizeProviderBaseURLMatchesProtocolFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/protocol/test/provider-endpoint-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name              string   `json:"name"`
		Runtime           string   `json:"runtime"`
		Input             string   `json:"input"`
		AddMissingVersion *bool    `json:"addMissingVersion"`
		BaseURL           string   `json:"baseUrl"`
		Corrections       []string `json:"corrections"`
		Error             string   `json:"error"`
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			addVersion := fixture.AddMissingVersion == nil || *fixture.AddMissingVersion
			baseURL, corrections, code := normalizeProviderBaseURL(fixture.Runtime, fixture.Input, addVersion)
			if code != fixture.Error {
				t.Fatalf("error = %q, want %q", code, fixture.Error)
			}
			if fixture.Error != "" {
				if _, ok := endpointErrorMessages[code]; !ok {
					t.Fatalf("no message for %q", code)
				}
				return
			}
			if baseURL != fixture.BaseURL || !slices.Equal(corrections, fixture.Corrections) {
				t.Fatalf("got %q %v, want %q %v", baseURL, corrections, fixture.BaseURL, fixture.Corrections)
			}
		})
	}
}

// A promoted copy is corrected while its device keeps the old form; the two
// still name one endpoint. A bare Codex host is not assumed to be /v1.
func TestSameProviderEndpointComparesRepairedForms(t *testing.T) {
	for _, tc := range []struct {
		runtime, a, b string
		want          bool
	}{
		{"claude", "https://relay.internal/v1", "https://relay.internal", true},
		{"claude", "https://relay.internal/v1/messages", "https://relay.internal/", true},
		{"codex", "https://relay.internal/v1/responses", "https://relay.internal/v1", true},
		{"codex", "https://relay.internal", "https://relay.internal/v1", false},
		{"claude", "https://relay.internal", "https://other.internal", false},
	} {
		if got := sameProviderEndpoint(tc.runtime, tc.a, tc.b); got != tc.want {
			t.Fatalf("sameProviderEndpoint(%s, %s, %s) = %v, want %v", tc.runtime, tc.a, tc.b, got, tc.want)
		}
	}
}
