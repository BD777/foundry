package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// trackedConnection returns a socket-less connection registered with the hub,
// plus a goroutine standing in for readLoop's teardown: it waits for the
// connection to be closed and then reports completion the way readLoop does.
// The seam keeps shutdown tests in memory instead of on loopback sockets.
func trackedConnection(t *testing.T, hub *DaemonHub) *daemonConnection {
	t.Helper()
	connection := newDaemonConnection(hub, nil)
	if !hub.track(connection) {
		t.Fatal("track() = false, want true for a hub that is not shutting down")
	}
	go func() {
		<-connection.done
		hub.untrack(connection)
		close(connection.finished)
	}()
	return connection
}

func TestServerShutdownIsIdempotent(t *testing.T) {
	server := NewServer(newTestStore(t))

	for attempt := range 3 {
		if err := server.Shutdown(context.Background()); err != nil {
			t.Fatalf("Shutdown() attempt %d error = %v, want nil", attempt, err)
		}
	}
}

func TestServerShutdownReleasesSSEHandlerAndRejectsNewOnes(t *testing.T) {
	server := NewServer(newTestStore(t))

	request := httptest.NewRequest(http.MethodGet, "/api/events", nil)
	streamed := make(chan struct{})
	go func() {
		defer close(streamed)
		server.events.ServeHTTP(httptest.NewRecorder(), request)
	}()

	// Wait until the handler is actually subscribed, so shutdown is what
	// releases it rather than a race against registration.
	deadline := time.After(2 * time.Second)
	for {
		server.events.mu.RLock()
		subscribed := len(server.events.subscribers)
		server.events.mu.RUnlock()
		if subscribed == 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("SSE handler never subscribed")
		case <-time.After(time.Millisecond):
		}
	}

	if err := server.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown() error = %v, want nil", err)
	}

	select {
	case <-streamed:
	case <-time.After(2 * time.Second):
		t.Fatal("SSE handler did not exit after Shutdown()")
	}

	rejected := httptest.NewRecorder()
	server.events.ServeHTTP(rejected, request)
	if rejected.Code != http.StatusServiceUnavailable {
		t.Fatalf("post-shutdown SSE status = %d, want %d", rejected.Code, http.StatusServiceUnavailable)
	}
}

func TestDaemonHubShutdownRejectsNewUpgrades(t *testing.T) {
	hub := NewDaemonHub(newTestStore(t), newBrowserEventHub(), "")
	if err := hub.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown() error = %v, want nil", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/daemon/ws", nil)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Version", "13")
	request.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	response := httptest.NewRecorder()
	hub.ServeHTTP(response, request)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("post-shutdown upgrade status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
	if connection := newDaemonConnection(hub, nil); hub.track(connection) {
		t.Fatal("track() = true after Shutdown(), want false")
	}
}

func TestDaemonHubShutdownClosesActiveConnections(t *testing.T) {
	hub := NewDaemonHub(newTestStore(t), newBrowserEventHub(), "")
	first := trackedConnection(t, hub)
	second := trackedConnection(t, hub)

	if err := hub.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown() error = %v, want nil", err)
	}

	for name, connection := range map[string]*daemonConnection{"first": first, "second": second} {
		select {
		case <-connection.done:
		default:
			t.Fatalf("%s connection still open after Shutdown()", name)
		}
	}
	hub.mu.Lock()
	remaining := len(hub.live)
	hub.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("live connections after Shutdown() = %d, want 0", remaining)
	}

	// Repeat shutdown must stay a no-op even with connections already torn down.
	if err := hub.Shutdown(context.Background()); err != nil {
		t.Fatalf("second Shutdown() error = %v, want nil", err)
	}
}

func TestDaemonHubShutdownFailsPendingCallers(t *testing.T) {
	hub := NewDaemonHub(newTestStore(t), newBrowserEventHub(), "")
	connection := trackedConnection(t, hub)

	failed := make(chan error, 1)
	go func() {
		_, err := connection.readWorkspaceFile(context.Background(), "workspace-1", "README.md")
		failed <- err
	}()

	// Drain the queued request so the caller is parked on its pending channel.
	select {
	case <-connection.send:
	case <-time.After(2 * time.Second):
		t.Fatal("read_file request was never queued")
	}

	if err := hub.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown() error = %v, want nil", err)
	}

	select {
	case err := <-failed:
		if err == nil || err.Error() != daemonDisconnectedReason {
			t.Fatalf("pending caller error = %v, want %q", err, daemonDisconnectedReason)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("pending caller was not released by Shutdown()")
	}

	// A caller that registers after teardown must fail the same way instead
	// of blocking until its own context expires.
	if _, err := connection.readWorkspaceFile(context.Background(), "workspace-1", "README.md"); err == nil ||
		err.Error() != daemonDisconnectedReason {
		t.Fatalf("post-shutdown caller error = %v, want %q", err, daemonDisconnectedReason)
	}
}

func TestDaemonHubShutdownHonorsContext(t *testing.T) {
	hub := NewDaemonHub(newTestStore(t), newBrowserEventHub(), "")
	// Tracked without the readLoop stand-in, so it never reports completion.
	stuck := newDaemonConnection(hub, nil)
	if !hub.track(stuck) {
		t.Fatal("track() = false, want true")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := hub.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Shutdown() error = %v, want %v", err, context.DeadlineExceeded)
	}
	// The connection is still closed even though the wait timed out.
	select {
	case <-stuck.done:
	default:
		t.Fatal("stuck connection was not closed before the wait timed out")
	}
}
