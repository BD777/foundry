package httpapi

import (
	"bytes"
	"compress/gzip"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/wirerecord"
)

// Recording device traffic (FOUNDRY_WIRE_RECORD_DIR, dev only): before the
// device protocol decodes strictly, a day of real traffic shows where what
// each side sends drifts from what the other declares
// (docs/refactor/phase6-openapi-design.md, S1). The daemon WebSocket
// records envelopes both ways (handleEnvelope, writeEnvelope); the device
// REST routes below record their JSON bodies. Goes with S3b.

func openWireRecording(dir string) *wirerecord.Recorder {
	if dir == "" {
		return nil
	}
	recorder, err := wirerecord.Open(dir, wirerecord.DefaultLimits)
	if err != nil {
		log.Printf("wire recording off: %v", err)
		return nil
	}
	log.Printf("recording sampled device traffic to %s", recorder.Path())
	return recorder
}

// recordedDeviceRoute: the device REST routes whose request a device sends
// and whose answer it reads as JSON. The gateways' proxies, the skill
// upload and the WebSocket carry other things.
func recordedDeviceRoute(r route) bool {
	switch r.pattern {
	case "POST /api/daemon/pair", "GET /api/worker/release":
		return true
	case "GET /api/daemon/ws":
		return false
	}
	return r.rule.kind == ruleDaemon && !strings.Contains(r.pattern, "{path...}") &&
		!strings.HasPrefix(r.pattern, "POST /api/daemon/skill-repository-fetches/")
}

// maxRecordedBodyBytes bounds what a recorded exchange copies of each body;
// a larger one is recorded by its size.
var maxRecordedBodyBytes = wirerecord.DefaultLimits.MaxBodyBytes

func (s *Server) recordDeviceREST(r route) http.Handler {
	if s.wire == nil || !recordedDeviceRoute(r) {
		return r.handler
	}
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if !s.wire.Wants() {
			r.handler.ServeHTTP(w, req)
			return
		}
		request := &boundedCopy{limit: maxRecordedBodyBytes}
		if req.Body != nil {
			req.Body = teeReadCloser{Reader: io.TeeReader(req.Body, request), Closer: req.Body}
		}
		response := &recordingResponse{ResponseWriter: w, body: boundedCopy{limit: maxRecordedBodyBytes}}
		r.handler.ServeHTTP(response, req)
		requestBody, omitted := request.buf.Bytes(), ""
		if request.over || response.body.over {
			omitted = "body larger than recorded"
			requestBody, response.body.buf = nil, bytes.Buffer{}
		} else if strings.EqualFold(req.Header.Get("Content-Encoding"), "gzip") && len(requestBody) > 0 {
			requestBody, omitted = gunzipBounded(requestBody)
		}
		s.wire.HTTP(r.pattern, response.statusCode(), requestBody, response.body.buf.Bytes(), omitted)
	})
}

func gunzipBounded(compressed []byte) ([]byte, string) {
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, "gzip body unreadable"
	}
	defer reader.Close()
	plain, err := io.ReadAll(io.LimitReader(reader, int64(maxRecordedBodyBytes)+1))
	if err != nil || len(plain) > maxRecordedBodyBytes {
		return nil, "gzip body unreadable or larger than recorded"
	}
	return plain, ""
}

// boundedCopy keeps the first limit bytes written to it and notes more.
type boundedCopy struct {
	buf   bytes.Buffer
	limit int
	over  bool
}

func (c *boundedCopy) Write(p []byte) (int, error) {
	if c.buf.Len()+len(p) > c.limit {
		c.over = true
	}
	if room := c.limit - c.buf.Len(); room > 0 {
		c.buf.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

type teeReadCloser struct {
	io.Reader
	io.Closer
}

type recordingResponse struct {
	http.ResponseWriter
	status int
	body   boundedCopy
}

func (w *recordingResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *recordingResponse) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	_, _ = w.body.Write(p)
	return w.ResponseWriter.Write(p)
}

func (w *recordingResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *recordingResponse) statusCode() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}
