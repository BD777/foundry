package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"testing"
)

// DEV-281: an absolute path outside the caller's workspace is read from its
// own temp folder, and a refusal says where the file is.
func TestPathWithinWorkspaceFolder(t *testing.T) {
	for path, want := range map[string]bool{
		"/home/u/ws/pie.png":        true,
		"/home/u/ws":                true,
		"/home/u/ws2/pie.png":       false,
		"/tmp/fdy-abc/pie.png":      false,
		"/home/u/ws/../other/x.png": false,
	} {
		if got := pathWithin("/home/u/ws", path); got != want {
			t.Errorf("pathWithin(%q) = %v, want %v", path, got, want)
		}
	}
	if pathWithin("", "/tmp/x") {
		t.Error("no workspace folder contains nothing")
	}
}

func TestTempFolderRefusalsStateWhereTheFileIs(t *testing.T) {
	cases := map[string]string{
		"other_session_temp": "is in another session's private temp folder; attachments are files in your workspace or your own temp folder; the session that made it can attach it with send_message",
		"outside_temp":       "is outside your workspace folder and your own temp folder",
		"no_temp_folder":     "your session has no temp folder yet",
	}
	for code, want := range cases {
		err := attachmentSourceError("/tmp/fdy-x/pie.png", attachmentRefusal{code: code, message: "refused"})
		var status *statusError
		if !errors.As(err, &status) || status.status != http.StatusNotFound {
			t.Fatalf("%s: got %#v", code, err)
		}
		if !strings.Contains(status.Error(), "/tmp/fdy-x/pie.png") || !strings.Contains(status.Error(), want) {
			t.Errorf("%s: message %q lacks %q", code, status.Error(), want)
		}
	}
}
