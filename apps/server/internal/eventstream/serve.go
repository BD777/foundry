package eventstream

import (
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// heartbeatInterval keeps idle streams open through proxies; a variable so
// tests can see heartbeats arrive.
var heartbeatInterval = 15 * time.Second

// Serve streams to w the messages reach receives, from where the request's
// Last-Event-ID (or ?lastEventId=) left off, until the request ends, the hub
// shuts down or the stream's account is reauthorized.
func (h *Hub) Serve(w http.ResponseWriter, r *http.Request, reach Reach) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming is not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	lastEventID := r.Header.Get("Last-Event-ID")
	if lastEventID == "" {
		lastEventID = r.URL.Query().Get("lastEventId")
	}
	subscription, open := h.Subscribe(reach, lastEventID)
	if !open {
		http.Error(w, "server is shutting down", http.StatusServiceUnavailable)
		return
	}
	defer subscription.Close()

	// The stream is compressed here when the browser accepts it: proxies
	// (nginx) do not compress text/event-stream, and frames repeat a
	// streaming answer several times a second. Every flush ends a deflate
	// block, so each frame reaches the browser as it is written; the
	// dictionary carries across flushes, and the strongest level suits a
	// link where bytes cost more than the server's time.
	var stream io.Writer = w
	flush := flusher.Flush
	w.Header().Add("Vary", "Accept-Encoding")
	if acceptsGzip(r) {
		w.Header().Set("Content-Encoding", "gzip")
		compressed, _ := gzip.NewWriterLevel(w, gzip.BestCompression)
		defer compressed.Close()
		stream = compressed
		flush = func() {
			_ = compressed.Flush()
			flusher.Flush()
		}
	}

	_, _ = fmt.Fprint(stream, ": connected\nretry: 1000\n\n")
	for _, frame := range subscription.Backlog() {
		if _, err := stream.Write(frame); err != nil {
			return
		}
	}
	flush()

	heartbeat := time.NewTicker(heartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case <-subscription.Done():
			return
		case <-r.Context().Done():
			return
		case frame := <-subscription.C:
			if _, err := stream.Write(frame); err != nil {
				return
			}
			if resync, ok := subscription.Resync(); ok {
				if _, err := stream.Write(resync); err != nil {
					return
				}
			}
			flush()
		case <-heartbeat.C:
			if _, err := fmt.Fprint(stream, ": keepalive\n\n"); err != nil {
				return
			}
			flush()
		}
	}
}

// acceptsGzip reports whether the request's Accept-Encoding lists gzip
// with a non-zero quality.
func acceptsGzip(r *http.Request) bool {
	for _, header := range r.Header.Values("Accept-Encoding") {
		for _, part := range strings.Split(header, ",") {
			coding, params, _ := strings.Cut(part, ";")
			if !strings.EqualFold(strings.TrimSpace(coding), "gzip") {
				continue
			}
			for _, param := range strings.Split(params, ";") {
				name, value, _ := strings.Cut(param, "=")
				if strings.EqualFold(strings.TrimSpace(name), "q") {
					if quality, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil && quality <= 0 {
						return false
					}
				}
			}
			return true
		}
	}
	return false
}
