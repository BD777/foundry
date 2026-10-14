package httpapi

import (
	"context"
	"log"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// learnCodexTransport keeps what a Codex session showed about its compatible
// endpoint's Responses WebSocket (event metadata codexTransport), for the
// server profile the session ran on this device at the base URL it ran with.
// Foundry never probes the endpoint; this is the only source. A report that
// names another profile or device, or a base URL the profile no longer has,
// is not kept.
func (c *daemonConnection) learnCodexTransport(ctx context.Context, event store.AgentSessionEvent) {
	if event.Metadata == nil || event.Metadata.CodexTransport == nil {
		return
	}
	report := *event.Metadata.CodexTransport
	deviceID, _ := c.registrationSnapshot()
	session, err := store.AgentSessionRecord(ctx, c.hub.store, event.SessionID)
	if err != nil || session.DeviceID != deviceID {
		return
	}
	profile, err := c.hub.serverProfileForSession(ctx, session)
	if err != nil || profile == nil || profile.ID != strings.TrimSpace(report.ProfileID) ||
		profile.BaseURL != strings.TrimSpace(report.BaseURL) || profile.CodexTransport == "" {
		return
	}
	observation := store.CodexTransportObservation{
		Transport: report.Transport,
		Detail:    truncateRunes(strings.TrimSpace(report.Detail), 500),
		LearnedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err := c.hub.store.RecordCodexTransport(ctx, profile.ID, profile.BaseURL, observation); err != nil {
		log.Printf("codex transport for profile %s: %v", profile.ID, err)
		return
	}
	c.hub.dataChanges.changed("", fieldProfiles)
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
