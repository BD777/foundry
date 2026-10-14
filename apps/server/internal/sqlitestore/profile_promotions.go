package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// setupProfilePromotions records which server profile each promoted device
// provider became, so promoting it again updates that profile. A row whose
// profile was deleted is ignored and replaced by the next promotion.
func (s *Store) setupProfilePromotions(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS profile_promotions (
			profile_id TEXT PRIMARY KEY,
			device_id TEXT NOT NULL,
			source_profile_id TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE (device_id, source_profile_id)
		)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite profile promotions: %w", err)
		}
	}
	return nil
}

func (s *Store) ProfilePromotionFor(ctx context.Context, deviceID string, sourceProfileID string) (string, error) {
	var profileID string
	err := s.conn().QueryRowContext(ctx, `
		SELECT promotion.profile_id FROM profile_promotions AS promotion
		JOIN profiles ON profiles.id = promotion.profile_id
		WHERE promotion.device_id = ? AND promotion.source_profile_id = ?`,
		strings.TrimSpace(deviceID), strings.TrimSpace(sourceProfileID)).Scan(&profileID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", store.ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("load profile promotion: %w", err)
	}
	return profileID, nil
}

// SaveProfilePromotion keeps one row per device provider and one per profile:
// whatever either side pointed at before is replaced.
func (s *Store) SaveProfilePromotion(ctx context.Context, promotion store.ProfilePromotion) error {
	profileID := strings.TrimSpace(promotion.ProfileID)
	deviceID := strings.TrimSpace(promotion.DeviceID)
	sourceID := strings.TrimSpace(promotion.SourceProfileID)
	if profileID == "" || deviceID == "" || sourceID == "" {
		return errors.New("profile promotion needs a profile, a device and a source profile")
	}
	return s.withTx(ctx, func(tx *Store) error {
		if _, err := tx.conn().ExecContext(ctx,
			`DELETE FROM profile_promotions WHERE profile_id = ? OR (device_id = ? AND source_profile_id = ?)`,
			profileID, deviceID, sourceID); err != nil {
			return fmt.Errorf("replace profile promotion: %w", err)
		}
		if _, err := tx.conn().ExecContext(ctx,
			`INSERT INTO profile_promotions (profile_id, device_id, source_profile_id, updated_at) VALUES (?, ?, ?, ?)`,
			profileID, deviceID, sourceID, formatTime(time.Now())); err != nil {
			return fmt.Errorf("save profile promotion: %w", err)
		}
		return nil
	})
}

// attachProfilePromotions fills PromotedFrom on the profiles that were
// promoted from a device provider.
func attachProfilePromotions(ctx context.Context, db dbExecutor, profiles []store.ProfileDefinition) error {
	if len(profiles) == 0 {
		return nil
	}
	rows, err := db.QueryContext(ctx, `SELECT profile_id, device_id, source_profile_id FROM profile_promotions`)
	if err != nil {
		return fmt.Errorf("list profile promotions: %w", err)
	}
	defer rows.Close()
	sources := map[string]store.ProfilePromotionSource{}
	for rows.Next() {
		var profileID string
		var source store.ProfilePromotionSource
		if err := rows.Scan(&profileID, &source.DeviceID, &source.ProfileID); err != nil {
			return fmt.Errorf("list profile promotions: %w", err)
		}
		sources[profileID] = source
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("list profile promotions: %w", err)
	}
	for i := range profiles {
		source, ok := sources[profiles[i].ID]
		if !ok {
			continue
		}
		source.DeviceBound = store.LoopbackBaseURL(profiles[i].BaseURL)
		profiles[i].PromotedFrom = &source
	}
	return nil
}
