package usagestats

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	// DefaultPriceSourceURL is LiteLLM's maintained model price catalog.
	DefaultPriceSourceURL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
	// PriceRefreshInterval is how often the server looks for a newer catalog.
	PriceRefreshInterval = 24 * time.Hour

	maxPriceSnapshotBytes = 16 << 20
)

//go:embed data/model_prices_and_context_window.json
var embeddedPriceSnapshot []byte

// tokenPrices are US dollars per one million tokens. A nil tier means the
// catalog does not price that token class.
type tokenPrices struct {
	input      *float64
	cacheRead  *float64
	cacheWrite *float64
	output     *float64
}

type priceBook struct {
	// exact preserves a provider-qualified catalog key. normalized allows a
	// model id such as openrouter/anthropic/claude-sonnet-4-5-1m to match the
	// canonical Claude entry.
	exact      map[string]tokenPrices
	normalized map[string]tokenPrices
	providers  map[string]map[string]tokenPrices
}

// PriceCatalog is a process-local LiteLLM price view. A refresh parses a
// complete replacement before publishing it, so readers always see either the
// previous catalog or the new one.
type PriceCatalog struct {
	current atomic.Pointer[priceBook]
	client  *http.Client
}

type litellmPrice struct {
	InputCostPerToken           *float64 `json:"input_cost_per_token"`
	CacheReadInputTokenCost     *float64 `json:"cache_read_input_token_cost"`
	CacheCreationInputTokenCost *float64 `json:"cache_creation_input_token_cost"`
	OutputCostPerToken          *float64 `json:"output_cost_per_token"`
	LiteLLMProvider             string   `json:"litellm_provider"`
}

func NewPriceCatalog(snapshot []byte) (*PriceCatalog, error) {
	book, err := parsePriceBook(snapshot)
	if err != nil {
		return nil, err
	}
	catalog := &PriceCatalog{
		client: &http.Client{Timeout: 30 * time.Second},
	}
	catalog.current.Store(book)
	return catalog, nil
}

func newEmbeddedPriceCatalog() (*PriceCatalog, error) {
	return NewPriceCatalog(embeddedPriceSnapshot)
}

// Refresh downloads source and publishes it only when the response is a
// complete JSON object with at least one usable model price. Any failure
// leaves the current snapshot untouched.
func (c *PriceCatalog) Refresh(ctx context.Context, source string) error {
	if c == nil {
		return errors.New("price catalog is unavailable")
	}
	if strings.TrimSpace(source) == "" {
		source = DefaultPriceSourceURL
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return fmt.Errorf("build price refresh request: %w", err)
	}
	response, err := c.client.Do(request)
	if err != nil {
		return fmt.Errorf("fetch LiteLLM prices: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("fetch LiteLLM prices: HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxPriceSnapshotBytes+1))
	if err != nil {
		return fmt.Errorf("read LiteLLM prices: %w", err)
	}
	if len(body) > maxPriceSnapshotBytes {
		return fmt.Errorf("read LiteLLM prices: snapshot exceeds %d bytes", maxPriceSnapshotBytes)
	}
	book, err := parsePriceBook(body)
	if err != nil {
		return err
	}
	c.current.Store(book)
	return nil
}

func (c *PriceCatalog) lookup(model string) (tokenPrices, bool) {
	return c.lookupForProvider(model, "")
}

// lookupForProvider resolves ambiguous public model ids with a provider hint
// from the serving profile. A checkpoint suffix may name the same catalog model
// without that suffix, as Tencent's deepseek-v4.1-flash does.
func (c *PriceCatalog) lookupForProvider(model, providerHint string) (tokenPrices, bool) {
	if c == nil {
		return tokenPrices{}, false
	}
	book := c.current.Load()
	if book == nil {
		return tokenPrices{}, false
	}
	model = strings.TrimSpace(model)
	if price, ok := book.exact[modelKey(model)]; ok {
		return price, true
	}
	if provider := matchingProvider(book.providers, providerHint); provider != "" {
		normalized := normalizeModelID(model)
		if price, ok := book.providers[provider][normalized]; ok {
			return price, true
		}
		if base := checkpointBaseModelID(normalized); base != normalized {
			if price, ok := book.providers[provider][base]; ok {
				return price, true
			}
		}
	}
	price, ok := book.normalized[normalizeModelID(model)]
	return price, ok
}

func parsePriceBook(snapshot []byte) (*priceBook, error) {
	var raw map[string]litellmPrice
	if err := json.Unmarshal(snapshot, &raw); err != nil {
		return nil, fmt.Errorf("parse LiteLLM prices: %w", err)
	}
	book := &priceBook{
		exact:      map[string]tokenPrices{},
		normalized: map[string]tokenPrices{},
		providers:  map[string]map[string]tokenPrices{},
	}
	keys := make([]string, 0, len(raw))
	for key := range raw {
		keys = append(keys, key)
	}
	// Prefer canonical entries without a provider prefix when two catalog
	// entries normalize to the same public model id.
	sort.Slice(keys, func(i, j int) bool {
		leftProvider := strings.Contains(keys[i], "/")
		rightProvider := strings.Contains(keys[j], "/")
		if leftProvider != rightProvider {
			return !leftProvider
		}
		return keys[i] < keys[j]
	})
	for _, key := range keys {
		entry := raw[key]
		price := tokenPrices{
			input:      scaledPrice(entry.InputCostPerToken),
			cacheRead:  scaledPrice(entry.CacheReadInputTokenCost),
			cacheWrite: scaledPrice(entry.CacheCreationInputTokenCost),
			output:     scaledPrice(entry.OutputCostPerToken),
		}
		if price.input == nil && price.cacheRead == nil && price.cacheWrite == nil && price.output == nil {
			continue
		}
		book.exact[modelKey(key)] = price
		normalized := normalizeModelID(key)
		if _, present := book.normalized[normalized]; normalized != "" && !present {
			book.normalized[normalized] = price
		}
		provider := strings.ToLower(strings.TrimSpace(entry.LiteLLMProvider))
		if provider == "" {
			if slash := strings.IndexByte(key, '/'); slash > 0 {
				provider = strings.ToLower(strings.TrimSpace(key[:slash]))
			}
		}
		if provider != "" && normalized != "" {
			if book.providers[provider] == nil {
				book.providers[provider] = map[string]tokenPrices{}
			}
			if _, present := book.providers[provider][normalized]; !present {
				book.providers[provider][normalized] = price
			}
			base := checkpointBaseModelID(normalized)
			if base != normalized {
				if _, present := book.providers[provider][base]; !present {
					book.providers[provider][base] = price
				}
			}
		}
	}
	if len(book.normalized) == 0 {
		return nil, errors.New("parse LiteLLM prices: no usable model prices")
	}
	return book, nil
}

func scaledPrice(perToken *float64) *float64 {
	if perToken == nil || math.IsNaN(*perToken) || math.IsInf(*perToken, 0) || *perToken < 0 {
		return nil
	}
	perMillion := *perToken * 1_000_000
	return &perMillion
}

// modelKey preserves a provider prefix but makes case and the context-window
// suffix insignificant.
func modelKey(model string) string {
	return stripContextSuffix(strings.ToLower(strings.TrimSpace(model)))
}

// normalizeModelID is the public model identity used across providers:
// provider prefixes are removed, case is folded, and context-window suffixes
// such as -1m or [1m] are dropped.
func normalizeModelID(model string) string {
	model = modelKey(model)
	if slash := strings.LastIndex(model, "/"); slash >= 0 {
		model = model[slash+1:]
	}
	return strings.TrimSpace(model)
}

func stripContextSuffix(model string) string {
	for {
		trimmed := model
		for _, suffix := range []string{"-1m", "_1m", ".1m", "[1m]", ":1m"} {
			if strings.HasSuffix(trimmed, suffix) {
				trimmed = strings.TrimSuffix(trimmed, suffix)
				break
			}
		}
		if trimmed == model {
			return strings.TrimSpace(trimmed)
		}
		model = trimmed
	}
}

func checkpointBaseModelID(model string) string {
	dash := strings.LastIndexByte(model, '-')
	if dash < 0 || len(model)-dash-1 < 4 || len(model)-dash-1 > 8 {
		return model
	}
	for _, char := range model[dash+1:] {
		if char < '0' || char > '9' {
			return model
		}
	}
	return model[:dash]
}

func matchingProvider(providers map[string]map[string]tokenPrices, hint string) string {
	hint = strings.ToLower(hint)
	if hint == "" {
		return ""
	}
	best := ""
	for provider := range providers {
		if strings.Contains(hint, provider) && len(provider) > len(best) {
			best = provider
		}
	}
	return best
}

func customModelPrice(prices map[string]store.ProfileModelPrice, model string) (tokenPrices, bool) {
	if len(prices) == 0 {
		return tokenPrices{}, false
	}
	model = strings.TrimSpace(model)
	keys := make([]string, 0, len(prices))
	for key := range prices {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if price, ok := prices[model]; ok {
		return profilePriceToTokens(price), true
	}
	for _, key := range keys {
		if modelKey(key) == modelKey(model) {
			return profilePriceToTokens(prices[key]), true
		}
	}
	normalized := normalizeModelID(model)
	for _, key := range keys {
		if normalizeModelID(key) == normalized {
			return profilePriceToTokens(prices[key]), true
		}
	}
	return tokenPrices{}, false
}

func profilePriceToTokens(price store.ProfileModelPrice) tokenPrices {
	input := price.InputPerMillion
	cacheRead := price.CacheReadPerMillion
	cacheWrite := price.CacheWritePerMillion
	output := price.OutputPerMillion
	return tokenPrices{
		input: &input, cacheRead: &cacheRead, cacheWrite: &cacheWrite, output: &output,
	}
}

type usageTokens struct {
	// input is the whole prompt. cacheRead and cacheWrite are subsets of it,
	// never additional tokens.
	input      int64
	cacheRead  int64
	cacheWrite int64
	output     int64
}

func (u usageTokens) empty() bool {
	return u.input == 0 && u.cacheRead == 0 && u.cacheWrite == 0 && u.output == 0
}

func costForTokens(price tokenPrices, tokens usageTokens) (float64, bool) {
	if tokens.empty() {
		return 0, false
	}
	uncached := tokens.input - tokens.cacheRead - tokens.cacheWrite
	if uncached < 0 {
		uncached = 0
	}
	cacheReadPrice := price.cacheRead
	if cacheReadPrice == nil {
		cacheReadPrice = price.input
	}
	cacheWritePrice := price.cacheWrite
	if cacheWritePrice == nil {
		cacheWritePrice = price.input
	}
	total := 0.0
	for _, line := range []struct {
		tokens int64
		price  *float64
	}{
		{uncached, price.input},
		{tokens.cacheRead, cacheReadPrice},
		{tokens.cacheWrite, cacheWritePrice},
		{tokens.output, price.output},
	} {
		if line.tokens == 0 {
			continue
		}
		if line.price == nil {
			return 0, false
		}
		total += float64(line.tokens) * *line.price / 1_000_000
	}
	return total, true
}
