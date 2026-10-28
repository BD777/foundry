package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

const handoffTestChildEnv = "FOUNDRY_HANDOFF_TEST_CHILD"

// TestHandoffHelperChild is the child process of the handoff tests: a server
// on the inherited socket that answers with its pid, as a supervised
// foundry-server would.
func TestHandoffHelperChild(t *testing.T) {
	if os.Getenv(handoffTestChildEnv) != "1" {
		t.Skip("run by the handoff tests")
	}
	handoff, err := inheritedHandoff(os.Getenv)
	if err != nil || handoff == nil {
		fmt.Fprintln(os.Stderr, "no inherited handoff:", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()
	server := &http.Server{ConnState: func(c net.Conn, st http.ConnState) {
		if os.Getenv("DEBUG_HANDOFF") != "" {
			fmt.Fprintf(os.Stderr, "%d %s %s %s\n", os.Getpid(), time.Now().Format("15:04:05.000000"), c.RemoteAddr(), st)
		}
	}, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A slow request still in flight when the successor takes over.
		time.Sleep(20 * time.Millisecond)
		fmt.Fprint(w, os.Getpid())
	})}
	running := startServing(server, handoff.listener)
	handoff.reportReady()
	if err := handoff.waitForPrevious(ctx); err == nil {
		<-ctx.Done()
	}
	_ = running.stop(5*time.Second, nil)
	os.Exit(0)
}

func TestSupervisorReplacesTheServerWithoutRefusingARequest(t *testing.T) {
	t.Setenv(handoffTestChildEnv, "1")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	socket, err := listener.(*net.TCPListener).File()
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	_ = listener.Close()
	defer socket.Close()

	s := &supervisor{
		executable: os.Args[0],
		args:       []string{"-test.run=^TestHandoffHelperChild$"},
		socket:     socket,
		logf:       t.Logf,
	}
	current, err := s.start()
	if err != nil {
		t.Fatal(err)
	}
	current.previousGone()
	defer func() { _ = current.stop() }()
	select {
	case <-current.ready:
	case <-time.After(10 * time.Second):
		t.Fatal("first server was not ready")
	}

	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 10 * time.Second}
	var failures, answered atomic.Int64
	var mu sync.Mutex
	pids := map[int]bool{}
	stopLoad := make(chan struct{})
	var load sync.WaitGroup
	for range 4 {
		load.Add(1)
		go func() {
			defer load.Done()
			for {
				select {
				case <-stopLoad:
					return
				default:
				}
				response, err := client.Get("http://" + addr + "/")
				if err != nil {
					failures.Add(1)
					t.Logf("%s request failed: %v", time.Now().Format("15:04:05.000000"), err)
					continue
				}
				body, _ := io.ReadAll(response.Body)
				_ = response.Body.Close()
				pid, _ := strconv.Atoi(string(body))
				if response.StatusCode != http.StatusOK || pid == 0 {
					failures.Add(1)
					continue
				}
				answered.Add(1)
				mu.Lock()
				pids[pid] = true
				mu.Unlock()
			}
		}()
	}

	for round := range 2 {
		previous := current.process.Pid
		next, err := s.replace(current)
		if err != nil {
			t.Fatalf("handoff %d: %v", round, err)
		}
		if next.process.Pid == previous {
			t.Fatalf("handoff %d kept pid %d", round, previous)
		}
		current = next
		time.Sleep(200 * time.Millisecond)
	}
	close(stopLoad)
	load.Wait()

	if failures.Load() != 0 {
		t.Fatalf("%d of %d requests failed across the handoffs", failures.Load(), failures.Load()+answered.Load())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(pids) != 3 {
		t.Fatalf("requests were answered by %d servers, want all 3", len(pids))
	}
}

func TestSupervisorKeepsTheServerWhenItsSuccessorFails(t *testing.T) {
	t.Setenv(handoffTestChildEnv, "1")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	socket, err := listener.(*net.TCPListener).File()
	if err != nil {
		t.Fatal(err)
	}
	_ = listener.Close()
	defer socket.Close()

	s := &supervisor{executable: os.Args[0], args: []string{"-test.run=^TestHandoffHelperChild$"}, socket: socket, logf: t.Logf}
	current, err := s.start()
	if err != nil {
		t.Fatal(err)
	}
	current.previousGone()
	defer func() { _ = current.stop() }()
	<-current.ready

	// The successor cannot start: the helper refuses to run without the env.
	t.Setenv(handoffTestChildEnv, "0")
	kept, err := s.replace(current)
	if err == nil || kept != current {
		t.Fatalf("replace = %v, %v; want the running server kept with an error", kept, err)
	}
	select {
	case err := <-current.exited:
		t.Fatalf("running server exited: %v", err)
	default:
	}
}
