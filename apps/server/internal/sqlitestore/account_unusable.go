package sqlitestore

import (
	"context"
	"fmt"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// accountUnusableLayout is fixed width, so the text columns sort as times do.
const accountUnusableLayout = "2006-01-02T15:04:05.000000000Z"

func (s *Store) RecordAccountUnusable(ctx context.Context, observation store.AccountUnusableObservation) error {
	_, err := s.conn().ExecContext(ctx, `INSERT INTO account_unusable_observations
		(runtime, profile_id, session_id, reason, observed_at, cooldown_until) VALUES (?, ?, ?, ?, ?, ?)`,
		observation.Runtime, observation.ProfileID, observation.SessionID, observation.Reason,
		observation.ObservedAt.UTC().Format(accountUnusableLayout), observation.CooldownUntil.UTC().Format(accountUnusableLayout))
	if err != nil {
		return fmt.Errorf("record account unusable of %s/%s: %w", observation.Runtime, observation.ProfileID, err)
	}
	return nil
}

func (s *Store) AccountUnusableSince(ctx context.Context, since, now time.Time) ([]store.AccountUnusableObservation, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT runtime, profile_id, session_id, reason, observed_at, cooldown_until
		FROM account_unusable_observations WHERE observed_at >= ? OR cooldown_until > ? ORDER BY observed_at`,
		since.UTC().Format(accountUnusableLayout), now.UTC().Format(accountUnusableLayout))
	if err != nil {
		return nil, fmt.Errorf("list account unusable observations: %w", err)
	}
	defer rows.Close()
	var observations []store.AccountUnusableObservation
	for rows.Next() {
		var observation store.AccountUnusableObservation
		var observed, cooldown string
		if err := rows.Scan(&observation.Runtime, &observation.ProfileID, &observation.SessionID,
			&observation.Reason, &observed, &cooldown); err != nil {
			return nil, fmt.Errorf("scan account unusable observation: %w", err)
		}
		if observation.ObservedAt, err = time.Parse(accountUnusableLayout, observed); err != nil {
			return nil, fmt.Errorf("parse account unusable time %q: %w", observed, err)
		}
		if observation.CooldownUntil, err = time.Parse(accountUnusableLayout, cooldown); err != nil {
			return nil, fmt.Errorf("parse account unusable cooldown %q: %w", cooldown, err)
		}
		observations = append(observations, observation)
	}
	return observations, rows.Err()
}

var _ store.AccountUnusableStore = (*Store)(nil)
