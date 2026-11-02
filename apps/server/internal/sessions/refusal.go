package sessions

import (
	"context"
	"errors"
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Refusal is a request refused with the HTTP status that says why; the
// service's signatures carry no HTTP otherwise. httpapi answers with its
// status (HTTPStatus), as for its own refusals.
type Refusal struct {
	Status int
	Err    error
}

func (e *Refusal) Error() string   { return e.Err.Error() }
func (e *Refusal) Unwrap() error   { return e.Err }
func (e *Refusal) HTTPStatus() int { return e.Status }

var ErrLocalDaemonNotConnected = errors.New("local daemon is not connected")

// ErrNotSteerable is a device's answer that the session has no turn
// that takes input now: it is starting, finishing or compacting.
var ErrNotSteerable = errors.New("the session is not taking input right now")

// DeviceErrorStatus is the status of a request its device did not serve:
// 409 when the device is offline, 504 when it did not answer in time,
// otherwise 0.
func DeviceErrorStatus(err error) int {
	switch {
	case errors.Is(err, store.ErrNotFound), errors.Is(err, ErrLocalDaemonNotConnected):
		return http.StatusConflict
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout
	}
	return 0
}
