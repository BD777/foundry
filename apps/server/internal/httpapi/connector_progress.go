package httpapi

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// connectorProgressStale: a progress report older than this is no longer
// shown (its install ended without the server hearing, or the device went).
const connectorProgressStale = 30 * time.Second

// connectorProgressBoard keeps each device's latest install progress by
// connector kind, as the worker reports it while an install runs. Memory
// only: it describes something happening now.
type connectorProgressBoard struct {
	mu     sync.Mutex
	latest map[string]store.ConnectorProgressPayload
	now    func() time.Time
}

func (b *connectorProgressBoard) clock() time.Time {
	if b.now != nil {
		return b.now()
	}
	return time.Now()
}

func (b *connectorProgressBoard) record(deviceID string, progress store.ConnectorProgressPayload) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.latest == nil {
		b.latest = map[string]store.ConnectorProgressPayload{}
	}
	progress.At = b.clock().UTC().Format(time.RFC3339Nano)
	b.latest[deviceID+"\x00"+progress.Kind] = progress
}

func (b *connectorProgressBoard) clear(deviceID, kind string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.latest, deviceID+"\x00"+kind)
}

// of lists the device's current reports, by kind.
func (b *connectorProgressBoard) of(deviceID string) []store.ConnectorProgressPayload {
	b.mu.Lock()
	defer b.mu.Unlock()
	var listed []store.ConnectorProgressPayload
	for key, progress := range b.latest {
		at, err := time.Parse(time.RFC3339Nano, progress.At)
		if err != nil || b.clock().Sub(at) > connectorProgressStale {
			delete(b.latest, key)
			continue
		}
		if key[:len(key)-len(progress.Kind)-1] == deviceID {
			listed = append(listed, progress)
		}
	}
	sort.Slice(listed, func(i, j int) bool { return listed[i].Kind < listed[j].Kind })
	return listed
}

var connectorProgressPhases = map[string]bool{"downloading": true, "verifying": true, "installing": true, "checking": true}

// onConnectorProgress keeps what the device reports of a running install.
// It is not answered: the next report or the install's own reply follows.
func (c *daemonConnection) onConnectorProgress(_ context.Context, envelope wsEnvelope) error {
	var progress store.ConnectorProgressPayload
	if err := decodeWebSocketPayload(envelope.Payload, &progress); err != nil {
		return err
	}
	if !kindLike(progress.Kind) || !connectorProgressPhases[progress.Phase] ||
		progress.ReceivedBytes < 0 || progress.TotalBytes < 0 || progress.BytesPerSecond < 0 {
		return nil
	}
	deviceID, _ := c.registrationSnapshot()
	if deviceID == "" {
		return nil
	}
	c.hub.connectorProgress.record(deviceID, progress)
	return nil
}

// kindLike is a connector kind's shape (catalog kinds are short, lowercase).
func kindLike(kind string) bool {
	if kind == "" || len(kind) > 32 {
		return false
	}
	for _, r := range kind {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}
