package sqlitestore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// setupProfileCodexTransports adds the person's Responses transport choice
// to profiles and the table of what Codex sessions showed about each
// endpoint, per profile and base URL.
func (s *Store) setupProfileCodexTransports(ctx context.Context) error {
	if err := s.ensureColumn(ctx, "profiles", "codex_transport", `ALTER TABLE profiles ADD COLUMN codex_transport TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if _, err := s.conn().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS profile_codex_transports (
		profile_id TEXT NOT NULL,
		base_url TEXT NOT NULL,
		transport TEXT NOT NULL,
		detail TEXT NOT NULL DEFAULT '',
		learned_at TEXT NOT NULL,
		PRIMARY KEY (profile_id, base_url)
	)`); err != nil {
		return fmt.Errorf("migrate sqlite profile codex transports: %w", err)
	}
	return nil
}

// RecordCodexTransport keeps the newest observation for the profile at
// baseURL. One for a base URL the profile no longer has is not kept.
func (s *Store) RecordCodexTransport(ctx context.Context, profileID string, baseURL string, observation store.CodexTransportObservation) error {
	profileID = strings.TrimSpace(profileID)
	baseURL = strings.TrimSpace(baseURL)
	if observation.Transport != store.CodexTransportWebSocket && observation.Transport != store.CodexTransportHTTPS {
		return fmt.Errorf("codex transport must be %s or %s", store.CodexTransportWebSocket, store.CodexTransportHTTPS)
	}
	if profileID == "" || baseURL == "" {
		return errors.New("codex transport needs a profile and a base URL")
	}
	learnedAt := strings.TrimSpace(observation.LearnedAt)
	if learnedAt == "" {
		learnedAt = formatTime(time.Now())
	}
	_, err := s.conn().ExecContext(ctx, `
		INSERT INTO profile_codex_transports (profile_id, base_url, transport, detail, learned_at)
		SELECT id, base_url, ?, ?, ? FROM profiles WHERE id = ? AND base_url = ?
		ON CONFLICT(profile_id, base_url) DO UPDATE SET
			transport = excluded.transport,
			detail = excluded.detail,
			learned_at = excluded.learned_at`,
		observation.Transport, observation.Detail, learnedAt, profileID, baseURL)
	if err != nil {
		return fmt.Errorf("record codex transport for %s: %w", profileID, err)
	}
	return nil
}

// forgetCodexTransports drops what was learned for a profile: an edited
// provider is learned again.
func forgetCodexTransports(ctx context.Context, db dbExecutor, profileID string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM profile_codex_transports WHERE profile_id = ?`, profileID); err != nil {
		return fmt.Errorf("forget codex transports of %s: %w", profileID, err)
	}
	return nil
}

// attachCodexTransports fills CodexTransportLearned with the observation for
// each profile's current base URL that is younger than the TTL.
func attachCodexTransports(ctx context.Context, db dbExecutor, profiles []store.ProfileDefinition) error {
	if len(profiles) == 0 {
		return nil
	}
	rows, err := db.QueryContext(ctx, `
		SELECT observed.profile_id, observed.transport, observed.detail, observed.learned_at
		FROM profile_codex_transports AS observed
		JOIN profiles ON profiles.id = observed.profile_id AND profiles.base_url = observed.base_url`)
	if err != nil {
		return fmt.Errorf("list codex transports: %w", err)
	}
	defer rows.Close()
	observations := map[string]store.CodexTransportObservation{}
	oldest := time.Now().Add(-store.CodexTransportObservationTTL)
	for rows.Next() {
		var profileID string
		var observation store.CodexTransportObservation
		if err := rows.Scan(&profileID, &observation.Transport, &observation.Detail, &observation.LearnedAt); err != nil {
			return fmt.Errorf("list codex transports: %w", err)
		}
		if learnedAt, err := time.Parse(time.RFC3339Nano, observation.LearnedAt); err != nil || learnedAt.Before(oldest) {
			continue
		}
		observations[profileID] = observation
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("list codex transports: %w", err)
	}
	for i := range profiles {
		if profiles[i].CodexTransport == "" {
			continue
		}
		if observation, ok := observations[profiles[i].ID]; ok {
			profiles[i].CodexTransportLearned = &observation
		}
	}
	return nil
}

// codexTransportMode is the stored choice as profiles carry it: set, auto
// by default, on a compatible Codex endpoint and on nothing else.
func codexTransportMode(profile store.ProfileDefinition, stored string) string {
	if profile.Runtime != "codex" || profile.ConnectionType != "openai_compatible" {
		return ""
	}
	switch stored {
	case store.CodexTransportWebSocket, store.CodexTransportHTTPS:
		return stored
	default:
		return store.CodexTransportAuto
	}
}
