package httpapi

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// fakeCatalogEndpoint stands in for a device asking an endpoint's /models:
// it counts reads, and each read waits for release when gated.
type fakeCatalogEndpoint struct {
	reads   atomic.Int32
	gate    chan struct{}
	fail    atomic.Bool
	answers atomic.Int32
}

func (f *fakeCatalogEndpoint) read(ctx context.Context, _ store.CreateAgentProfileInput) ([]store.AgentModelOption, error) {
	f.reads.Add(1)
	if f.gate != nil {
		select {
		case <-f.gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if f.fail.Load() {
		return nil, errors.New("endpoint answered 502")
	}
	n := f.answers.Add(1)
	return []store.AgentModelOption{{ID: "model-" + string(rune('0'+n))}}, nil
}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func catalogProfile() store.CreateAgentProfileInput {
	return store.CreateAgentProfileInput{
		ID: "p_gateway", DeviceID: "dev_a", Runtime: "claude",
		ConfigScope: "device", ConnectionType: "anthropic_compatible",
		BaseURL: "https://gateway.example/v1", Label: "Gateway",
	}
}

func waitForReads(t *testing.T, endpoint *fakeCatalogEndpoint, want int32) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for endpoint.reads.Load() < want {
		if time.Now().After(deadline) {
			t.Fatalf("reads = %d, want %d", endpoint.reads.Load(), want)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestModelCatalogConcurrentReadersShareOneRead(t *testing.T) {
	endpoint := &fakeCatalogEndpoint{gate: make(chan struct{})}
	var cache modelCatalogCache
	var wg sync.WaitGroup
	results := make([][]store.AgentModelOption, 8)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], _ = cache.list(context.Background(), catalogProfile(), false, endpoint.read)
		}()
	}
	waitForReads(t, endpoint, 1)
	time.Sleep(20 * time.Millisecond)
	close(endpoint.gate)
	wg.Wait()
	if got := endpoint.reads.Load(); got != 1 {
		t.Fatalf("reads = %d, want 1", got)
	}
	for _, models := range results {
		if len(models) != 1 || models[0].ID != "model-1" {
			t.Fatalf("reader got %v", models)
		}
	}
}

func TestModelCatalogFreshStaleRefreshAndForget(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1_800_000_000, 0)}
	endpoint := &fakeCatalogEndpoint{}
	cache := modelCatalogCache{now: clock.Now}
	ctx := context.Background()
	list := func(profile store.CreateAgentProfileInput, refresh bool) string {
		t.Helper()
		models, err := cache.list(ctx, profile, refresh, endpoint.read)
		if err != nil || len(models) != 1 {
			t.Fatalf("list = %v, %v", models, err)
		}
		return models[0].ID
	}

	if got := list(catalogProfile(), false); got != "model-1" {
		t.Fatalf("first read = %s", got)
	}
	// Another page asking about the same profile, with its own run settings
	// and workspace, is answered from the copy.
	other := catalogProfile()
	other.WorkspaceID, other.PromptPrefix, other.ClaudeEffort = "ws_b", "be brief", "high"
	if got := list(other, false); got != "model-1" || endpoint.reads.Load() != 1 {
		t.Fatalf("fresh copy = %s after %d reads", got, endpoint.reads.Load())
	}

	// Past the fresh window the old copy answers at once and a background
	// read replaces it.
	clock.advance(modelCatalogFresh + time.Second)
	if got := list(catalogProfile(), false); got != "model-1" {
		t.Fatalf("stale answer = %s", got)
	}
	waitForReads(t, endpoint, 2)
	deadline := time.Now().Add(2 * time.Second)
	for list(catalogProfile(), false) != "model-2" {
		if time.Now().After(deadline) {
			t.Fatal("background read never replaced the stale copy")
		}
		time.Sleep(time.Millisecond)
	}
	if got := endpoint.reads.Load(); got != 2 {
		t.Fatalf("reads after background refresh = %d, want 2", got)
	}

	// An explicit refresh asks again and keeps the answer.
	if got := list(catalogProfile(), true); got != "model-3" {
		t.Fatalf("refresh = %s", got)
	}
	if got := list(catalogProfile(), false); got != "model-3" {
		t.Fatalf("after refresh = %s", got)
	}

	// A changed endpoint or credential is a different catalog.
	moved := catalogProfile()
	moved.BaseURL = "https://other.example/v1"
	if got := list(moved, false); got != "model-4" {
		t.Fatalf("new endpoint = %s", got)
	}
	keyed := catalogProfile()
	keyed.APIKey = "sk-rotated"
	if got := list(keyed, false); got != "model-5" {
		t.Fatalf("new credential = %s", got)
	}

	// Saving the profile forgets every copy of it.
	cache.forgetProfile("dev_a", "p_gateway")
	if got := list(catalogProfile(), false); got != "model-6" {
		t.Fatalf("after save = %s", got)
	}

	// A copy older than the kept window is not answered from.
	clock.advance(modelCatalogKept + time.Second)
	if got := list(catalogProfile(), false); got != "model-7" {
		t.Fatalf("expired copy answered: %s", got)
	}
}

func TestModelCatalogFailuresAreNotKept(t *testing.T) {
	endpoint := &fakeCatalogEndpoint{}
	var cache modelCatalogCache
	endpoint.fail.Store(true)
	if _, err := cache.list(context.Background(), catalogProfile(), false, endpoint.read); err == nil {
		t.Fatal("a failed read answered")
	}
	endpoint.fail.Store(false)
	models, err := cache.list(context.Background(), catalogProfile(), false, endpoint.read)
	if err != nil || len(models) != 1 || endpoint.reads.Load() != 2 {
		t.Fatalf("retry = %v, %v after %d reads", models, err, endpoint.reads.Load())
	}
	// A failed refresh leaves the last good copy in place.
	endpoint.fail.Store(true)
	if _, err := cache.list(context.Background(), catalogProfile(), true, endpoint.read); err == nil {
		t.Fatal("a failed refresh answered")
	}
	kept, err := cache.list(context.Background(), catalogProfile(), false, endpoint.read)
	if err != nil || len(kept) != 1 || kept[0].ID != models[0].ID {
		t.Fatalf("kept = %v, %v", kept, err)
	}
}

func TestModelCatalogWaiterLeavingKeepsTheReadForOthers(t *testing.T) {
	endpoint := &fakeCatalogEndpoint{gate: make(chan struct{})}
	var cache modelCatalogCache
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := cache.list(ctx, catalogProfile(), false, endpoint.read)
		done <- err
	}()
	waitForReads(t, endpoint, 1)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("closed tab err = %v", err)
	}
	close(endpoint.gate)
	models, err := cache.list(context.Background(), catalogProfile(), false, endpoint.read)
	if err != nil || len(models) != 1 || endpoint.reads.Load() != 1 {
		t.Fatalf("next reader = %v, %v after %d reads", models, err, endpoint.reads.Load())
	}
}

// TestModelCatalogMeasuredAgainstDirectReads replays a page-load burst (the
// dev log shows bursts of 4-9 catalog requests within seconds, the same
// profile several times) against a slow fake endpoint, with and without the
// cache, and reports device reads and wall time.
func TestModelCatalogMeasuredAgainstDirectReads(t *testing.T) {
	const latency = 40 * time.Millisecond
	slow := func(endpoint *fakeCatalogEndpoint) modelCatalogReader {
		return func(ctx context.Context, profile store.CreateAgentProfileInput) ([]store.AgentModelOption, error) {
			time.Sleep(latency)
			return endpoint.read(ctx, profile)
		}
	}
	profiles := []string{"p_a", "p_a", "p_b", "p_b", "p_a", "p_c", "p_a", "p_b"}
	run := func(read func(store.CreateAgentProfileInput) error) (time.Duration, time.Duration) {
		start := time.Now()
		var worst time.Duration
		var mu sync.Mutex
		// Five page loads; each fires its burst concurrently.
		for range 5 {
			var wg sync.WaitGroup
			for _, id := range profiles {
				wg.Add(1)
				go func() {
					defer wg.Done()
					began := time.Now()
					profile := catalogProfile()
					profile.ID = id
					if err := read(profile); err != nil {
						t.Error(err)
					}
					mu.Lock()
					worst = max(worst, time.Since(began))
					mu.Unlock()
				}()
			}
			wg.Wait()
		}
		return time.Since(start), worst
	}

	direct := &fakeCatalogEndpoint{}
	directRead := slow(direct)
	directTotal, _ := run(func(profile store.CreateAgentProfileInput) error {
		_, err := directRead(context.Background(), profile)
		return err
	})

	cached := &fakeCatalogEndpoint{}
	cachedRead := slow(cached)
	var cache modelCatalogCache
	cachedTotal, _ := run(func(profile store.CreateAgentProfileInput) error {
		_, err := cache.list(context.Background(), profile, false, cachedRead)
		return err
	})

	t.Logf("direct: %d device reads, %v; cached: %d device reads, %v",
		direct.reads.Load(), directTotal, cached.reads.Load(), cachedTotal)
	if direct.reads.Load() != 40 || cached.reads.Load() != 3 {
		t.Fatalf("reads direct=%d cached=%d, want 40 and 3", direct.reads.Load(), cached.reads.Load())
	}
}
