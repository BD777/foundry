package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// An item homed in its assistant's own workspace is in the assistant's inbox:
// the inbox is the assistant's home, so both name one place and the store
// keeps one form of it, "" (DEV-324 items page filters).
const (
	itemAssistantHomeMigration = "item-assistant-home-inbox"
	itemAssistantHomeVersion   = 1
)

// itemHome is the home to store for an item of assistantID: "" when home is
// the assistant's own workspace, else home.
func (s *Store) itemHome(ctx context.Context, assistantID, home string) (string, error) {
	if home == "" {
		return "", nil
	}
	var assistantHome string
	err := s.conn().QueryRowContext(ctx, `SELECT home_workspace_id FROM assistants WHERE id = ?`, assistantID).Scan(&assistantHome)
	if errors.Is(err, sql.ErrNoRows) {
		return home, nil
	}
	if err != nil {
		return "", fmt.Errorf("read the assistant's home: %w", err)
	}
	if home == assistantHome {
		return "", nil
	}
	return home, nil
}

// migrateItemAssistantHomes moves the items stored with their assistant's
// own workspace as home to the inbox, once per database. Only the home
// changes: no revision, time or event, since the item stays where it was.
func (s *Store) migrateItemAssistantHomes(ctx context.Context) error {
	return s.runDataMigration(ctx, itemAssistantHomeMigration, itemAssistantHomeVersion, func(tx *Store) error {
		_, err := tx.conn().ExecContext(ctx, `UPDATE pa_items SET home_workspace_id = ''
			WHERE home_workspace_id <> '' AND home_workspace_id = (SELECT home_workspace_id FROM assistants WHERE assistants.id = pa_items.assistant_id)`)
		return err
	})
}
