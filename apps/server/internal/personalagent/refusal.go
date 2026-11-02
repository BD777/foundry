package personalagent

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Refusal is a request the assistant's flows refuse, with the HTTP status
// that says why; their signatures carry no HTTP otherwise. httpapi answers
// with its status (HTTPStatus), as for its own refusals. Kind, when set,
// is why the assistant's audit says a write was refused
// (store.PersonalAgentRefusal*).
type Refusal struct {
	Status int
	Err    error
	Kind   string
}

func (e *Refusal) Error() string   { return e.Err.Error() }
func (e *Refusal) Unwrap() error   { return e.Err }
func (e *Refusal) HTTPStatus() int { return e.Status }

// Refuse is a refusal of kind with status.
func Refuse(kind string, status int, format string, args ...any) error {
	return &Refusal{Status: status, Err: fmt.Errorf(format, args...), Kind: kind}
}

// Invalid refuses a request whose arguments are wrong (400).
func Invalid(format string, args ...any) error {
	return Refuse(store.PersonalAgentRefusalInvalid, http.StatusBadRequest, format, args...)
}

// RefusalKind is the kind of the first refusal in err's chain that has one.
func RefusalKind(err error) (string, bool) {
	for ; err != nil; err = errors.Unwrap(err) {
		if refusal, ok := err.(*Refusal); ok && refusal.Kind != "" {
			return refusal.Kind, true
		}
	}
	return "", false
}
