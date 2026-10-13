package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// listAgentModelsRequest is POST /api/agent-profiles/models. Refresh asks the
// device again instead of answering from the server's copy.
type listAgentModelsRequest struct {
	Profile store.CreateAgentProfileInput `json:"profile"`
	Refresh bool                          `json:"refresh,omitempty"`
}

const (
	// modelCatalogFresh is how long a catalog answers without asking again.
	modelCatalogFresh = 10 * time.Minute
	// modelCatalogKept is how long an older catalog still answers at once
	// while a fresh one is read in the background.
	modelCatalogKept = 24 * time.Hour
	// modelCatalogReadTimeout bounds one device read. A cold CLI catalog on
	// macOS pays a one-time code-signing check that can run past half a
	// minute, so the wait is generous rather than optimistic.
	modelCatalogReadTimeout = 90 * time.Second
)

type modelCatalogReader func(context.Context, store.CreateAgentProfileInput) ([]store.AgentModelOption, error)

// modelCatalogCache keeps the model catalogs devices answered, keyed by the
// profile and a fingerprint of everything that decides its catalog (endpoint,
// connection, credential). Concurrent readers of one catalog share one device
// read. The zero value is ready to use.
type modelCatalogCache struct {
	mu      sync.Mutex
	entries map[string]*modelCatalogEntry
	// now is the clock; tests replace it.
	now func() time.Time
}

type modelCatalogEntry struct {
	deviceID  string
	profileID string
	models    []store.AgentModelOption
	readAt    time.Time
	known     bool
	reading   *modelCatalogRead
}

type modelCatalogRead struct {
	done   chan struct{}
	models []store.AgentModelOption
	err    error
}

// list answers a profile's catalog. A fresh copy answers at once; an older
// one answers at once and is re-read in the background; otherwise, or with
// refresh, the caller waits for the device. Failures are never kept.
func (c *modelCatalogCache) list(ctx context.Context, profile store.CreateAgentProfileInput, refresh bool, read modelCatalogReader) ([]store.AgentModelOption, error) {
	key := modelCatalogKey(profile)
	c.mu.Lock()
	now := c.clock()
	c.dropExpired(now)
	entry := c.entries[key]
	if entry == nil {
		entry = &modelCatalogEntry{deviceID: strings.TrimSpace(profile.DeviceID), profileID: strings.TrimSpace(profile.ID)}
		if c.entries == nil {
			c.entries = map[string]*modelCatalogEntry{}
		}
		c.entries[key] = entry
	}
	if entry.known && !refresh {
		models := slices.Clone(entry.models)
		if now.Sub(entry.readAt) >= modelCatalogFresh && entry.reading == nil {
			c.startRead(key, entry, profile, read)
		}
		c.mu.Unlock()
		return models, nil
	}
	pending := entry.reading
	if pending == nil {
		pending = c.startRead(key, entry, profile, read)
	}
	c.mu.Unlock()
	select {
	case <-pending.done:
		return slices.Clone(pending.models), pending.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// startRead asks the device once on behalf of every waiting reader. It runs
// detached from any one request, so a closed tab still leaves the answer for
// the next. c.mu must be held.
func (c *modelCatalogCache) startRead(key string, entry *modelCatalogEntry, profile store.CreateAgentProfileInput, read modelCatalogReader) *modelCatalogRead {
	pending := &modelCatalogRead{done: make(chan struct{})}
	entry.reading = pending
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), modelCatalogReadTimeout)
		models, err := read(ctx, profile)
		cancel()
		c.mu.Lock()
		pending.models, pending.err = models, err
		entry.reading = nil
		// A profile changed while it was being read keeps no answer.
		if c.entries[key] == entry {
			switch {
			case err == nil:
				entry.models, entry.readAt, entry.known = models, c.clock(), true
			case !entry.known:
				delete(c.entries, key)
			}
		}
		c.mu.Unlock()
		close(pending.done)
	}()
	return pending
}

// forgetProfile drops every catalog read for a profile, so its next reader
// asks the device with the profile's new settings.
func (c *modelCatalogCache) forgetProfile(deviceID, profileID string) {
	deviceID, profileID = strings.TrimSpace(deviceID), strings.TrimSpace(profileID)
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, entry := range c.entries {
		if entry.profileID == profileID && (deviceID == "" || entry.deviceID == deviceID) {
			delete(c.entries, key)
		}
	}
}

// dropExpired forgets catalogs too old to answer. c.mu must be held.
func (c *modelCatalogCache) dropExpired(now time.Time) {
	for key, entry := range c.entries {
		if entry.known && entry.reading == nil && now.Sub(entry.readAt) >= modelCatalogKept {
			delete(c.entries, key)
		}
	}
}

func (c *modelCatalogCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

// modelCatalogKey fingerprints the fields the device reads a catalog from.
// Presentation and run settings (workspace, prompt prefix, effort) are left
// out so every page asking about one profile shares its catalog. The
// credential is hashed with the rest and never kept in the clear.
func modelCatalogKey(profile store.CreateAgentProfileInput) string {
	fields, _ := json.Marshal([]string{
		strings.TrimSpace(profile.DeviceID),
		strings.TrimSpace(profile.ID),
		strings.TrimSpace(profile.Runtime),
		strings.TrimSpace(profile.ConfigScope),
		strings.TrimSpace(profile.ConnectionType),
		strings.TrimSpace(profile.BaseURL),
		strings.TrimSpace(profile.Model),
		strings.TrimSpace(profile.Label),
		strings.TrimSpace(profile.APIKey),
	})
	sum := sha256.Sum256(fields)
	return hex.EncodeToString(sum[:])
}
