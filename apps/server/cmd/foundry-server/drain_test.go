package main

import (
	"bytes"
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// A request that waits on the server's drain signal ends with an answer, the
// stop returns without an error (exit status 0) and takes well under the
// budget (DEV-100).
func TestStopDrainsLongRequestsWithoutAnError(t *testing.T) {
	draining := make(chan struct{})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-draining
		_, _ = io.WriteString(w, "retry")
	})}
	running := startServing(server, listener)

	answered := make(chan string, 1)
	go func() {
		response, err := http.Get("http://" + listener.Addr().String())
		if err != nil {
			answered <- "error: " + err.Error()
			return
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		answered <- string(body)
	}()
	<-entered

	started := time.Now()
	if err := running.stop(15*time.Second, func(context.Context) error {
		close(draining)
		return nil
	}); err != nil {
		t.Fatalf("stop() = %v, want nil: a clean drain exits 0", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("stop() took %s, want about a second at most", elapsed)
	}
	if got := <-answered; got != "retry" {
		t.Fatalf("the long request got %q, want its answer", got)
	}
}

// When a request outlasts the budget anyway, the log names it, so the next
// slow handoff explains itself.
func TestStopNamesTheRequestsThatOutlastedTheBudget(t *testing.T) {
	var logged bytes.Buffer
	log.SetOutput(&logged)
	defer log.SetOutput(log.Writer())

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
	})}
	running := startServing(server, listener)
	running.openRequests = func() []string { return []string{"POST /api/mcp open for 3s"} }
	go func() { _, _ = http.Get("http://" + listener.Addr().String()) }()
	<-entered

	if err := running.stop(200*time.Millisecond, nil); err == nil {
		t.Fatal("stop() = nil, want the expired budget reported")
	}
	if !strings.Contains(logged.String(), "1 request(s) still open") || !strings.Contains(logged.String(), "POST /api/mcp open for 3s") {
		t.Fatalf("log = %q, want the open request named", logged.String())
	}
}
