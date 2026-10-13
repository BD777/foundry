package httpapi

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// deviceFileRequestTimeout bounds a file read or folder listing on a device.
const deviceFileRequestTimeout = 15 * time.Second

// statusError is a refusal that carries the HTTP status it answers with,
// over HTTP (writeResult) and MCP alike. Its text is err's.
type statusError struct {
	status int
	err    error
}

func (e *statusError) Error() string { return e.err.Error() }
func (e *statusError) Unwrap() error { return e.err }

// errorStatus is the status err was refused with, 0 for an ordinary failure.
func errorStatus(err error) int {
	var refusal *statusError
	if errors.As(err, &refusal) {
		return refusal.status
	}
	return 0
}

// deviceErrorStatus is the status of a request its device did not serve:
// 409 when the device is offline, 504 when it did not answer in time,
// otherwise 0.
func deviceErrorStatus(err error) int {
	switch {
	case errors.Is(err, store.ErrNotFound), errors.Is(err, ErrLocalDaemonNotConnected):
		return http.StatusConflict
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout
	}
	return 0
}

// deviceRequestError says why the workspace's device did not serve a file
// read or a folder listing: what it refused, offline, or connected without
// answering in time. It names the device instead of passing on "context
// deadline exceeded"; any other error comes back as it is.
func deviceRequestError(workspace store.WorkspaceProjection, err error) error {
	var fileRefusal sessionFileRefusal
	var taskRefusal backgroundTaskRefusal
	device := cmp.Or(strings.TrimSpace(workspace.DeviceLabel), "The device")
	switch {
	case errors.As(err, &fileRefusal):
		return &statusError{http.StatusNotFound, fileRefusal}
	case errors.As(err, &taskRefusal):
		return &statusError{http.StatusNotFound, taskRefusal}
	}
	switch deviceErrorStatus(err) {
	case http.StatusConflict:
		return &statusError{http.StatusConflict, errors.New(device + " is offline; its files open once it reconnects.")}
	case http.StatusGatewayTimeout:
		return &statusError{http.StatusGatewayTimeout, fmt.Errorf(
			"%s did not answer within %d seconds. Its worker may be busy or reconnecting; try again, and check the device page if it keeps happening.",
			device, int(deviceFileRequestTimeout/time.Second))}
	}
	return err
}

func writeResult(w http.ResponseWriter, payload any, err error) {
	writeResultWithStatus(w, http.StatusOK, payload, err)
}

func writeResultWithStatus(w http.ResponseWriter, status int, payload any, err error) {
	if err != nil {
		if status := errorStatus(err); status != 0 {
			writeError(w, status, err.Error())
			return
		}
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		if errors.Is(err, store.ErrSessionParentNotFound) {
			writeError(w, http.StatusBadRequest, store.ErrSessionParentNotFound.Error())
			return
		}
		if errors.Is(err, store.ErrProfileRuntimeMismatch) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if errors.Is(err, store.ErrSessionParentMismatch) {
			writeForbidden(w, store.ErrSessionParentMismatch.Error())
			return
		}
		if errors.Is(err, store.ErrAgentLineageTooDeep) ||
			errors.Is(err, store.ErrAgentFanOutLimit) ||
			errors.Is(err, store.ErrIssueEnvironmentUnavailable) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		if errors.Is(err, store.ErrAgentSessionActive) || errors.Is(err, store.ErrSessionInputExists) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		if errors.Is(err, store.ErrDeviceRemoved) {
			writeError(w, http.StatusGone, "device_removed")
			return
		}
		if isDeviceTimeout(err) {
			writeError(w, http.StatusGatewayTimeout, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, status, payload)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeCacheableJSON(w http.ResponseWriter, r *http.Request, encoded []byte) {
	digest := sha256.Sum256(encoded)
	etag := `"` + fmt.Sprintf("%x", digest) + `"`
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", etag)
	if ifNoneMatch(r.Header.Values("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(encoded)
	_, _ = w.Write([]byte("\n"))
}

// ifNoneMatch applies If-None-Match with the weak comparison RFC 9110
// §13.1.2 prescribes for it: "*" or any listed tag whose opaque part equals
// etag's, with or without W/. A proxy that compresses the body (nginx gzip)
// sends our strong tag back as W/"…".
func ifNoneMatch(headers []string, etag string) bool {
	opaque := strings.TrimPrefix(etag, "W/")
	for _, header := range headers {
		for _, candidate := range strings.Split(header, ",") {
			candidate = strings.TrimSpace(candidate)
			if candidate == "*" || strings.TrimPrefix(candidate, "W/") == opaque {
				return true
			}
		}
	}
	return false
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
