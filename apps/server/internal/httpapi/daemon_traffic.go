package httpapi

import (
	"encoding/json"
	"log"
	"sync"
	"time"
)

// A minute of decoded envelopes, never their contents. Bounded buckets keep
// diagnostics cheap on a busy daemon and distinguish wire pieces from logical
// messages reconstructed from them. Byte counts are before WebSocket compression.
type daemonTrafficCount struct {
	Count int64 `json:"count"`
	Bytes int64 `json:"bytes"`
}
type daemonTrafficBucket struct {
	at            int64
	wire, logical map[string]daemonTrafficCount
}
type daemonTraffic struct {
	mu      sync.Mutex
	buckets [6]daemonTrafficBucket
	started time.Time
}

func (t *daemonTraffic) add(kind, name string, size int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.started.IsZero() {
		t.started = time.Now()
	}
	now := time.Now().Unix() / 10
	b := &t.buckets[now%6]
	if b.at != now {
		*b = daemonTrafficBucket{at: now, wire: map[string]daemonTrafficCount{}, logical: map[string]daemonTrafficCount{}}
	}
	counts := b.wire
	if kind == "logical" {
		counts = b.logical
	}
	v := counts[name]
	v.Count++
	v.Bytes += int64(size)
	counts[name] = v
}
func (t *daemonTraffic) snapshot() any {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now().Unix() / 10
	wire, logical := map[string]daemonTrafficCount{}, map[string]daemonTrafficCount{}
	merge := func(out, in map[string]daemonTrafficCount) {
		for k, v := range in {
			old := out[k]
			old.Count += v.Count
			old.Bytes += v.Bytes
			out[k] = old
		}
	}
	for _, b := range t.buckets {
		if b.at > now-6 {
			merge(wire, b.wire)
			merge(logical, b.logical)
		}
	}
	return map[string]any{"observedSeconds": min(60, time.Since(t.started).Seconds()), "windowSeconds": 60, "wire": wire, "logical": logical}
}
func (c *daemonConnection) logFileRPC(kind string, started time.Time) {
	if kind != wsAttachmentReadType && kind != wsReadFileType && kind != wsReadSessionFileType {
		return
	}
	device, _ := c.registrationSnapshot()
	traffic, _ := json.Marshal(c.traffic.snapshot())
	log.Printf("daemon file rpc device=%s type=%s elapsedMs=%d traffic=%s", device, kind, time.Since(started).Milliseconds(), traffic)
}
