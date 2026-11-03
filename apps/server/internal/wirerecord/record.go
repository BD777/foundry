// Package wirerecord samples what devices and the server send each other
// (daemon WebSocket envelopes, device REST bodies) into one bounded JSONL
// file, secrets and contents taken out, so the drift between what one side
// sends and what the other declares can be measured before either decodes
// strictly (docs/refactor/phase6-openapi-design.md, S1). It is off unless
// the server is given a directory, and goes once S3b validates every
// message.
package wirerecord

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// FileName is the recording inside the directory the server is given.
const FileName = "wire.jsonl"

// Limits bound what a recording costs: how many messages are kept, how
// large the file grows, how much of a message is looked at.
type Limits struct {
	// PerKind messages of each channel, direction and kind are kept
	// whatever their shape.
	PerKind int
	// Past PerKind, every ShapeEvery-th message of a kind is looked at and
	// kept only when its shape (field paths and JSON types) is new, up to
	// ShapesPerKind of them.
	ShapeEvery    int
	ShapesPerKind int
	// MaxFileBytes ends the recording; the file is never written past it.
	MaxFileBytes int64
	// A body larger than MaxBodyBytes is recorded by its size only.
	MaxBodyBytes int
	// Strings longer than MaxStringBytes keep only their length.
	MaxStringBytes int
	// Arrays keep their first ArrayHead elements and, up to ArrayMax, later
	// ones of a shape not kept yet.
	ArrayHead, ArrayMax int
}

// DefaultLimits keep a day of dev traffic in a few MiB: all of it fits in
// 64 MiB whatever runs.
var DefaultLimits = Limits{
	PerKind:        20,
	ShapeEvery:     25,
	ShapesPerKind:  100,
	MaxFileBytes:   64 << 20,
	MaxBodyBytes:   8 << 20,
	MaxStringBytes: 64,
	ArrayHead:      16,
	ArrayMax:       64,
}

// Record is one line of a recording.
type Record struct {
	At string `json:"at"`
	// Channel is "ws" (a daemon WebSocket envelope) or "rest" (a device
	// REST request and its response).
	Channel string `json:"channel"`
	// Dir, for an envelope: "in" from the device, "out" to it.
	Dir string `json:"dir,omitempty"`
	// Kind is the envelope's type or the route ("POST /api/daemon/pair").
	Kind   string `json:"kind"`
	Device string `json:"device,omitempty"`
	ID     string `json:"id,omitempty"`
	Error  string `json:"error,omitempty"`
	Status int    `json:"status,omitempty"`
	// Bytes is the size of the payload or request body as sent, before
	// anything was taken out; ResponseBytes the response's.
	Bytes         int `json:"bytes"`
	ResponseBytes int `json:"responseBytes,omitempty"`
	// Shape is a digest of the field paths and JSON types of what is kept.
	Shape    string          `json:"shape"`
	Payload  json.RawMessage `json:"payload,omitempty"`
	Response json.RawMessage `json:"response,omitempty"`
	// Omitted says why a body that was sent is not here.
	Omitted string `json:"omitted,omitempty"`
}

// Recorder appends sampled messages to a recording. A nil Recorder records
// nothing; its methods are safe from any goroutine.
type Recorder struct {
	limits Limits
	path   string

	mu      sync.Mutex
	file    *os.File
	written int64
	full    bool
	kinds   map[string]*kindSamples
}

type kindSamples struct {
	seen, kept, shapesKept int
	shapes                 map[string]bool
}

// Open starts (or continues) the recording in dir. What an earlier run
// already kept counts against the limits.
func Open(dir string, limits Limits) (*Recorder, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, FileName)
	r := &Recorder{limits: limits, path: path, kinds: map[string]*kindSamples{}}
	if existing, err := os.Open(path); err == nil {
		r.load(existing)
		_ = existing.Close()
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	r.file, r.written = file, info.Size()
	r.full = r.written >= limits.MaxFileBytes
	return r, nil
}

// Path is the recording's file.
func (r *Recorder) Path() string {
	if r == nil {
		return ""
	}
	return r.path
}

// load counts what an earlier run kept. A torn last line ends the count.
func (r *Recorder) load(file io.Reader) {
	decoder := json.NewDecoder(file)
	for {
		var line struct{ Channel, Dir, Kind, Shape string }
		if err := decoder.Decode(&line); err != nil {
			return
		}
		samples := r.samples(key(line.Channel, line.Dir, line.Kind))
		samples.kept++
		if samples.kept > r.limits.PerKind {
			samples.shapesKept++
		}
		samples.shapes[line.Shape] = true
	}
}

// Close ends the recording; later messages are not recorded.
func (r *Recorder) Close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.full = true
	if r.file == nil {
		return nil
	}
	err := r.file.Close()
	r.file = nil
	return err
}

// Envelope records one daemon WebSocket envelope, if it is sampled. dir is
// "in" (from the device) or "out".
func (r *Recorder) Envelope(dir, device, kind, id, errorText string, payload []byte) {
	candidate, always := r.admit("ws", dir, kind)
	if !candidate {
		return
	}
	record := Record{Channel: "ws", Dir: dir, Kind: kind, Device: device, ID: id, Bytes: len(payload)}
	if errorText != "" {
		record.Error = r.sanitizer().text(errorText)
	}
	var shapes []string
	record.Payload, shapes, record.Omitted = r.body(payload)
	record.Shape = shapeDigest(shapes)
	r.commit(record, always)
}

// HTTP records one device REST exchange, if it is sampled. kind is the
// route; request and response are the bodies as far as they were read.
func (r *Recorder) HTTP(kind string, status int, request, response []byte, omitted string) {
	candidate, always := r.admit("rest", "", kind)
	if !candidate {
		return
	}
	record := Record{Channel: "rest", Kind: kind, Status: status, Bytes: len(request), ResponseBytes: len(response), Omitted: omitted}
	var requestShapes, responseShapes []string
	var requestOmitted, responseOmitted string
	record.Payload, requestShapes, requestOmitted = r.body(request)
	record.Response, responseShapes, responseOmitted = r.body(response)
	for _, reason := range []string{requestOmitted, responseOmitted} {
		if reason != "" && record.Omitted == "" {
			record.Omitted = reason
		}
	}
	for i := range responseShapes {
		responseShapes[i] = "response" + responseShapes[i]
	}
	record.Shape = shapeDigest(append(requestShapes, responseShapes...))
	r.commit(record, always)
}

// Wants reports whether a message of this kind may be recorded at all, so a
// caller can skip capturing a body that would be dropped.
func (r *Recorder) Wants() bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return !r.full
}

func key(channel, dir, kind string) string { return channel + " " + dir + " " + kind }

func (r *Recorder) samples(k string) *kindSamples {
	samples := r.kinds[k]
	if samples == nil {
		samples = &kindSamples{shapes: map[string]bool{}}
		r.kinds[k] = samples
	}
	return samples
}

// admit decides cheaply, before a message is looked at: always while its
// kind has fewer than PerKind kept, then every ShapeEvery-th as a candidate
// for a new shape.
func (r *Recorder) admit(channel, dir, kind string) (candidate, always bool) {
	if r == nil {
		return false, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.full {
		return false, false
	}
	samples := r.samples(key(channel, dir, kind))
	samples.seen++
	if samples.kept < r.limits.PerKind {
		return true, true
	}
	if samples.shapesKept >= r.limits.ShapesPerKind || samples.seen%max(1, r.limits.ShapeEvery) != 0 {
		return false, false
	}
	return true, false
}

func (r *Recorder) commit(record Record, always bool) {
	record.At = time.Now().UTC().Format(time.RFC3339Nano)
	line, err := json.Marshal(record)
	if err != nil {
		return
	}
	line = append(line, '\n')
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.full || r.file == nil {
		return
	}
	samples := r.samples(key(record.Channel, record.Dir, record.Kind))
	if !always || samples.kept >= r.limits.PerKind {
		if samples.shapes[record.Shape] || samples.shapesKept >= r.limits.ShapesPerKind {
			return
		}
		samples.shapesKept++
	}
	if r.written+int64(len(line)) > r.limits.MaxFileBytes {
		r.full = true
		log.Printf("wire recording %s reached %d bytes; recording stopped", r.path, r.limits.MaxFileBytes)
		return
	}
	// One write per line: a second server process appending during a
	// restart handoff never splits it.
	if _, err := r.file.Write(line); err != nil {
		r.full = true
		log.Printf("wire recording %s stopped: %v", r.path, err)
		return
	}
	r.written += int64(len(line))
	samples.kept++
	samples.shapes[record.Shape] = true
}

// body sanitizes a JSON body: the result, its shape entries, and why it was
// left out instead (too large, not JSON).
func (r *Recorder) body(raw []byte) (json.RawMessage, []string, string) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, nil, ""
	}
	if len(raw) > r.limits.MaxBodyBytes {
		return nil, []string{":omitted"}, fmt.Sprintf("larger than %d bytes", r.limits.MaxBodyBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, []string{":omitted"}, "not JSON"
	}
	clean := r.sanitizer().value(value, modeNormal)
	encoded, err := json.Marshal(clean)
	if err != nil {
		return nil, []string{":omitted"}, "not encodable"
	}
	return encoded, shapeOf(clean), ""
}

func (r *Recorder) sanitizer() sanitizer {
	return sanitizer{maxString: r.limits.MaxStringBytes, arrayHead: r.limits.ArrayHead, arrayMax: r.limits.ArrayMax}
}

// Read calls fn with each record of a recording, in order, its numbers as
// json.Number. A torn last line ends it without an error.
func Read(path string, fn func(Record) error) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	for {
		var record Record
		if err := decoder.Decode(&record); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return nil
			}
			var syntax *json.SyntaxError
			if errors.As(err, &syntax) {
				return nil
			}
			return err
		}
		if err := fn(record); err != nil {
			return err
		}
	}
}
