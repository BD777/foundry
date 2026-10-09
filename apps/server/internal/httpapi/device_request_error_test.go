package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A file request the device cannot serve names the device and the reason,
// never "context deadline exceeded".
func TestDeviceRequestErrorsNameTheDevice(t *testing.T) {
	workspace := store.WorkspaceProjection{ID: "ws", DeviceLabel: "byte-dev"}
	for _, tc := range []struct {
		err    error
		status int
		says   string
	}{
		{fmt.Errorf("wait: %w", context.DeadlineExceeded), http.StatusGatewayTimeout, "byte-dev did not answer within 15 seconds"},
		{store.ErrNotFound, http.StatusConflict, "byte-dev is offline"},
	} {
		recorder := httptest.NewRecorder()
		if !writeDeviceRequestError(recorder, workspace, tc.err) {
			t.Fatalf("%v was not answered", tc.err)
		}
		if recorder.Code != tc.status || !strings.Contains(recorder.Body.String(), tc.says) {
			t.Fatalf("%v: %d %s", tc.err, recorder.Code, recorder.Body.String())
		}
	}
	if writeDeviceRequestError(httptest.NewRecorder(), workspace, errors.New("requested file is outside the paired workspace")) {
		t.Fatal("the device's own refusal must reach the person unchanged")
	}
}
