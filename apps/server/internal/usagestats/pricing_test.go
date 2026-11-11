package usagestats

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const testPriceSnapshot = `{
  "anthropic/claude-sonnet-4-5": {
    "input_cost_per_token": 0.000001,
    "cache_read_input_token_cost": 0.000002,
    "cache_creation_input_token_cost": 0.000003,
    "output_cost_per_token": 0.000004
  },
  "gpt-5.1": {
    "input_cost_per_token": 0.000002,
    "cache_read_input_token_cost": 0.000002,
    "cache_creation_input_token_cost": 0,
    "output_cost_per_token": 0.000008
  }
}`

func TestNormalizeModelID(t *testing.T) {
	for input, want := range map[string]string{
		"anthropic/claude-sonnet-4-5":               "claude-sonnet-4-5",
		"OpenRouter/Anthropic/Claude-Sonnet-4-5-1M": "claude-sonnet-4-5",
		"gpt-5.1[1m]":              "gpt-5.1",
		"models/gemini-2.5-pro_1m": "gemini-2.5-pro",
	} {
		if got := normalizeModelID(input); got != want {
			t.Errorf("normalizeModelID(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestPriceCatalogLookupNormalizesProviderCaseAndSuffix(t *testing.T) {
	catalog, err := NewPriceCatalog([]byte(testPriceSnapshot))
	if err != nil {
		t.Fatal(err)
	}
	price, ok := catalog.lookup("OpenRouter/Anthropic/Claude-Sonnet-4-5-1M")
	if !ok || price.input == nil || *price.input != 1 {
		t.Fatalf("normalized price = %+v, found %v", price, ok)
	}
}

func TestRecorderPricesTurnsByPriority(t *testing.T) {
	ctx := context.Background()
	catalog, err := NewPriceCatalog([]byte(testPriceSnapshot))
	if err != nil {
		t.Fatal(err)
	}
	reported := 9.0
	tests := []struct {
		name       string
		model      string
		profileID  string
		reported   *float64
		wantSource string
		wantCost   float64
	}{
		{name: "reported wins", model: "claude-sonnet-4-5", profileID: "custom", reported: &reported, wantSource: store.UsageCostReported, wantCost: 9},
		{name: "custom price", model: "claude-sonnet-4-5-1m", profileID: "custom", wantSource: store.UsageCostCustom, wantCost: 0.01},
		{name: "LiteLLM estimate", model: "openai/claude-sonnet-4-5", wantSource: store.UsageCostEstimated, wantCost: 0.01},
		{name: "missing price", model: "unpriced-model", wantSource: store.UsageCostUnknown, wantCost: 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			st := &recorderStore{
				sessions: map[string]store.AgentSession{},
				profiles: map[string]store.ProfileDefinition{
					"custom": {
						ID: "custom",
						ModelPrices: map[string]store.ProfileModelPrice{
							"anthropic/claude-sonnet-4-5": {
								InputPerMillion: 1, CacheReadPerMillion: 2,
								CacheWritePerMillion: 3, OutputPerMillion: 4,
							},
						},
					},
				},
			}
			recorder := New(st, nil)
			recorder.prices = catalog
			session := store.AgentSession{
				ID: "sess_prices", WorkspaceID: "ws_prices", DeviceID: "dev_prices",
				Provider: "claude", ProfileID: test.profileID, Model: test.model,
				CreatedByUserID: "user_prices", Source: store.SessionSourceChat,
				Input: store.SessionInput{ID: "input_prices"}, StartedAt: "2026-11-10T01:00:00Z",
			}
			usage := store.AgentTurnUsage{
				Model: test.model, InputTokens: 1_000, CacheReadTokens: 1_000,
				CacheWriteTokens: 1_000, OutputTokens: 1_000, CostUSD: test.reported,
			}
			if err := recorder.Record(ctx, session, store.AgentSessionEvent{
				SessionID: session.ID, At: "2026-11-10T01:00:01Z",
				Metadata: &store.AgentSessionEventMetadata{TurnUsage: &usage},
			}); err != nil {
				t.Fatal(err)
			}
			turn := st.records[0].Turn
			if turn.CostSource != test.wantSource || math.Abs(turn.CostUSD-test.wantCost) > 1e-9 {
				t.Fatalf("cost = %.9f %s, want %.9f %s", turn.CostUSD, turn.CostSource, test.wantCost, test.wantSource)
			}
		})
	}
}

func TestPriceRefreshFailureKeepsSnapshot(t *testing.T) {
	catalog, err := NewPriceCatalog([]byte(testPriceSnapshot))
	if err != nil {
		t.Fatal(err)
	}
	trap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer trap.Close()
	catalog.client = trap.Client()
	if err := catalog.Refresh(context.Background(), trap.URL); err == nil {
		t.Fatal("refresh unexpectedly succeeded")
	}
	price, ok := catalog.lookup("claude-sonnet-4-5")
	if !ok || price.output == nil || *price.output != 4 {
		t.Fatalf("snapshot after failed refresh = %+v, found %v", price, ok)
	}
}

func TestRepriceReplacesNonReportedCostsOnly(t *testing.T) {
	catalog, err := NewPriceCatalog([]byte(testPriceSnapshot))
	if err != nil {
		t.Fatal(err)
	}
	st := &recorderStore{
		sessions: map[string]store.AgentSession{},
		profiles: map[string]store.ProfileDefinition{},
		repriceTurns: []store.UsageTurn{
			{
				SessionID: "reported", InputID: "input", Model: "claude-sonnet-4-5",
				InputTokens: 1_000, OutputTokens: 1_000,
				CostUSD: 5, CostSource: store.UsageCostReported,
				StartedAt: "2026-11-10T01:00:00Z", Outcome: store.UsageOutcomeCompleted,
			},
			{
				SessionID: "estimated", InputID: "input", Model: "claude-sonnet-4-5",
				InputTokens: 1_000, OutputTokens: 1_000,
				CostUSD: 99, CostSource: store.UsageCostEstimated,
				StartedAt: "2026-11-10T02:00:00Z", Outcome: store.UsageOutcomeCompleted,
			},
		},
	}
	recorder := New(st, nil)
	recorder.prices = catalog
	if err := recorder.Reprice(context.Background(), RepriceOptions{}); err != nil {
		t.Fatal(err)
	}
	if len(st.repriceUpdates) != 1 || st.repriceUpdates[0].SessionID != "estimated" {
		t.Fatalf("reprice updates = %+v", st.repriceUpdates)
	}
	updated := st.repriceUpdates[0]
	if updated.CostSource != store.UsageCostEstimated || math.Abs(updated.CostUSD-0.005) > 1e-9 {
		t.Fatalf("repriced cost = %.9f %s", updated.CostUSD, updated.CostSource)
	}
}
