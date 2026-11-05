package gateway

import (
	"math"
	"sync"
	"time"
)

// Rate is a token bucket's refill per second and its depth.
type Rate struct {
	PerSecond float64
	Burst     float64
}

// Buckets keeps one token bucket per key (a session, an app). Buckets idle
// long enough to be full again are forgotten.
type Buckets struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	sweeps  int
}

type bucket struct {
	tokens float64
	at     time.Time
}

// Take spends a token of rate for key, or says how long until one is
// available. A rate with no PerSecond never limits.
func (b *Buckets) Take(rate Rate, key string, now time.Time) (bool, time.Duration) {
	if b == nil || rate.PerSecond <= 0 {
		return true, 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.buckets == nil {
		b.buckets = map[string]*bucket{}
	}
	if b.sweeps++; b.sweeps%1024 == 0 {
		full := time.Duration(rate.Burst / rate.PerSecond * float64(time.Second))
		for name, entry := range b.buckets {
			if now.Sub(entry.at) > full {
				delete(b.buckets, name)
			}
		}
	}
	entry, ok := b.buckets[key]
	if !ok {
		entry = &bucket{tokens: rate.Burst, at: now}
		b.buckets[key] = entry
	}
	entry.tokens = math.Min(rate.Burst, entry.tokens+now.Sub(entry.at).Seconds()*rate.PerSecond)
	entry.at = now
	if entry.tokens >= 1 {
		entry.tokens--
		return true, 0
	}
	return false, time.Duration((1 - entry.tokens) / rate.PerSecond * float64(time.Second))
}

// PerKey is a Limit of rate with a bucket for each key the lease names.
func (r Rate) PerKey(key func(*Lease) string) Limit {
	buckets := &Buckets{}
	return Limit{Key: key, Take: func(name string, now time.Time) (bool, time.Duration) {
		return buckets.Take(r, name, now)
	}}
}
