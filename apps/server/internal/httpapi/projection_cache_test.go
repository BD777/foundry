package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
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

// Requests that arrive while a snapshot is built share it even when it may
// not be cached; one that arrives after it was built builds again.
func TestProjectionCacheSharesAnUncacheableBuild(t *testing.T) {
	var cache projectionCache
	revision := func() uint64 { return 1 }
	var builds atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	build := func() ([]byte, bool, error) {
		if builds.Add(1) == 1 {
			close(started)
			<-release
		}
		return []byte("fresh"), false, nil
	}
	var group sync.WaitGroup
	for i := 0; i < 4; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			body, err := cache.load(context.Background(), "workspace", revision, build)
			if err != nil || string(body) != "fresh" {
				t.Errorf("bad projection: %s, %v", body, err)
			}
		}()
	}
	<-started
	// Let the other readers join the build before it finishes.
	time.Sleep(50 * time.Millisecond)
	close(release)
	group.Wait()
	if builds.Load() != 1 {
		t.Fatalf("4 concurrent readers ran %d builds, want 1", builds.Load())
	}
	if _, err := cache.load(context.Background(), "workspace", revision, build); err != nil || builds.Load() != 2 {
		t.Fatalf("an uncacheable snapshot was served later (%d builds, %v)", builds.Load(), err)
	}
}

// A shared build that failed (its request may have gone away) is not the
// answer of the requests that waited for it: they build again.
func TestProjectionCacheWaitersRebuildAfterAFailedBuild(t *testing.T) {
	var cache projectionCache
	revision := func() uint64 { return 1 }
	var builds atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	build := func() ([]byte, bool, error) {
		if builds.Add(1) == 1 {
			close(started)
			<-release
			return nil, false, context.Canceled
		}
		return []byte("ok"), true, nil
	}
	first := make(chan error, 1)
	go func() {
		_, err := cache.load(context.Background(), "workspace", revision, build)
		first <- err
	}()
	<-started
	waiter := make(chan []byte, 1)
	go func() {
		body, _ := cache.load(context.Background(), "workspace", revision, build)
		waiter <- body
	}()
	time.Sleep(50 * time.Millisecond)
	close(release)
	if err := <-first; err != context.Canceled {
		t.Fatalf("builder err = %v", err)
	}
	if body := <-waiter; string(body) != "ok" {
		t.Fatalf("waiter got %q, want its own build", body)
	}
}

// A workspace with a running session is served from the snapshot cache
// until an event bumps the revision.
func TestFoundryDataIsCachedWhileASessionRuns(t *testing.T) {
	db := newTestStore(t)
	ctx := context.Background()
	if err := db.RegisterDaemon(ctx, store.DaemonRegistration{
		Device:    store.DeviceProjection{ID: "dev_running", Label: "Device", Status: "connected", LastSeenLabel: "online"},
		Workspace: store.WorkspaceProjection{ID: "ws_running", Name: "Running", LocalPath: t.TempDir()},
		Agents: []store.AgentProjection{{ID: "agent_running", WorkspaceID: "ws_running", DeviceID: "dev_running", Provider: "codex", Status: "healthy",
			AuthMode: "local_config", SecretStored: "local", ConfigScope: "workspace", ConfigLabel: "local", LastSeenLabel: "online"}},
	}); err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateAgentSession(ctx, store.CreateAgentSessionInput{WorkspaceID: "ws_running", AgentID: "agent_running", Provider: "codex", Prompt: "run"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.StartAgentSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db)
	server.options.AgentSessionStaleAfter = time.Hour
	first := requestForTest(t, server, http.MethodGet, "/api/foundry-data?workspaceId=ws_running", "", http.StatusOK)
	if !strings.Contains(first.Body.String(), `"status":"running"`) {
		t.Fatalf("projection lacks the running session: %s", first.Body.String())
	}
	cached := func() bool {
		server.projections.mu.Lock()
		defer server.projections.mu.Unlock()
		for _, entry := range server.projections.entries {
			if time.Now().Before(entry.expires) {
				return true
			}
		}
		return false
	}
	if !cached() {
		t.Fatal("a projection with a running session was not cached")
	}
	before := server.events.revision.Load()
	server.events.Publish("agent_session_completed", store.AgentSession{ID: session.ID, WorkspaceID: "ws_running", Status: "completed"})
	if server.events.revision.Load() == before {
		t.Fatal("a session transition did not invalidate the snapshot")
	}
}

func TestIfNoneMatchUsesWeakComparison(t *testing.T) {
	const etag = `"abc123"`
	for _, test := range []struct {
		header []string
		want   bool
	}{
		{[]string{`"abc123"`}, true},
		{[]string{`W/"abc123"`}, true},
		{[]string{`"other", W/"abc123"`}, true},
		{[]string{`"other"`, ` W/"abc123" `}, true},
		{[]string{`*`}, true},
		{[]string{`"other"`}, false},
		{[]string{`W/"abc12"`}, false},
		{[]string{`abc123`}, false},
		{nil, false},
	} {
		if got := ifNoneMatch(test.header, etag); got != test.want {
			t.Errorf("ifNoneMatch(%q) = %v, want %v", test.header, got, test.want)
		}
	}
}

// Behind nginx, which compresses JSON and weakens the ETag, foundry-data
// still answers a revalidation with 304.
func TestFoundryDataRevalidatesAWeakenedETag(t *testing.T) {
	server := NewServer(newTestStore(t))
	first := requestForTest(t, server, http.MethodGet, "/api/foundry-data", "", http.StatusOK)
	etag := first.Header().Get("ETag")
	if etag == "" || strings.HasPrefix(etag, "W/") {
		t.Fatalf("etag = %q", etag)
	}
	for _, header := range []string{"W/" + etag, `"stale", W/` + etag} {
		request := httptest.NewRequest(http.MethodGet, "/api/foundry-data", nil)
		request.Header.Set("If-None-Match", header)
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, request)
		if response.Code != http.StatusNotModified {
			t.Fatalf("If-None-Match %s = %d, want 304", header, response.Code)
		}
	}
}
