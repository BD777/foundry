package httpapi

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// An image whose device stops answering ends within the read deadlines: 504
// before any partial bytes can be cached or served.
func TestLocalImageReadsHaveDeadlines(t *testing.T) {
	chunkTimeout, totalTimeout := localImageChunkTimeout, localImageTimeout
	defer func() { localImageChunkTimeout, localImageTimeout = chunkTimeout, totalTimeout }()
	server := NewServer(newEmptyTestStore(t))
	testServer := httptest.NewServer(server.Routes())
	defer testServer.Close()
	conn := dialDaemonForTest(t, testServer)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	const workspacePath = "/nonexistent-on-server/deadline-ws"
	writeWSForTest(t, conn, "hello", map[string]any{
		"device":    map[string]any{"id": "dev_deadline", "label": "Deadline", "status": "connected", "lastSeenLabel": "online"},
		"workspace": map[string]any{"id": "ws_deadline", "name": "Deadline", "localPath": workspacePath},
	})
	readWSTypeForTest(t, conn, "registered")
	imagePath := workspacePath + "/.foundry/attachments/20261010/shot.png"
	request := func() <-chan *httptest.ResponseRecorder {
		served := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			response := httptest.NewRecorder()
			server.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/local-files/image?path="+url.QueryEscape(imagePath), nil))
			served <- response
		}()
		return served
	}
	await := func(served <-chan *httptest.ResponseRecorder, within time.Duration) *httptest.ResponseRecorder {
		t.Helper()
		select {
		case response := <-served:
			return response
		case <-time.After(within):
			t.Fatalf("the image request was still open after %s", within)
			return nil
		}
	}

	// The device never answers the first chunk.
	localImageChunkTimeout, localImageTimeout = 200*time.Millisecond, time.Minute
	served := request()
	readWSPayloadEnvelopeForTest(t, conn, "attachment_read", &wsAttachmentReadPayload{})
	response := await(served, 3*time.Second)
	if response.Code != http.StatusGatewayTimeout || !strings.Contains(response.Body.String(), "did not send the image") {
		t.Fatalf("unanswered image = %d %s, want 504", response.Code, response.Body.String())
	}

	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Retry-After") != "1" {
		t.Fatalf("transient image error headers = %v", response.Header())
	}

	// The whole image has a deadline even while each chunk is in time.
	localImageChunkTimeout, localImageTimeout = time.Minute, 200*time.Millisecond
	served = request()
	readWSPayloadEnvelopeForTest(t, conn, "attachment_read", &wsAttachmentReadPayload{})
	if response := await(served, 3*time.Second); response.Code != http.StatusGatewayTimeout {
		t.Fatalf("image past its total deadline = %d, want 504", response.Code)
	}

	// A partial read is never served or cached as a successful image.
	localImageChunkTimeout, localImageTimeout = 200*time.Millisecond, time.Minute
	image := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4}
	served = request()
	id := readWSPayloadEnvelopeForTest(t, conn, "attachment_read", &wsAttachmentReadPayload{})
	writeWSIDForTest(t, conn, id, "attachment_chunk_read", map[string]any{
		"size": len(image), "mimeType": "image/png", "dataBase64": base64.StdEncoding.EncodeToString(image[:8]),
	})
	readWSPayloadEnvelopeForTest(t, conn, "attachment_read", &wsAttachmentReadPayload{})
	response = await(served, 3*time.Second)
	if response.Code != http.StatusOK || response.Body.Len() != 8 || response.Header().Get("Content-Length") != "12" {
		t.Fatalf("stalled image = %d, %d of %s bytes", response.Code, response.Body.Len(), response.Header().Get("Content-Length"))
	}
}

// A missing image must not stay cached when an agent creates it later.
func TestLocalImageMissingIsNotCached(t *testing.T) {
	server := NewServer(newEmptyTestStore(t))
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/local-files/image?path=/no/workspace/.foundry/attachments/missing.png", nil))
	if response.Code != http.StatusNotFound || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("missing image = %d %v", response.Code, response.Header())
	}
}
