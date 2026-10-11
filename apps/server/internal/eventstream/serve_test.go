package eventstream

import (
	"bufio"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// streamLinesForTest reads an event stream line by line as it arrives.
func streamLinesForTest(t *testing.T, body io.Reader) <-chan string {
	t.Helper()
	lines := make(chan string, 256)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(body)
		scanner.Buffer(make([]byte, 0, 1<<16), 1<<22)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()
	return lines
}

func awaitLineForTest(t *testing.T, lines <-chan string, want func(string) bool, what string) string {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case line, ok := <-lines:
			if !ok {
				t.Fatalf("stream ended before %s", what)
			}
			if want(line) {
				return line
			}
		case <-deadline:
			t.Fatalf("%s did not arrive within 2s", what)
		}
	}
}

// A browser that accepts gzip gets a compressed stream it can decode as it
// arrives: each frame, the retry hint and heartbeats are flushed through the
// compressor at once.
func TestEventStreamIsCompressedFrameByFrame(t *testing.T) {
	interval := heartbeatInterval
	heartbeatInterval = 100 * time.Millisecond
	defer func() { heartbeatInterval = interval }()
	hub := New(controlForTest)
	server := streamServerForTest(hub)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Set explicitly, so the client hands over the compressed bytes.
	request.Header.Set("Accept-Encoding", "gzip, deflate, br")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	for header, want := range map[string]string{
		"Content-Encoding":  "gzip",
		"Content-Type":      "text/event-stream",
		"X-Accel-Buffering": "no",
	} {
		if got := response.Header.Get(header); got != want {
			t.Fatalf("%s = %q, want %q", header, got, want)
		}
	}
	if !strings.Contains(response.Header.Get("Vary"), "Accept-Encoding") {
		t.Fatalf("Vary = %q", response.Header.Get("Vary"))
	}
	decoded, err := gzip.NewReader(response.Body)
	if err != nil {
		t.Fatalf("stream is not gzip: %v", err)
	}
	lines := streamLinesForTest(t, decoded)
	awaitLineForTest(t, lines, func(line string) bool { return line == "retry: 1000" }, "the retry hint")
	for index := 0; index < 5; index++ {
		id := fmt.Sprintf("evt_gzip_%d", index)
		itemStream.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: id, Detail: strings.Repeat("answer so far ", 50*index)})
		awaitLineForTest(t, lines, func(line string) bool {
			return strings.HasPrefix(line, "data: ") && strings.Contains(line, `"id":"`+id+`"`)
		}, "frame "+id)
	}
	awaitLineForTest(t, lines, func(line string) bool { return line == ": keepalive" }, "a heartbeat")
}

// A client that does not accept gzip reads the stream as before.
func TestEventStreamStaysPlainWithoutGzip(t *testing.T) {
	hub := New(controlForTest)
	server := streamServerForTest(hub)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for _, acceptEncoding := range []string{"identity", "gzip;q=0, identity"} {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Accept-Encoding", acceptEncoding)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		if got := response.Header.Get("Content-Encoding"); got != "" {
			t.Fatalf("Accept-Encoding %q: Content-Encoding = %q", acceptEncoding, got)
		}
		lines := streamLinesForTest(t, response.Body)
		awaitLineForTest(t, lines, func(line string) bool { return line == "retry: 1000" }, "the retry hint")
		itemStream.Publish(hub, inWorkspaceForTest("ws_1"), itemForTest{ID: "evt_plain"})
		awaitLineForTest(t, lines, func(line string) bool { return strings.Contains(line, `"id":"evt_plain"`) }, "the plain frame")
		response.Body.Close()
	}
}
