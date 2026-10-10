package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
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
	started := time.Now()
	if !c.queue(wsEnvelope{ID: id, Type: requestType, Payload: payload}) {
		c.rpc.cancel(id)
		return value, errors.New(daemonDisconnectedReason)
	}

	select {
	case <-ctx.Done():
		c.rpc.cancel(id)
		return value, c.requestEnded(ctx, started)
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

// deviceNoAnswerError is a request handed to a device whose answer had not
// come when its caller stopped waiting: the wait ran out (a timeout) or the
// caller went away. Its text names the device, never "context deadline
// exceeded"; errors.Is still finds the context's error in it.
type deviceNoAnswerError struct {
	device string
	wait   time.Duration
	cause  error
}

func (e *deviceNoAnswerError) Error() string {
	if !errors.Is(e.cause, context.DeadlineExceeded) {
		return e.summary()
	}
	return e.summary() + " Its worker may be busy or catching up on a slow connection; try again in a moment."
}

// summary says only which device did not answer, and within how long.
func (e *deviceNoAnswerError) summary() string {
	if !errors.Is(e.cause, context.DeadlineExceeded) {
		return fmt.Sprintf("The request ended before %s answered.", e.device)
	}
	wait := fmt.Sprintf("%d s", int(e.wait.Round(time.Second)/time.Second))
	if e.wait < time.Second {
		wait = fmt.Sprintf("%d ms", e.wait.Round(10*time.Millisecond).Milliseconds())
	}
	return fmt.Sprintf("%s did not answer within %s.", e.device, wait)
}

func (e *deviceNoAnswerError) Unwrap() error { return e.cause }

// requestEnded is why a request handed to the device stopped waiting.
func (c *daemonConnection) requestEnded(ctx context.Context, started time.Time) error {
	wait := time.Since(started)
	if deadline, ok := ctx.Deadline(); ok {
		wait = deadline.Sub(started)
	}
	return &deviceNoAnswerError{device: c.deviceLabel(), wait: wait, cause: ctx.Err()}
}

// deviceLabel is the device as people know it: its label, else its id.
func (c *daemonConnection) deviceLabel() string {
	deviceID, registration := c.registrationSnapshot()
	if label := strings.TrimSpace(registration.Device.Label); label != "" {
		return label
	}
	if deviceID != "" {
		return deviceID
	}
	return "The device"
}

// isDeviceTimeout reports a device request that got no answer in time.
func isDeviceTimeout(err error) bool {
	var unanswered *deviceNoAnswerError
	return errors.As(err, &unanswered) && errors.Is(unanswered.cause, context.DeadlineExceeded)
}

// handedToDevice reports a request that reached the device's connection and
// was not answered: the device may still act on it.
func handedToDevice(err error) bool {
	var unanswered *deviceNoAnswerError
	return errors.As(err, &unanswered)
}
