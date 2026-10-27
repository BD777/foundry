package httpapi

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
)

func TestAttachmentPreviewPushIsDeviceScopedAndCached(t *testing.T) {
	f := newIsolationFixture(t)
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6hgAAAAAASUVORK5CYII=")
	payload := map[string]any{"workspaceId": "ws_alice", "path": "/tmp/w/.foundry/attachments/push.png", "realPath": "/canonical/w/.foundry/attachments/push.png", "revision": "1:2:70:1234", "variant": "preview", "mimeType": "image/png", "dataBase64": base64.StdEncoding.EncodeToString(png)}
	push := func(credential string) *bytes.Buffer {
		raw, _ := json.Marshal(payload)
		var compressed bytes.Buffer
		gz := gzip.NewWriter(&compressed)
		_, _ = gz.Write(raw)
		_ = gz.Close()
		call := deviceCall(http.MethodPost, "/api/daemon/attachment-previews", compressed.String(), credential)
		call.headers["Content-Encoding"] = "gzip"
		response := doAuthCall(t, f.handler, call)
		if credential == f.aliceDevice {
			expectStatus(t, response, http.StatusNoContent, "push preview")
		} else {
			expectStatus(t, response, http.StatusNotFound, "foreign device")
		}
		return response.Body
	}
	push(f.aliceDevice)
	push(f.bobDevice)
	target := "/api/local-files/image?variant=preview&path=" + url.QueryEscape(payload["path"].(string))
	cached := doAuthCall(t, f.handler, f.as(f.alice, http.MethodGet, target, ""))
	expectStatus(t, cached, http.StatusOK, "offline device pre-pushed cache")
	if !bytes.Equal(cached.Body.Bytes(), png) || cached.Header().Get("ETag") == "" {
		t.Fatal("push did not warm authorized cache")
	}
	// A cookie login cannot impersonate a daemon producer.
	forbidden := doAuthCall(t, f.handler, f.as(f.alice, http.MethodPost, "/api/daemon/attachment-previews", "{}"))
	expectStatus(t, forbidden, http.StatusUnauthorized, "cookie is not device credential")
	payload["variant"] = "original"
	raw, _ := json.Marshal(payload)
	bad := doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/attachment-previews", string(raw), f.aliceDevice))
	expectStatus(t, bad, http.StatusBadRequest, "originals never pushed")
	payload["variant"] = "placeholder"
	payload["dataBase64"] = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 2049))
	raw, _ = json.Marshal(payload)
	large := doAuthCall(t, f.handler, deviceCall(http.MethodPost, "/api/daemon/attachment-previews", string(raw), f.aliceDevice))
	expectStatus(t, large, http.StatusBadRequest, "placeholder budget")
}
