package httpapi

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"strings"
	"sync"
	"time"
)

var errAttachmentReadsBusy = errors.New("attachment reads are busy; retry")
var errInvalidAttachmentImage = errors.New("the device returned an incomplete or changed image")

const attachmentImageCacheBytes = 64 << 20
const attachmentImageCacheEntries = 128
const attachmentImageCacheTTL = 5 * time.Minute

type cachedAttachmentImage struct {
	data                           []byte
	mime, realPath, revision, etag string
	expires                        time.Time
	used                           uint64
}
type attachmentImageFlight struct {
	done  chan struct{}
	image *cachedAttachmentImage
	err   error
}
type attachmentImageCache struct {
	originals int
	mu        sync.Mutex
	entries   map[string]*cachedAttachmentImage
	aliases   map[string]string
	flights   map[string]*attachmentImageFlight
	bytes     int
	clock     uint64
}

// Only successful device-validated attachments are cached. The alias keeps the
// immutable path fast for five minutes; the stored identity includes the
// device, canonical path, size and inode/mtime revision. Every HTTP request
// must authorize its workspace before calling this cache.
func (c *attachmentImageCache) read(ctx context.Context, alias, device string, load func(context.Context) (*cachedAttachmentImage, error)) (*cachedAttachmentImage, error) {
	c.mu.Lock()
	if c.entries == nil {
		c.entries = map[string]*cachedAttachmentImage{}
		c.aliases = map[string]string{}
		c.flights = map[string]*attachmentImageFlight{}
	}
	c.clock++
	if image := c.entries[c.aliases[alias]]; image != nil && time.Now().Before(image.expires) {
		image.used = c.clock
		c.mu.Unlock()
		return image, nil
	}
	flight := c.flights[alias]
	if flight == nil {
		isTiny := strings.HasPrefix(alias, "placeholder\x00")
		inFlight := 0
		for key := range c.flights {
			if strings.HasPrefix(key, "placeholder\x00") == isTiny {
				inFlight++
			}
		}
		if inFlight >= 4 {
			c.mu.Unlock()
			return nil, errAttachmentReadsBusy
		}
		flight = &attachmentImageFlight{done: make(chan struct{})}
		c.flights[alias] = flight
		// A viewer navigating away does not discard a read another viewer awaits.
		// The independent read remains bounded by the existing image deadline.
		background, done := context.WithTimeout(context.WithoutCancel(ctx), localImageTimeout)
		go func() {
			defer done()
			image, err := load(background)
			c.mu.Lock()
			defer c.mu.Unlock()
			flight.image, flight.err = image, err
			if err == nil {
				c.storeLocked(alias, device, image)
			}

			delete(c.flights, alias)
			close(flight.done)
		}()
	}
	c.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-flight.done:
		return flight.image, flight.err
	}
}
func (c *attachmentImageCache) evictOldest() {
	var key string
	var oldest *cachedAttachmentImage
	for k, v := range c.entries {
		if oldest == nil || v.used < oldest.used {
			key, oldest = k, v
		}
	}
	if oldest == nil {
		return
	}
	delete(c.entries, key)
	c.bytes -= len(oldest.data)
	for alias, k := range c.aliases {
		if k == key {
			delete(c.aliases, alias)
		}
	}
}

// Explicit recovery bypasses a previously cached, but undecodable image.
func (c *attachmentImageCache) invalidate(alias string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.aliases, alias)
}

func attachmentImageAlias(workspace store.WorkspaceProjection, path, variant string) string {
	return variant + "\x00" + workspace.DeviceID + "\x00" + workspace.ID + "\x00" + workspace.LocalPath + "\x00" + path
}
func (c *attachmentImageCache) storeLocked(alias, device string, image *cachedAttachmentImage) {
	if c.entries == nil {
		c.entries = map[string]*cachedAttachmentImage{}
		c.aliases = map[string]string{}
		c.flights = map[string]*attachmentImageFlight{}
	}
	if image.etag == "" {
		image.etag = fmt.Sprintf("\"%x\"", sha256.Sum256(image.data))
	}
	if image.realPath == "" || image.revision == "" || len(image.data) > attachmentImageCacheBytes {
		return
	}
	key := fmt.Sprintf("%s\x00%s\x00%s\x00%s", device, image.realPath, image.revision, image.etag)
	image.expires = time.Now().Add(attachmentImageCacheTTL)
	c.clock++
	image.used = c.clock
	if old := c.entries[key]; old != nil {
		c.bytes -= len(old.data)
	}
	c.entries[key] = image
	c.bytes += len(image.data)
	c.aliases[alias] = key
	for c.bytes > attachmentImageCacheBytes || len(c.entries) > attachmentImageCacheEntries || len(c.aliases) > attachmentImageCacheEntries*4 {
		c.evictOldest()
	}
}
func (c *attachmentImageCache) put(alias, device string, image *cachedAttachmentImage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.storeLocked(alias, device, image)
}

func (c *attachmentImageCache) get(alias string) *cachedAttachmentImage {
	c.mu.Lock()
	defer c.mu.Unlock()
	image := c.entries[c.aliases[alias]]
	if image == nil || !time.Now().Before(image.expires) {
		return nil
	}
	c.clock++
	image.used = c.clock
	return image
}
func (c *attachmentImageCache) beginOriginal() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.originals >= 4 {
		return false
	}
	c.originals++
	return true
}
func (c *attachmentImageCache) endOriginal() { c.mu.Lock(); defer c.mu.Unlock(); c.originals-- }
