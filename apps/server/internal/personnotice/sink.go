// Package personnotice sends the person notices about items that wait for
// them and keeps each notice's delivery state (DEV-294). It names no
// connector: a sink is what knows a channel, and sinks register by id.
package personnotice

import (
	"context"
	"errors"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Sink delivers notices through one channel. Send is called with the
// notice's ID, which the sink must use as its idempotency key: the same
// notice may be sent again after a failure whose outcome was unknown.
type Sink interface {
	Send(ctx context.Context, notice store.PersonNotice) (SendResult, error)
}

// Refresher is a sink whose sent message shows the notice's state: answered,
// or superseded because the item was closed elsewhere. Refresh is called
// after such a change, with the notice as it now is. A sink that is not a
// Refresher keeps its message as it was sent.
type Refresher interface {
	Refresh(ctx context.Context, notice store.PersonNotice) error
}

// SendResult is what a sink reports for an accepted notice.
type SendResult struct {
	// ProviderMessageID names the message in the sink's channel, so a reply
	// can be matched to its notice.
	ProviderMessageID string
}

// SendError is a sink's failure, classified. A transient failure is retried
// with the same notice ID; a permanent one ends the notice. An ambiguous
// failure is transient, and it may have reached the provider already.
type SendError struct {
	transient bool
	ambiguous bool
	err       error
}

// Transient classifies a failure the provider did not accept, worth
// retrying (a 5xx, a network error before the request left).
func Transient(err error) error {
	return &SendError{transient: true, err: err}
}

// Ambiguous classifies a transient failure after which the provider may
// have accepted the notice (a timeout after the request left).
func Ambiguous(err error) error {
	return &SendError{transient: true, ambiguous: true, err: err}
}

// Permanent classifies a failure retrying cannot fix (a rejected request, a
// dead connector instance).
func Permanent(err error) error {
	return &SendError{err: err}
}

func (e *SendError) Error() string {
	if e.err == nil {
		return "notice send failed"
	}
	return e.err.Error()
}

func (e *SendError) Unwrap() error {
	return e.err
}

// Classify reads a sink's failure. An error that names no class is
// permanent: retrying a failure nobody understood could send twice.
func Classify(err error) (transient, ambiguous bool) {
	var sendErr *SendError
	if !errors.As(err, &sendErr) {
		return false, false
	}
	return sendErr.transient, sendErr.ambiguous
}
