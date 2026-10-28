package store

import (
	"errors"
	"strings"
)

// IsBusy reports whether err is the database refusing a statement because
// another connection or process held a lock past the busy timeout
// (SQLITE_BUSY or SQLITE_LOCKED and their extended codes). The condition is
// transient: the same request succeeds once the lock is released, so the
// HTTP layer answers it as retryable instead of as a server fault.
func IsBusy(err error) bool {
	if err == nil {
		return false
	}
	var coded interface{ Code() int }
	if errors.As(err, &coded) {
		switch coded.Code() & 0xff {
		case 5, 6: // SQLITE_BUSY, SQLITE_LOCKED
			return true
		}
		return false
	}
	// Some callers wrap with %v, which drops the driver error's type.
	message := err.Error()
	return strings.Contains(message, "SQLITE_BUSY") || strings.Contains(message, "SQLITE_LOCKED") || strings.Contains(message, "database is locked")
}
