package httpapi

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestProjectionCacheCoalescesAndInvalidates(t *testing.T) {
	var cache projectionCache
	var version atomic.Uint64
	var builds atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	build := func() ([]byte, bool, error) {
		if builds.Add(1) == 1 {
			close(started)
			<-release
		}
		return []byte("snapshot"), true, nil
	}
	var group sync.WaitGroup
	for i := 0; i < 8; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			body, err := cache.load(context.Background(), "workspace", version.Load, build)
			if err != nil || string(body) != "snapshot" {
				t.Errorf("bad projection: %s, %v", body, err)
			}
		}()
	}
	<-started
	close(release)
	group.Wait()
	if builds.Load() != 1 {
		t.Fatalf("built %d duplicate snapshots", builds.Load())
	}
	version.Add(1)
	_, _ = cache.load(context.Background(), "workspace", version.Load, build)
	if builds.Load() != 2 {
		t.Fatal("event did not invalidate snapshot")
	}
	cache.mu.Lock()
	cache.entries["workspace"].expires = time.Now().Add(-time.Second)
	cache.mu.Unlock()
	_, _ = cache.load(context.Background(), "workspace", version.Load, build)
	if builds.Load() != 3 {
		t.Fatal("expired snapshot reused")
	}
	_, _ = cache.load(context.Background(), "other", version.Load, build)
	if builds.Load() != 4 {
		t.Fatal("workspace snapshots mixed")
	}
}

func TestProjectionCacheCanceledWaiterDoesNotCancelSharedBuild(t *testing.T) {
	var cache projectionCache
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	revision := func() uint64 { return 1 }
	build := func() ([]byte, bool, error) { close(started); <-release; return []byte("ok"), true, nil }
	go func() { defer close(done); _, _ = cache.load(context.Background(), "workspace", revision, build) }()
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cache.load(ctx, "workspace", revision, build); err != context.Canceled {
		t.Fatalf("expected canceled waiter, got %v", err)
	}
	close(release)
	<-done
	body, err := cache.load(context.Background(), "workspace", revision, build)
	if err != nil || string(body) != "ok" {
		t.Fatalf("shared result lost: %s %v", body, err)
	}
}
