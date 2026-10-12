package feishugateway

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

// limiter keeps one token bucket per key (a session, an app). Buckets idle
// long enough to be full again are forgotten.
type limiter struct {
	rate    Rate
	mu      sync.Mutex
	buckets map[string]*bucket
	sweeps  int
}

type bucket struct {
	tokens float64
	at     time.Time
}

// take spends a token for key, or says how long until one is available.
func (l *limiter) take(key string, now time.Time) (bool, time.Duration) {
	if l == nil || l.rate.PerSecond <= 0 {
		return true, 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.buckets == nil {
		l.buckets = map[string]*bucket{}
	}
	if l.sweeps++; l.sweeps%1024 == 0 {
		full := time.Duration(l.rate.Burst / l.rate.PerSecond * float64(time.Second))
		for name, entry := range l.buckets {
			if now.Sub(entry.at) > full {
				delete(l.buckets, name)
			}
		}
	}
	entry, ok := l.buckets[key]
	if !ok {
		entry = &bucket{tokens: l.rate.Burst, at: now}
		l.buckets[key] = entry
	}
	entry.tokens = math.Min(l.rate.Burst, entry.tokens+now.Sub(entry.at).Seconds()*l.rate.PerSecond)
	entry.at = now
	if entry.tokens >= 1 {
		entry.tokens--
		return true, 0
	}
	return false, time.Duration((1 - entry.tokens) / l.rate.PerSecond * float64(time.Second))
}
