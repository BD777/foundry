package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
)

// countingStore is a fresh SQLite store that records Close calls.
type countingStore struct {
	*sqlitestore.Store

	mu     sync.Mutex
	closes int
}

func newCountingStore(t *testing.T) *countingStore {
	t.Helper()
	backing, err := sqlitestore.Open(filepath.Join(t.TempDir(), "foundry.db"))
	if err != nil {
		t.Fatal(err)
	}
	return &countingStore{Store: backing}
}

func (s *countingStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closes++
	return s.Store.Close()
}

// CountUsers reports an existing account so startup logs no setup code.
func (s *countingStore) CountUsers(context.Context) (int, error) { return 1, nil }

func (s *countingStore) closeCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closes
}

// pausedListener accepts nothing and unblocks on Close, so lifecycle tests
// never bind a real socket.
type pausedListener struct {
	closed chan struct{}
	once   sync.Once
}

func newPausedListener() *pausedListener {
	return &pausedListener{closed: make(chan struct{})}
}

func (l *pausedListener) Accept() (net.Conn, error) {
	<-l.closed
	return nil, net.ErrClosed
}

func (l *pausedListener) Close() error {
	l.once.Do(func() { close(l.closed) })
	return nil
}

func (l *pausedListener) Addr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 31982}
}

func newTestDependencies(backing serverStore, listener net.Listener) (dependencies, *[]string) {
	logs := make([]string, 0, 1)
	deps := dependencies{
		getenv: func(string) string { return "" },
		listen: func(context.Context, string) (net.Listener, error) { return listener, nil },
		logf:   func(format string, args ...any) { logs = append(logs, format) },
		openStore: func(config) (serverStore, error) {
			return backing, nil
		},
	}
	return deps, &logs
}

func runAsync(t *testing.T, ctx context.Context, deps dependencies) <-chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- run(ctx, deps) }()
	return done
}

func waitForRun(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("run did not return after context cancellation")
		return nil
	}
}

func TestRunShutsDownCleanlyOnContextCancel(t *testing.T) {
	backing := newCountingStore(t)
	listener := newPausedListener()
	deps, logs := newTestDependencies(backing, listener)

	ctx, cancel := context.WithCancel(context.Background())
	done := runAsync(t, ctx, deps)

	// Give Serve a moment to start before requesting shutdown.
	time.Sleep(20 * time.Millisecond)
	cancel()

	if err := waitForRun(t, done); err != nil {
		t.Fatalf("run() error = %v, want nil on graceful shutdown", err)
	}
	if got := backing.closeCount(); got != 1 {
		t.Fatalf("store closed %d times, want exactly 1", got)
	}
	if len(*logs) != 1 {
		t.Fatalf("logged %d lines, want the single listening line", len(*logs))
	}
	select {
	case <-listener.closed:
	default:
		t.Fatal("listener was not closed during shutdown")
	}
}

func TestRunReturnsWhenContextIsAlreadyCancelled(t *testing.T) {
	backing := newCountingStore(t)
	deps, _ := newTestDependencies(backing, newPausedListener())

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	// The startup chores read the store with ctx, so run stops there.
	if err := waitForRun(t, runAsync(t, ctx, deps)); !errors.Is(err, context.Canceled) {
		t.Fatalf("run() error = %v, want %v", err, context.Canceled)
	}
	if got := backing.closeCount(); got != 1 {
		t.Fatalf("store closed %d times, want exactly 1", got)
	}
}

func TestRunBindsThePortBeforeOpeningTheStore(t *testing.T) {
	listenErr := errors.New("listen refused")
	deps, _ := newTestDependencies(nil, nil)
	deps.listen = func(context.Context, string) (net.Listener, error) { return nil, listenErr }
	deps.openStore = func(config) (serverStore, error) {
		t.Fatal("store opened although the port could not be bound")
		return nil, nil
	}

	if err := run(context.Background(), deps); !errors.Is(err, listenErr) {
		t.Fatalf("run() error = %v, want %v", err, listenErr)
	}
}

func TestRunHoldsRequestsWhileTheStoreOpens(t *testing.T) {
	backing := newCountingStore(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	deps, _ := newTestDependencies(backing, listener)
	opening := make(chan struct{})
	release := make(chan struct{})
	deps.openStore = func(config) (serverStore, error) {
		close(opening)
		<-release
		return backing, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := runAsync(t, ctx, deps)
	<-opening

	base := "http://" + listener.Addr().String()
	health, err := http.Get(base + "/healthz")
	if err != nil {
		t.Fatalf("health check while starting: %v", err)
	}
	_ = health.Body.Close()
	if health.StatusCode != http.StatusServiceUnavailable || health.Header.Get("Retry-After") == "" || health.Header.Get(serverStartingHeader) == "" {
		t.Fatalf("health while starting = %d (Retry-After %q), want 503 with Retry-After", health.StatusCode, health.Header.Get("Retry-After"))
	}

	answered := make(chan int, 1)
	go func() {
		response, err := http.Get(base + "/api/auth/session")
		if err != nil {
			answered <- 0
			return
		}
		_ = response.Body.Close()
		answered <- response.StatusCode
	}()
	select {
	case status := <-answered:
		t.Fatalf("a request was answered %d before the server was ready", status)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	select {
	case status := <-answered:
		if status == 0 || status == http.StatusServiceUnavailable || status == http.StatusBadGateway {
			t.Fatalf("held request answered %d, want the API's answer", status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("held request was not answered once the server was ready")
	}
	ready, err := http.Get(base + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	_ = ready.Body.Close()
	if ready.StatusCode != http.StatusOK {
		t.Fatalf("health once ready = %d, want 200", ready.StatusCode)
	}
	cancel()
	if err := waitForRun(t, done); err != nil {
		t.Fatalf("run() = %v", err)
	}
}

func TestRunPropagatesStoreOpenFailure(t *testing.T) {
	openErr := errors.New("cannot open sqlite")
	deps, _ := newTestDependencies(nil, newPausedListener())
	deps.openStore = func(config) (serverStore, error) { return nil, openErr }

	if err := run(context.Background(), deps); !errors.Is(err, openErr) {
		t.Fatalf("run() error = %v, want %v", err, openErr)
	}
}

func TestServePropagatesListenerFailure(t *testing.T) {
	listener := newPausedListener()
	listener.Close()

	cfg := loadConfig(func(string) string { return "" })
	err := serve(context.Background(), newHTTPServer(cfg, nil), listener, cfg.ShutdownTimeout, nil)
	if !errors.Is(err, net.ErrClosed) {
		t.Fatalf("serve() error = %v, want %v", err, net.ErrClosed)
	}
}

func TestDefaultDependenciesAreWired(t *testing.T) {
	deps := defaultDependencies()
	if deps.getenv == nil || deps.listen == nil || deps.logf == nil || deps.openStore == nil {
		t.Fatal("defaultDependencies() left a seam unset")
	}
}
