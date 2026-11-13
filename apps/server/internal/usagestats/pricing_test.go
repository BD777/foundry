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
  },
  "tencent/deepseek-v4.1-flash": {
    "input_cost_per_token": 0.0000003,
    "cache_read_input_token_cost": 0.000000006,
    "output_cost_per_token": 0.0000012,
    "litellm_provider": "tencent"
  },
  "aiand/deepseek-ai/deepseek-v4.1-flash-1017": {
    "input_cost_per_token": 0.0000003,
    "cache_read_input_token_cost": 0.00000002,
    "output_cost_per_token": 0.0000006,
    "litellm_provider": "aiand"
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

func TestPriceCatalogLookupPrefersServingProviderForAmbiguousModel(t *testing.T) {
	catalog, err := NewPriceCatalog([]byte(testPriceSnapshot))
	if err != nil {
		t.Fatal(err)
	}
	price, ok := catalog.lookupForProvider(
		"deepseek-v4.1-flash-1017",
		"Tencent TokenHub https://tokenhub.tencentmaas.com/v1",
	)
	if !ok || price.cacheRead == nil || *price.cacheRead != 0.006 ||
		price.output == nil || *price.output != 1.2 {
		t.Fatalf("Tencent provider price = %+v, found %v", price, ok)
	}
	unhinted, ok := catalog.lookup("deepseek-v4.1-flash-1017")
	if !ok || unhinted.cacheRead == nil || *unhinted.cacheRead != 0.02 {
		t.Fatalf("unhinted normalized price = %+v, found %v", unhinted, ok)
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
				Model: test.model, InputTokens: 3_000, CacheReadTokens: 1_000,
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

func TestCostForTokensPricesInclusivePromptTotal(t *testing.T) {
	priceAt := func(value float64) *float64 { return &value }
	tests := []struct {
		name   string
		source string
		price  tokenPrices
		tokens usageTokens
		want   float64
		ok     bool
	}{
		{
			name:   "Claude SDK result with cache writes",
			source: "result.usage input_tokens excludes cache reads and writes",
			price: tokenPrices{
				input: priceAt(4), cacheRead: priceAt(0.2), cacheWrite: priceAt(5), output: priceAt(20),
			},
			tokens: usageTokens{input: 10_000, cacheRead: 7_000, cacheWrite: 1_000, output: 500},
			want:   (2_000*4.0 + 7_000*0.2 + 1_000*5 + 500*20) / 1_000_000,
			ok:     true,
		},
		{
			name:   "Anthropic stream with real-shaped cached prompt",
			source: "message_delta input_tokens excludes cache reads and writes",
			price: tokenPrices{
				input: priceAt(0.3), cacheRead: priceAt(0.006), cacheWrite: priceAt(0), output: priceAt(1.2),
			},
			tokens: usageTokens{input: 515_202, cacheRead: 513_920, output: 2_000},
			want:   (1_282*0.3 + 513_920*0.006 + 2_000*1.2) / 1_000_000,
			ok:     true,
		},
		{
			name:   "Codex Responses prompt total is already inclusive",
			source: "turn.completed input_tokens includes cached_input_tokens",
			price: tokenPrices{
				input: priceAt(2), cacheRead: priceAt(0.2), cacheWrite: priceAt(0), output: priceAt(8),
			},
			tokens: usageTokens{input: 28_887, cacheRead: 27_264, output: 1_291},
			want:   (1_623*2.0 + 27_264*0.2 + 1_291*8.0) / 1_000_000,
			ok:     true,
		},
		{
			name:   "Codex chat and app-server totals are already inclusive",
			source: "chat token_count and app-server thread/tokenUsage/updated pass input_tokens through",
			price: tokenPrices{
				input: priceAt(2), cacheRead: priceAt(0.2), cacheWrite: priceAt(0), output: priceAt(8),
			},
			tokens: usageTokens{input: 85_614, cacheRead: 82_048, output: 938},
			want:   (3_566*2.0 + 82_048*0.2 + 938*8.0) / 1_000_000,
			ok:     true,
		},
		{
			name:   "Codex inclusive prompt without cache",
			source: "turn.completed input_tokens already includes cache fields",
			price: tokenPrices{
				input: priceAt(2), cacheRead: priceAt(0.2), cacheWrite: priceAt(0), output: priceAt(8),
			},
			tokens: usageTokens{input: 1_000, output: 100},
			want:   (1_000*2.0 + 100*8) / 1_000_000,
			ok:     true,
		},
		{
			name:   "missing cache prices use input rate",
			source: "catalog entry has only input and output prices",
			price: tokenPrices{
				input: priceAt(2), output: priceAt(4),
			},
			tokens: usageTokens{input: 1_000, cacheRead: 700, cacheWrite: 100, output: 100},
			want:   (1_000*2.0 + 100*4.0) / 1_000_000,
			ok:     true,
		},
		{
			name:   "cache counts never make uncached input negative",
			source: "defensive clamp for inconsistent provider data",
			price: tokenPrices{
				input: priceAt(2), cacheRead: priceAt(0.2), cacheWrite: priceAt(3), output: priceAt(4),
			},
			tokens: usageTokens{input: 100, cacheRead: 80, cacheWrite: 40, output: 10},
			want:   (80*0.2 + 40*3.0 + 10*4.0) / 1_000_000,
			ok:     true,
		},
		{
			name:   "missing output price is unknown",
			source: "output cannot silently go unpriced",
			price: tokenPrices{
				input: priceAt(2), cacheRead: priceAt(0.2),
			},
			tokens: usageTokens{input: 1_000, cacheRead: 700, output: 100},
			ok:     false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := costForTokens(test.price, test.tokens)
			if ok != test.ok || math.Abs(got-test.want) > 1e-12 {
				t.Fatalf("%s: cost = %.12f, ok %v; want %.12f, ok %v", test.source, got, ok, test.want, test.ok)
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
