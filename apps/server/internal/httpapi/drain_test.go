package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A restart must empty the server within about a second while an event
// stream is open, and its caller must be answered, not cut off (DEV-100).
func TestShutdownDrainsAnOpenStream(t *testing.T) {
	db, _ := lineageFixture(t)
	ctx := context.Background()
	api := NewServer(db)
	httpServer := httptest.NewServer(api.Routes())
	defer httpServer.Close()

	// The browser's event stream.
	streamContext, cancelStream := context.WithCancel(ctx)
	defer cancelStream()
	streamRequest, _ := http.NewRequestWithContext(streamContext, http.MethodGet, httpServer.URL+"/api/events", nil)
	streamResponse, err := http.DefaultClient.Do(streamRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer streamResponse.Body.Close()
	streamEnded := make(chan error, 1)
	go func() {
		_, err := io.Copy(io.Discard, streamResponse.Body)
		streamEnded <- err
	}()
	waitForOpenRequests(t, api, 1)

	// What stop() does: Shutdown (the protocols), then http.Server.Shutdown.
	started := time.Now()
	budget, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := api.Shutdown(budget); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if err := httpServer.Config.Shutdown(budget); err != nil {
		t.Fatalf("http.Server.Shutdown: %v after %s, open: %v", err, time.Since(started), api.OpenRequests())
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("draining took %s, want about a second at most", elapsed)
	}
	if err := <-streamEnded; err != nil {
		t.Fatalf("event stream ended with %v, want a clean end the browser reconnects from", err)
	}
	if open := api.OpenRequests(); len(open) != 0 {
		t.Fatalf("requests still open after draining: %v", open)
	}
}

func TestOpenRequestsNameWhatIsStillRunning(t *testing.T) {
	api := &Server{}
	release := make(chan struct{})
	entered := make(chan struct{})
	handler := api.drain.track(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
	}))
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/slow?secret=1", nil))
	}()
	<-entered
	open := api.OpenRequests()
	if len(open) != 1 || !strings.HasPrefix(open[0], "GET /api/slow open for ") || strings.Contains(open[0], "secret") {
		t.Fatalf("open requests = %q, want the method and path, not the query", open)
	}
	close(release)
	<-finished
	if open := api.OpenRequests(); len(open) != 0 {
		t.Fatalf("a finished request is still listed as open: %q", open)
	}
}

func waitForOpenRequests(t *testing.T, api *Server, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if len(api.OpenRequests()) >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("open requests = %v, want %d", api.OpenRequests(), want)
}
