package main

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// countingStore satisfies store.Store and store.AccountStore through embedded
// nil interfaces and records Close calls. Only Close and the startup account
// count are exercised by lifecycle tests.
type countingStore struct {
	store.Store
	store.AccountStore

	mu     sync.Mutex
	closes int
}

func (s *countingStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closes++
	return nil
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

func newTestDependencies(backing store.Store, listener net.Listener) (dependencies, *[]string) {
	logs := make([]string, 0, 1)
	deps := dependencies{
		getenv: func(string) string { return "" },
		listen: func(context.Context, string) (net.Listener, error) { return listener, nil },
		logf:   func(format string, args ...any) { logs = append(logs, format) },
		openStore: func(config) (store.Store, error) {
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
	backing := &countingStore{}
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
	backing := &countingStore{}
	deps, _ := newTestDependencies(backing, newPausedListener())

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := waitForRun(t, runAsync(t, ctx, deps)); err != nil {
		t.Fatalf("run() error = %v, want nil", err)
	}
	if got := backing.closeCount(); got != 1 {
		t.Fatalf("store closed %d times, want exactly 1", got)
	}
}

func TestRunRefusesRetiredSettings(t *testing.T) {
	opened := false
	deps := dependencies{
		getenv: func(key string) string {
			if key == "FOUNDRY_PAIRING_CODE" {
				return "shared-secret"
			}
			return ""
		},
		listen: func(context.Context, string) (net.Listener, error) {
			t.Fatal("listen should not run when a retired setting is present")
			return nil, nil
		},
		logf: func(string, ...any) {},
		openStore: func(config) (store.Store, error) {
			opened = true
			return nil, nil
		},
	}

	err := run(context.Background(), deps)
	if err == nil {
		t.Fatal("run() error = nil, want a retired-setting failure")
	}
	if opened {
		t.Fatal("store was opened despite a retired setting")
	}
}

func TestRunClosesStoreWhenListenFails(t *testing.T) {
	backing := &countingStore{}
	listenErr := errors.New("listen refused")
	deps, _ := newTestDependencies(backing, nil)
	deps.listen = func(context.Context, string) (net.Listener, error) { return nil, listenErr }

	err := run(context.Background(), deps)
	if !errors.Is(err, listenErr) {
		t.Fatalf("run() error = %v, want %v", err, listenErr)
	}
	if got := backing.closeCount(); got != 1 {
		t.Fatalf("store closed %d times, want exactly 1", got)
	}
}

func TestRunPropagatesStoreOpenFailure(t *testing.T) {
	openErr := errors.New("cannot open sqlite")
	deps, _ := newTestDependencies(nil, newPausedListener())
	deps.openStore = func(config) (store.Store, error) { return nil, openErr }

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
