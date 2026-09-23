package httpapi

import (
	"context"
	"sync"
	"time"
)

type projectionCacheEntry struct {
	ready    chan struct{}
	revision uint64
	expires  time.Time
	body     []byte
	err      error
}

type projectionCache struct {
	mu      sync.Mutex
	entries map[string]*projectionCacheEntry
}

// Events invalidate immediately. The short TTL also bounds staleness for
// changes made outside the HTTP/event path and time-dependent recovery checks.
func (c *projectionCache) load(ctx context.Context, key string, revision func() uint64, build func() ([]byte, bool, error)) ([]byte, error) {
	for {
		current := revision()
		c.mu.Lock()
		if c.entries == nil {
			c.entries = make(map[string]*projectionCacheEntry)
		}
		if entry := c.entries[key]; entry != nil && entry.revision == current {
			select {
			case <-entry.ready:
				if entry.err == nil && time.Now().Before(entry.expires) {
					c.mu.Unlock()
					return entry.body, nil
				}
			default:
				c.mu.Unlock()
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-entry.ready:
				}
				// A write may have arrived while the first request built its snapshot.
				continue
			}
		}
		entry := &projectionCacheEntry{ready: make(chan struct{}), revision: current}
		if len(c.entries) >= 32 {
			for oldKey := range c.entries {
				delete(c.entries, oldKey)
				break
			}
		}
		c.entries[key] = entry
		c.mu.Unlock()
		body, cacheable, err := build()
		c.mu.Lock()
		entry.body, entry.err = body, err
		if cacheable && err == nil {
			entry.expires = time.Now().Add(time.Second)
		}
		close(entry.ready)
		c.mu.Unlock()
		return body, err
	}
}
