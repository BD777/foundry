package feishugateway

import (
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
)

// Rate is a token bucket's refill per second and its depth.
type Rate = gateway.Rate

// limiter keeps one token bucket per key (a session, an app) at one rate.
type limiter struct {
	rate    Rate
	buckets gateway.Buckets
}

// take spends a token for key, or says how long until one is available.
func (l *limiter) take(key string, now time.Time) (bool, time.Duration) {
	if l == nil {
		return true, 0
	}
	return l.buckets.Take(l.rate, key, now)
}
