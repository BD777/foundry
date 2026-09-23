package httpapi

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

func TestDaemonRPCRequestIDsAreUniqueUnderConcurrency(t *testing.T) {
	rpc := newDaemonRPC()

	const goroutines, perGoroutine = 16, 64
	ids := make(chan string, goroutines*perGoroutine)
	var start, done sync.WaitGroup
	start.Add(1)
	for range goroutines {
		done.Add(1)
		go func() {
			defer done.Done()
			start.Wait()
			for range perGoroutine {
				ids <- rpc.newRequestID(wsReadFileType)
			}
		}()
	}
	start.Done()
	done.Wait()
	close(ids)

	seen := make(map[string]bool, goroutines*perGoroutine)
	for id := range ids {
		if seen[id] {
			t.Fatalf("duplicate request id %q", id)
		}
		seen[id] = true
	}
	if len(seen) != goroutines*perGoroutine {
		t.Fatalf("unique ids = %d, want %d", len(seen), goroutines*perGoroutine)
	}
}

func TestDaemonOutboundBackpressureDoesNotCloseTheConnection(t *testing.T) {
	connection := &daemonConnection{
		done: make(chan struct{}),
		rpc:  newDaemonRPC(),
		send: make(chan wsEnvelope, 1),
	}
	if !connection.queue(wsEnvelope{Type: wsAckType, ID: "first"}) {
		t.Fatal("first queue() = false, want true")
	}
	if connection.queue(wsEnvelope{Type: wsAckType, ID: "overflow"}) {
		t.Fatal("overflow queue() = true, want false")
	}
	select {
	case <-connection.done:
		t.Fatal("outbound backpressure closed a live daemon connection")
	default:
	}
}

func TestActiveSessionClaimBelongsToExactConnectionAndSession(t *testing.T) {
	hub := NewDaemonHub(newTestStore(t), newBrowserEventHub(), "")
	first := &daemonConnection{
		activeSessions: map[string]bool{"session": true},
		done:           make(chan struct{}),
	}
	hub.connections["device"] = first

	if !hub.HasActiveSession("device", "session") {
		t.Fatal("exact active session claim was not recognized")
	}
	if hub.HasActiveSession("device", "other-session") {
		t.Fatal("one active session kept an unrelated session alive")
	}

	// A daemon process restart reuses the stable device ID, but its new
	// process-scoped execution registry is empty.
	hub.connections["device"] = &daemonConnection{
		activeSessions: map[string]bool{},
		done:           make(chan struct{}),
	}
	if hub.HasActiveSession("device", "session") {
		t.Fatal("replacement daemon inherited the previous process claim")
	}
}

func TestDaemonRPCResolveDeliversToRegisteredWaiter(t *testing.T) {
	rpc := newDaemonRPC()
	first := rpc.register("id-1")
	second := rpc.register("id-2")

	if !rpc.resolve("id-2", json.RawMessage(`{"path":"b"}`)) {
		t.Fatal("resolve(id-2) = false, want true")
	}
	select {
	case result := <-second:
		if result.err != nil {
			t.Fatalf("id-2 error = %v, want nil", result.err)
		}
		if string(result.payload) != `{"path":"b"}` {
			t.Fatalf("id-2 payload = %s, want {\"path\":\"b\"}", result.payload)
		}
	default:
		t.Fatal("id-2 waiter received nothing")
	}
	select {
	case result := <-first:
		t.Fatalf("id-1 waiter received %+v, want nothing", result)
	default:
	}
}

func TestDaemonRPCTimeoutCleanupAndLateResponseAreHarmless(t *testing.T) {
	rpc := newDaemonRPC()
	rpc.register("id-1")

	// The caller's context expired, so it cancels its registration.
	rpc.cancel("id-1")
	rpc.mu.Lock()
	remaining := len(rpc.pending)
	rpc.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("pending after cancel = %d, want 0", remaining)
	}

	// The daemon's answer shows up anyway, plus one id nobody ever registered.
	if rpc.resolve("id-1", json.RawMessage(`{}`)) {
		t.Fatal("resolve() after cancel = true, want false")
	}
	if rpc.resolve("never-registered", json.RawMessage(`{}`)) {
		t.Fatal("resolve() for unknown id = true, want false")
	}
}

func TestDaemonRPCFailAllReleasesWaitersOnceAndLatchesClosed(t *testing.T) {
	rpc := newDaemonRPC()
	waiters := map[string]chan daemonRPCResult{
		"id-1": rpc.register("id-1"),
		"id-2": rpc.register("id-2"),
	}

	rpc.failAll()
	for id, waiter := range waiters {
		select {
		case result := <-waiter:
			if result.err == nil || result.err.Error() != daemonDisconnectedReason {
				t.Fatalf("%s error = %v, want %q", id, result.err, daemonDisconnectedReason)
			}
		default:
			t.Fatalf("%s was not released by failAll()", id)
		}
		select {
		case <-waiter:
			t.Fatalf("%s was released twice by failAll()", id)
		default:
		}
	}

	// failAll is idempotent, and registrations after it resolve immediately.
	rpc.failAll()
	select {
	case result := <-rpc.register("id-3"):
		if result.err == nil || result.err.Error() != daemonDisconnectedReason {
			t.Fatalf("late registration error = %v, want %q", result.err, daemonDisconnectedReason)
		}
	default:
		t.Fatal("late registration was not resolved immediately")
	}
	rpc.mu.Lock()
	remaining := len(rpc.pending)
	rpc.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("pending after failAll = %d, want 0", remaining)
	}
}

func TestDeliverDaemonResponseRejectsMalformedCorrelatedPayload(t *testing.T) {
	rpc := newDaemonRPC()
	waiter := rpc.register("id-1")
	connection := &daemonConnection{rpc: rpc}

	err := deliverDaemonResponse[wsFileReadPayload](connection, wsEnvelope{
		ID:      "id-1",
		Type:    wsFileReadType,
		Payload: json.RawMessage(`{"unexpected":true}`),
	}, nil)
	if err == nil {
		t.Fatal("deliverDaemonResponse() error = nil, want strict payload error")
	}
	select {
	case result := <-waiter:
		if result.err == nil {
			t.Fatal("correlated waiter error = nil, want strict payload error")
		}
	default:
		t.Fatal("malformed correlated response did not release its waiter")
	}
}

func TestDaemonRequestFailedQueueLeavesNoRegistryEntry(t *testing.T) {
	hub := NewDaemonHub(newTestStore(t), newBrowserEventHub(), "")
	connection := trackedConnection(t, hub)
	connection.close()

	_, err := daemonRequest[wsFileReadPayload](
		context.Background(),
		connection,
		wsReadFileType,
		json.RawMessage(`{"workspaceId":"ws","path":"README.md"}`),
	)
	if err == nil || err.Error() != daemonDisconnectedReason {
		t.Fatalf("daemonRequest() error = %v, want %q", err, daemonDisconnectedReason)
	}
	connection.rpc.mu.Lock()
	remaining := len(connection.rpc.pending)
	connection.rpc.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("pending after failed queue = %d, want 0", remaining)
	}
}

func TestDaemonRequestHonorsContextAndDropsRegistration(t *testing.T) {
	hub := NewDaemonHub(newTestStore(t), newBrowserEventHub(), "")
	connection := trackedConnection(t, hub)

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	_, err := daemonRequest[wsFileReadPayload](
		ctx,
		connection,
		wsReadFileType,
		json.RawMessage(`{"workspaceId":"ws","path":"README.md"}`),
	)
	if err != context.DeadlineExceeded {
		t.Fatalf("daemonRequest() error = %v, want %v", err, context.DeadlineExceeded)
	}
	connection.rpc.mu.Lock()
	remaining := len(connection.rpc.pending)
	connection.rpc.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("pending after context timeout = %d, want 0", remaining)
	}

	// The late answer for the abandoned request must not panic or block.
	envelope := <-connection.send
	if err := connection.handleEnvelopeResponseForTest(envelope.ID); err != nil {
		t.Fatalf("late file_read delivery error = %v, want nil", err)
	}
}

// handleEnvelopeResponseForTest feeds a well-formed file_read response through
// the same delivery path the read loop uses.
func (c *daemonConnection) handleEnvelopeResponseForTest(id string) error {
	return deliverDaemonResponse[wsFileReadPayload](c, wsEnvelope{
		ID:      id,
		Type:    wsFileReadType,
		Payload: json.RawMessage(`{"workspaceId":"ws","path":"README.md","content":"x","truncated":false}`),
	}, nil)
}
