package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// daemonRPC correlates outbound daemon requests with the responses that come
// back on the read loop. Every in-flight request lives in one map behind one
// mutex, from id allocation until it is resolved, canceled by its caller, or
// failed by protocol validation/teardown. A result carries payload or error
// explicitly so a missing payload cannot be confused with a disconnect.
type daemonRPC struct {
	closed   bool
	mu       sync.Mutex
	pending  map[string]chan daemonRPCResult
	sequence atomic.Uint64
}

type daemonRPCResult struct {
	payload json.RawMessage
	err     error
}

func newDaemonRPC() *daemonRPC {
	return &daemonRPC{pending: make(map[string]chan daemonRPCResult)}
}

// newRequestID keeps the historical "<type>_<stamp>" id shape while making
// collisions impossible: the monotonic counter, not the clock, is what
// guarantees uniqueness when concurrent callers mint ids in the same
// nanosecond.
func (r *daemonRPC) newRequestID(requestType string) string {
	sequence := r.sequence.Add(1)
	return requestType + "_" +
		time.Now().UTC().Format("20060102150405.000000000") + "_" +
		strconv.FormatUint(sequence, 10)
}

// register hands back the channel the caller waits on. A registry that already
// failed pre-resolves the waiter, so a caller that registers during teardown
// fails fast instead of hanging until its own context expires.
func (r *daemonRPC) register(id string) chan daemonRPCResult {
	waiter := make(chan daemonRPCResult, 1)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		waiter <- daemonRPCResult{err: errors.New(daemonDisconnectedReason)}
		return waiter
	}
	r.pending[id] = waiter
	return waiter
}

// cancel drops an entry whose caller stopped waiting, so a timeout or a failed
// queue never leaks a registration.
func (r *daemonRPC) cancel(id string) {
	r.mu.Lock()
	delete(r.pending, id)
	r.mu.Unlock()
}

// resolve delivers payload to the waiter for id. It reports false when nobody
// owns the id: a response that arrived after its caller gave up, or a daemon
// push that reuses a response type. Both are harmless.
func (r *daemonRPC) resolve(id string, payload json.RawMessage) bool {
	return r.settle(id, daemonRPCResult{payload: payload})
}

// reject wakes a correlated caller when a response exists but violates its
// payload contract. Without this path the read loop could report the protocol
// error to the daemon while the HTTP caller waited until its context expired.
func (r *daemonRPC) reject(id string, err error) bool {
	return r.settle(id, daemonRPCResult{err: err})
}

func (r *daemonRPC) settle(id string, result daemonRPCResult) bool {
	r.mu.Lock()
	waiter := r.pending[id]
	delete(r.pending, id)
	r.mu.Unlock()
	if waiter == nil {
		return false
	}
	// The entry left the map under the lock, so this is the only delivery for
	// this waiter and the buffered slot is guaranteed free.
	waiter <- result
	return true
}

// failAll releases every waiting caller exactly once with the disconnect
// sentinel and latches the registry closed so late registrations fail too.
func (r *daemonRPC) failAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	for id, waiter := range r.pending {
		waiter <- daemonRPCResult{err: errors.New(daemonDisconnectedReason)}
		delete(r.pending, id)
	}
}

// daemonRequest sends one request envelope and waits for the correlated
// response, decoding it into T. Callers keep their typed DTO handling (error
// fields, registration side effects) at the method boundary.
func daemonRequest[T any](
	ctx context.Context,
	c *daemonConnection,
	requestType string,
	payload json.RawMessage,
) (T, error) {
	var value T
	id := c.rpc.newRequestID(requestType)
	waiter := c.rpc.register(id)
	if !c.queue(wsEnvelope{ID: id, Type: requestType, Payload: payload}) {
		c.rpc.cancel(id)
		return value, errors.New(daemonDisconnectedReason)
	}

	select {
	case <-ctx.Done():
		c.rpc.cancel(id)
		return value, ctx.Err()
	case result := <-waiter:
		if result.err != nil {
			return value, result.err
		}
		if err := decodeWebSocketPayload(result.payload, &value); err != nil {
			var zero T
			return zero, err
		}
		return value, nil
	}
}

// deliverDaemonResponse validates an inbound response, hands the bytes to the
// waiting caller, and falls back to unsolicited handling when no caller owns
// the id. A malformed correlated response rejects its caller immediately and
// also returns the error so the read loop reports it to the daemon.
func deliverDaemonResponse[T any](
	c *daemonConnection,
	envelope wsEnvelope,
	unsolicited func(T) error,
) error {
	var payload T
	if err := decodeWebSocketPayload(envelope.Payload, &payload); err != nil {
		c.rpc.reject(envelope.ID, err)
		return err
	}
	if c.rpc.resolve(envelope.ID, envelope.Payload) {
		return nil
	}
	if unsolicited == nil {
		return nil
	}
	return unsolicited(payload)
}
