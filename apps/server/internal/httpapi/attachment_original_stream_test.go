package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestOriginalImageStreamsBeforeTheRestAndCachesCompleteBytes(t *testing.T) {
	s := NewServer(newEmptyTestStore(t))
	live := httptest.NewServer(s.Routes())
	defer live.Close()
	conn := dialDaemonForTest(t, live)
	defer conn.Close()
	writeWSForTest(t, conn, "hello", map[string]any{"device": map[string]any{"id": "dev_stream", "status": "connected"}, "workspace": map[string]any{"id": "ws_stream", "name": "W", "localPath": "/stream"}})
	readWSTypeForTest(t, conn, "registered")
	data := append([]byte{137, 80, 78, 71, 13, 10, 26, 10}, bytes.Repeat([]byte{7}, 9000)...)
	target := live.URL + "/api/local-files/image?path=" + url.QueryEscape("/stream/.foundry/attachments/original.png")
	type result struct {
		response *http.Response
		err      error
	}
	responses := make(chan result, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, "GET", target, nil)
	go func() { r, e := http.DefaultClient.Do(request); responses <- result{r, e} }()
	answer := func() int64 {
		var payload wsAttachmentReadPayload
		id := readWSPayloadEnvelopeForTest(t, conn, "attachment_read", &payload)
		if payload.ChunkBytes != 4096 {
			t.Fatalf("progress block size=%d", payload.ChunkBytes)
		}
		start := payload.Offset
		end := min(start+4096, int64(len(data)))
		writeWSIDForTest(t, conn, id, "attachment_chunk_read", map[string]any{"size": len(data), "mimeType": "image/png", "realPath": "/canonical/original.png", "revision": "1:2:9008:1234", "dataBase64": base64.StdEncoding.EncodeToString(data[start:end])})
		return start
	}
	if answer() != 0 {
		t.Fatal("metadata read must be first")
	}
	var response *http.Response
	select {
	case r := <-responses:
		if r.err != nil {
			t.Fatal(r.err)
		}
		response = r.response
	case <-time.After(time.Second):
		t.Fatal("headers waited for complete original")
	}
	defer response.Body.Close()
	first := make([]byte, 4096)
	if _, err := io.ReadFull(response.Body, first); err != nil || !bytes.Equal(first, data[:4096]) {
		t.Fatal("first bytes not streamed", err)
	}
	if response.Header.Get("X-Accel-Buffering") != "no" || response.ContentLength != int64(len(data)) {
		t.Fatal("missing stream/progress headers")
	}
	answer()
	answer()
	rest, err := io.ReadAll(response.Body)
	if err != nil || !bytes.Equal(append(first, rest...), data) {
		t.Fatal("incomplete original", err)
	}
	repeat, err := http.Get(target)
	if err != nil {
		t.Fatal(err)
	}
	defer repeat.Body.Close()
	again, _ := io.ReadAll(repeat.Body)
	if !bytes.Equal(again, data) || repeat.Header.Get("ETag") != response.Header.Get("ETag") {
		t.Fatal("complete original not cached consistently")
	}
	// Start a fresh original, close it after its first bytes, and ensure no
	// background original read survives the viewer's cancellation.
	next := make(chan result, 1)
	ctx2, cancel2 := context.WithCancel(context.Background())
	req2, _ := http.NewRequestWithContext(ctx2, "GET", target+"&refresh=1", nil)
	go func() { r, e := http.DefaultClient.Do(req2); next <- result{r, e} }()
	answer()
	r2 := <-next
	if r2.err != nil {
		t.Fatal(r2.err)
	}
	cancel2()
	r2.response.Body.Close()
	connection := s.hub.connectionFor("dev_stream")
	deadline := time.Now().Add(time.Second)
	for {
		connection.rpc.mu.Lock()
		pending := len(connection.rpc.pending)
		connection.rpc.mu.Unlock()
		s.attachmentImages.mu.Lock()
		active := s.attachmentImages.originals
		s.attachmentImages.mu.Unlock()
		if pending == 0 && active == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("cancel left %d RPCs and %d readers", pending, active)
		}
		time.Sleep(time.Millisecond)
	}
}
