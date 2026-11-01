package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/google/uuid"
)

var _ store.FeishuBotStore = (*Store)(nil)

// setupFeishu creates the Workspace Bots' tables: the routes that send a
// Connectors Feishu app's events to workspaces, the topic threads the bots
// follow, and the event ids already routed (so a redelivery after a restart
// is not routed twice).
func (s *Store) setupFeishu(ctx context.Context) error {
	statements := []string{
		// A chat's name is refreshed from Feishu; the last check and why it
		// failed are kept (chat_name_checked_at, chat_name_error), and a
		// direct chat's other person names it (peer_open_id).
		`CREATE TABLE IF NOT EXISTS feishu_bot_routes (
			id TEXT PRIMARY KEY,
			app_id TEXT NOT NULL REFERENCES external_provider_apps(id) ON DELETE CASCADE,
			workspace_id TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('pairing', 'chat', 'p2p')),
			chat_id TEXT NOT NULL DEFAULT '',
			chat_name TEXT NOT NULL DEFAULT '',
			bound_user_id TEXT NOT NULL DEFAULT '',
			pairing_code TEXT NOT NULL DEFAULT '',
			pairing_code_created_by TEXT NOT NULL DEFAULT '',
			pairing_code_expires_at TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			chat_name_checked_at TEXT NOT NULL DEFAULT '',
			chat_name_error TEXT NOT NULL DEFAULT '',
			peer_open_id TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_bot_routes_pairing ON feishu_bot_routes (workspace_id) WHERE kind = 'pairing'`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_bot_routes_chat ON feishu_bot_routes (app_id, chat_id) WHERE kind <> 'pairing'`,
		`CREATE INDEX IF NOT EXISTS idx_feishu_bot_routes_code ON feishu_bot_routes (pairing_code) WHERE pairing_code <> ''`,
		`CREATE INDEX IF NOT EXISTS idx_feishu_bot_routes_app ON feishu_bot_routes (app_id)`,
		// A thread may follow an Issue (issue_id) instead of a chat session.
		`CREATE TABLE IF NOT EXISTS feishu_chat_threads (
			root_message_id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			chat_id TEXT NOT NULL,
			latest_session_id TEXT NOT NULL,
			card_message_id TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			issue_id TEXT NOT NULL DEFAULT '',
			reported TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_feishu_chat_threads_session ON feishu_chat_threads (latest_session_id)`,
		// received_ms orders numerically; the rows expire with the window.
		`CREATE TABLE IF NOT EXISTS feishu_event_receipts (
			app_id TEXT NOT NULL,
			event_id TEXT NOT NULL,
			received_ms INTEGER NOT NULL,
			PRIMARY KEY (app_id, event_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_feishu_event_receipts_received ON feishu_event_receipts (received_ms)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite feishu: %w", err)
		}
	}
	return nil
}

const feishuRouteColumns = `id, app_id, workspace_id, kind, chat_id, chat_name, bound_user_id,
	pairing_code, pairing_code_created_by, pairing_code_expires_at, created_at, updated_at`

// feishuRouteReadColumns are feishuRouteColumns plus what a route learns
// after it is inserted.
const feishuRouteReadColumns = feishuRouteColumns + `, chat_name_checked_at, chat_name_error, peer_open_id`

// qualifiedFeishuRouteColumns are feishuRouteReadColumns of the alias r.
const qualifiedFeishuRouteColumns = `r.id, r.app_id, r.workspace_id, r.kind, r.chat_id, r.chat_name, r.bound_user_id,
	r.pairing_code, r.pairing_code_created_by, r.pairing_code_expires_at, r.created_at, r.updated_at,
	r.chat_name_checked_at, r.chat_name_error, r.peer_open_id`

func scanFeishuRoute(row interface{ Scan(dest ...any) error }) (store.FeishuBotRoute, error) {
	var route store.FeishuBotRoute
	var kind string
	err := row.Scan(&route.ID, &route.AppID, &route.WorkspaceID, &kind, &route.ChatID, &route.ChatName, &route.BoundUserID,
		&route.PairingCode, &route.PairingCodeCreatedBy, &route.PairingCodeExpiresAt, &route.CreatedAt, &route.UpdatedAt,
		&route.ChatNameCheckedAt, &route.ChatNameError, &route.PeerOpenID)
	route.Kind = store.FeishuRouteKind(kind)
	if errors.Is(err, sql.ErrNoRows) {
		return store.FeishuBotRoute{}, store.ErrNotFound
	}
	return route, err
}

func (s *Store) insertFeishuRoute(ctx context.Context, route store.FeishuBotRoute) (store.FeishuBotRoute, error) {
	if route.ID == "" {
		route.ID = "fbr_" + uuid.NewString()
	}
	now := formatTime(time.Now())
	if route.CreatedAt == "" {
		route.CreatedAt = now
	}
	route.UpdatedAt = now
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO feishu_bot_routes (`+feishuRouteReadColumns+`)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		route.ID, route.AppID, route.WorkspaceID, string(route.Kind), route.ChatID, route.ChatName, route.BoundUserID,
		route.PairingCode, route.PairingCodeCreatedBy, route.PairingCodeExpiresAt, route.CreatedAt, route.UpdatedAt,
		route.ChatNameCheckedAt, route.ChatNameError, route.PeerOpenID); err != nil {
		return store.FeishuBotRoute{}, fmt.Errorf("save feishu bot route: %w", err)
	}
	return route, nil
}

func (s *Store) ListFeishuBotRoutes(ctx context.Context, filter store.FeishuBotRouteFilter) ([]store.FeishuBotRoute, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+feishuRouteReadColumns+` FROM feishu_bot_routes
		WHERE (?1 = '' OR workspace_id = ?1) AND (?2 = '' OR app_id = ?2)
		ORDER BY workspace_id, kind <> 'pairing', created_at, id`, filter.WorkspaceID, filter.AppID)
	if err != nil {
		return nil, fmt.Errorf("list feishu bot routes: %w", err)
	}
	defer rows.Close()
	routes := []store.FeishuBotRoute{}
	for rows.Next() {
		route, err := scanFeishuRoute(rows)
		if err != nil {
			return nil, err
		}
		routes = append(routes, route)
	}
	return routes, rows.Err()
}

func (s *Store) workspacePairingRoute(ctx context.Context, workspaceID string) (store.FeishuBotRoute, error) {
	return scanFeishuRoute(s.conn().QueryRowContext(ctx, `SELECT `+feishuRouteReadColumns+` FROM feishu_bot_routes
		WHERE workspace_id = ? AND kind = 'pairing'`, workspaceID))
}

func (s *Store) feishuClientID(ctx context.Context, appID string) (string, error) {
	var clientID string
	err := s.conn().QueryRowContext(ctx, `SELECT client_id FROM external_provider_apps WHERE id = ?`, appID).Scan(&clientID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", store.ErrExternalAppNotFound
	}
	return clientID, err
}

func (s *Store) SetWorkspaceFeishuBotApp(ctx context.Context, workspaceID, appID string) error {
	return s.withTx(ctx, func(tx *Store) error {
		next, err := tx.feishuClientID(ctx, appID)
		if err != nil {
			return err
		}
		pairing, err := tx.workspacePairingRoute(ctx, workspaceID)
		if errors.Is(err, store.ErrNotFound) {
			_, err = tx.insertFeishuRoute(ctx, store.FeishuBotRoute{AppID: appID, WorkspaceID: workspaceID, Kind: store.FeishuRoutePairing})
			return err
		}
		if err != nil || pairing.AppID == appID {
			return err
		}
		now := formatTime(time.Now())
		if previous, err := tx.feishuClientID(ctx, pairing.AppID); err != nil || previous != next {
			if _, err := tx.conn().ExecContext(ctx, `DELETE FROM feishu_bot_routes WHERE workspace_id = ? AND kind <> 'pairing'`, workspaceID); err != nil {
				return fmt.Errorf("unbind the chats of the previous feishu app: %w", err)
			}
			if _, err := tx.conn().ExecContext(ctx, `UPDATE feishu_bot_routes SET pairing_code = '', pairing_code_created_by = '',
				pairing_code_expires_at = '' WHERE id = ?`, pairing.ID); err != nil {
				return fmt.Errorf("drop the pairing code of the previous feishu app: %w", err)
			}
		}
		if _, err := tx.conn().ExecContext(ctx, `UPDATE feishu_bot_routes SET app_id = ?, updated_at = ? WHERE workspace_id = ?`,
			appID, now, workspaceID); err != nil {
			return fmt.Errorf("move the workspace bot to app %s: %w", appID, err)
		}
		return nil
	})
}

func (s *Store) DeleteWorkspaceFeishuBot(ctx context.Context, workspaceID string) error {
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM feishu_bot_routes WHERE workspace_id = ?`, workspaceID); err != nil {
		return fmt.Errorf("delete feishu bot of %s: %w", workspaceID, err)
	}
	return nil
}

func (s *Store) SetFeishuPairingCode(ctx context.Context, workspaceID, codeHash, createdBy, expiresAt string) (store.FeishuBotRoute, error) {
	result, err := s.conn().ExecContext(ctx, `UPDATE feishu_bot_routes SET pairing_code = ?, pairing_code_created_by = ?,
		pairing_code_expires_at = ?, updated_at = ? WHERE workspace_id = ? AND kind = 'pairing'`,
		strings.TrimSpace(codeHash), createdBy, expiresAt, formatTime(time.Now()), workspaceID)
	if err != nil {
		return store.FeishuBotRoute{}, fmt.Errorf("set feishu pairing code of %s: %w", workspaceID, err)
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return store.FeishuBotRoute{}, store.ErrNotFound
	}
	return s.workspacePairingRoute(ctx, workspaceID)
}

func (s *Store) FindFeishuPairingRoute(ctx context.Context, clientID, codeHash string) (store.FeishuBotRoute, error) {
	codeHash = strings.TrimSpace(codeHash)
	if codeHash == "" || clientID == "" {
		return store.FeishuBotRoute{}, store.ErrNotFound
	}
	return scanFeishuRoute(s.reader().QueryRowContext(ctx, `SELECT `+qualifiedFeishuRouteColumns+`
		FROM feishu_bot_routes r JOIN external_provider_apps a ON a.id = r.app_id
		WHERE r.kind = 'pairing' AND r.pairing_code = ? AND a.client_id = ?`, codeHash, clientID))
}

func (s *Store) FindFeishuChatRoute(ctx context.Context, clientID, chatID string) (store.FeishuBotRoute, error) {
	if chatID == "" || clientID == "" {
		return store.FeishuBotRoute{}, store.ErrNotFound
	}
	return scanFeishuRoute(s.reader().QueryRowContext(ctx, `SELECT `+qualifiedFeishuRouteColumns+`
		FROM feishu_bot_routes r JOIN external_provider_apps a ON a.id = r.app_id
		WHERE r.kind <> 'pairing' AND r.chat_id = ? AND a.client_id = ?
		ORDER BY r.updated_at DESC LIMIT 1`, chatID, clientID))
}

func (s *Store) BindFeishuChat(ctx context.Context, pairing store.FeishuBotRoute, chat store.FeishuBotRoute) (store.FeishuBotRoute, error) {
	if pairing.PairingCode == "" || chat.ChatID == "" || (chat.Kind != store.FeishuRouteChat && chat.Kind != store.FeishuRouteP2P) {
		return store.FeishuBotRoute{}, errors.New("bind a feishu chat: a spent code, or not a chat")
	}
	var bound store.FeishuBotRoute
	err := s.withTx(ctx, func(tx *Store) error {
		result, err := tx.conn().ExecContext(ctx, `UPDATE feishu_bot_routes SET pairing_code = '', pairing_code_created_by = '',
			pairing_code_expires_at = '', updated_at = ? WHERE id = ? AND kind = 'pairing' AND pairing_code = ?`,
			formatTime(time.Now()), pairing.ID, pairing.PairingCode)
		if err != nil {
			return fmt.Errorf("spend the feishu pairing code: %w", err)
		}
		if changed, _ := result.RowsAffected(); changed == 0 {
			return store.ErrNotFound
		}
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM feishu_bot_routes WHERE kind <> 'pairing' AND chat_id = ?
			AND app_id IN (SELECT id FROM external_provider_apps WHERE client_id = (SELECT client_id FROM external_provider_apps WHERE id = ?))`,
			chat.ChatID, pairing.AppID); err != nil {
			return fmt.Errorf("unroute the chat from where it went before: %w", err)
		}
		chat.ID, chat.AppID, chat.WorkspaceID = "", pairing.AppID, pairing.WorkspaceID
		chat.PairingCode, chat.PairingCodeCreatedBy, chat.PairingCodeExpiresAt = "", "", ""
		bound, err = tx.insertFeishuRoute(ctx, chat)
		return err
	})
	return bound, err
}

func (s *Store) DeleteFeishuBotRoute(ctx context.Context, workspaceID, routeID string) error {
	result, err := s.conn().ExecContext(ctx, `DELETE FROM feishu_bot_routes WHERE id = ? AND workspace_id = ? AND kind <> 'pairing'`, routeID, workspaceID)
	if err != nil {
		return fmt.Errorf("unbind feishu chat route %s: %w", routeID, err)
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) RecordFeishuChatName(ctx context.Context, routeID, name, failure string, checkedAt time.Time) error {
	result, err := s.conn().ExecContext(ctx, `UPDATE feishu_bot_routes
		SET chat_name = CASE WHEN ?2 = '' AND ?3 <> '' THEN ?3 ELSE chat_name END,
			chat_name_error = ?2, chat_name_checked_at = ?4
		WHERE id = ?1 AND kind <> 'pairing'`, routeID, failure, name, formatTime(checkedAt))
	if err != nil {
		return fmt.Errorf("record the name of feishu chat route %s: %w", routeID, err)
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (s *Store) SetFeishuChatPeer(ctx context.Context, routeID, openID string) error {
	if _, err := s.conn().ExecContext(ctx, `UPDATE feishu_bot_routes SET peer_open_id = ? WHERE id = ? AND kind = 'p2p'`,
		openID, routeID); err != nil {
		return fmt.Errorf("record the other person of feishu chat route %s: %w", routeID, err)
	}
	return nil
}

func (s *Store) FeishuProviderAppsByClientID(ctx context.Context, clientID string) ([]store.ExternalProviderApp, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+externalAppColumns+` FROM external_provider_apps
		WHERE provider = 'feishu' AND client_id = ? ORDER BY updated_at DESC, created_at DESC`, clientID)
	if err != nil {
		return nil, fmt.Errorf("list feishu apps of %s: %w", clientID, err)
	}
	defer rows.Close()
	apps := []store.ExternalProviderApp{}
	for rows.Next() {
		app, err := scanExternalApp(rows)
		if err != nil {
			return nil, fmt.Errorf("scan external provider app: %w", err)
		}
		apps = append(apps, app)
	}
	return apps, rows.Err()
}

func (s *Store) RecordFeishuEvent(ctx context.Context, appID, eventID string, at time.Time, ttl time.Duration) (bool, error) {
	if eventID == "" {
		return true, nil
	}
	first := false
	err := s.withTx(ctx, func(tx *Store) error {
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM feishu_event_receipts WHERE received_ms < ?`, at.Add(-ttl).UnixMilli()); err != nil {
			return fmt.Errorf("forget old feishu events: %w", err)
		}
		result, err := tx.conn().ExecContext(ctx, `INSERT INTO feishu_event_receipts (app_id, event_id, received_ms) VALUES (?, ?, ?)
			ON CONFLICT (app_id, event_id) DO NOTHING`, appID, eventID, at.UnixMilli())
		if err != nil {
			return fmt.Errorf("record feishu event: %w", err)
		}
		inserted, _ := result.RowsAffected()
		first = inserted == 1
		return nil
	})
	return first, err
}

func (s *Store) GetFeishuChatThread(ctx context.Context, rootMessageID string) (store.FeishuChatThread, error) {
	row := s.conn().QueryRowContext(ctx, `
		SELECT `+feishuThreadColumns+`
		FROM feishu_chat_threads WHERE root_message_id = ?`, rootMessageID)
	return scanFeishuThread(row)
}

// FeishuThreadForIssue is the thread following the Issue, the newest if a
// thread was started for it again.
func (s *Store) FeishuThreadForIssue(ctx context.Context, issueID string) (store.FeishuChatThread, error) {
	row := s.conn().QueryRowContext(ctx, `
		SELECT `+feishuThreadColumns+`
		FROM feishu_chat_threads WHERE issue_id = ? ORDER BY created_at DESC LIMIT 1`, issueID)
	return scanFeishuThread(row)
}

const feishuThreadColumns = `root_message_id, workspace_id, chat_id, latest_session_id, card_message_id, issue_id, reported, created_at, updated_at`

func scanFeishuThread(row *sql.Row) (store.FeishuChatThread, error) {
	var thread store.FeishuChatThread
	err := row.Scan(&thread.RootMessageID, &thread.WorkspaceID, &thread.ChatID, &thread.LatestSessionID, &thread.CardMessageID, &thread.IssueID, &thread.Reported, &thread.CreatedAt, &thread.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return store.FeishuChatThread{}, store.ErrNotFound
	}
	if err != nil {
		return store.FeishuChatThread{}, err
	}
	return thread, nil
}

func (s *Store) SaveFeishuChatThread(ctx context.Context, thread store.FeishuChatThread) error {
	now := formatTime(time.Now())
	if thread.CreatedAt == "" {
		thread.CreatedAt = now
	}
	thread.UpdatedAt = now
	_, err := s.conn().ExecContext(ctx, `
		INSERT INTO feishu_chat_threads (`+feishuThreadColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(root_message_id) DO UPDATE SET
			workspace_id = excluded.workspace_id,
			chat_id = excluded.chat_id,
			latest_session_id = excluded.latest_session_id,
			card_message_id = excluded.card_message_id,
			issue_id = excluded.issue_id,
			reported = excluded.reported,
			updated_at = excluded.updated_at`,
		thread.RootMessageID, thread.WorkspaceID, thread.ChatID, thread.LatestSessionID, thread.CardMessageID, thread.IssueID, thread.Reported, thread.CreatedAt, thread.UpdatedAt)
	if err != nil {
		return fmt.Errorf("save feishu chat thread %s: %w", thread.RootMessageID, err)
	}
	return nil
}
