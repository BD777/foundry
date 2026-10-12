package sqlitestore

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
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
			updated_at TEXT NOT NULL
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_bot_routes_pairing ON feishu_bot_routes (workspace_id) WHERE kind = 'pairing'`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_bot_routes_chat ON feishu_bot_routes (app_id, chat_id) WHERE kind <> 'pairing'`,
		`CREATE INDEX IF NOT EXISTS idx_feishu_bot_routes_code ON feishu_bot_routes (pairing_code) WHERE pairing_code <> ''`,
		`CREATE INDEX IF NOT EXISTS idx_feishu_bot_routes_app ON feishu_bot_routes (app_id)`,
		`CREATE TABLE IF NOT EXISTS feishu_chat_threads (
			root_message_id TEXT PRIMARY KEY,
			workspace_id TEXT NOT NULL,
			chat_id TEXT NOT NULL,
			latest_session_id TEXT NOT NULL,
			card_message_id TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
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
	// A thread may follow an Issue instead of a chat session.
	for column, statement := range map[string]string{
		"issue_id": `ALTER TABLE feishu_chat_threads ADD COLUMN issue_id TEXT NOT NULL DEFAULT ''`,
		"reported": `ALTER TABLE feishu_chat_threads ADD COLUMN reported TEXT NOT NULL DEFAULT ''`,
	} {
		if err := s.ensureColumn(ctx, "feishu_chat_threads", column, statement); err != nil {
			return err
		}
	}
	return nil
}

const feishuRouteColumns = `id, app_id, workspace_id, kind, chat_id, chat_name, bound_user_id,
	pairing_code, pairing_code_created_by, pairing_code_expires_at, created_at, updated_at`

// qualifiedFeishuRouteColumns are feishuRouteColumns of the alias r.
const qualifiedFeishuRouteColumns = `r.id, r.app_id, r.workspace_id, r.kind, r.chat_id, r.chat_name, r.bound_user_id,
	r.pairing_code, r.pairing_code_created_by, r.pairing_code_expires_at, r.created_at, r.updated_at`

func scanFeishuRoute(row interface{ Scan(dest ...any) error }) (store.FeishuBotRoute, error) {
	var route store.FeishuBotRoute
	var kind string
	err := row.Scan(&route.ID, &route.AppID, &route.WorkspaceID, &kind, &route.ChatID, &route.ChatName, &route.BoundUserID,
		&route.PairingCode, &route.PairingCodeCreatedBy, &route.PairingCodeExpiresAt, &route.CreatedAt, &route.UpdatedAt)
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
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO feishu_bot_routes (`+feishuRouteColumns+`)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		route.ID, route.AppID, route.WorkspaceID, string(route.Kind), route.ChatID, route.ChatName, route.BoundUserID,
		route.PairingCode, route.PairingCodeCreatedBy, route.PairingCodeExpiresAt, route.CreatedAt, route.UpdatedAt); err != nil {
		return store.FeishuBotRoute{}, fmt.Errorf("save feishu bot route: %w", err)
	}
	return route, nil
}

func (s *Store) ListFeishuBotRoutes(ctx context.Context, filter store.FeishuBotRouteFilter) ([]store.FeishuBotRoute, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT `+feishuRouteColumns+` FROM feishu_bot_routes
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
	return scanFeishuRoute(s.conn().QueryRowContext(ctx, `SELECT `+feishuRouteColumns+` FROM feishu_bot_routes
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

// --- Moving the Workspace Bots of before onto Connectors apps ---------------

// Secret records of before and after the move. externalaccounts.AppSecretID
// names the second; it is spelt out here because that package's tests open
// this store.
const (
	legacyBotSecretPrefix   = "feishu:app_secret:"
	externalAppSecretPrefix = "external-app:"
)

// legacyBot is a row of workspace_feishu_bots, where a workspace's bot kept
// its own app id and (sealed separately) secret.
type legacyBot struct {
	workspaceID, appID, chatID, chatName          string
	pairingCode, pairingExpiresAt, pairingCreator string
	boundUserID, updatedAt, ownerID               string
}

// migrateWorkspaceFeishuBots moves every Workspace Bot that kept its own
// app id and secret onto a Connectors app: one app per Feishu app id
// (an existing Connectors app of that id, else a new one owned by the
// person the bot acted as), its secret resealed under the app, the app
// marked to have its secret rotated, and the workspace's pairing route
// plus its bound chat. Topic threads stay as they are: they name the
// workspace and chat, and both survive. One transaction; the old rows,
// their secrets and the table go once moved, so a second run finds
// nothing. Without a secret store the rows wait (their secrets are sealed).
func (s *Store) migrateWorkspaceFeishuBots(ctx context.Context) error {
	if s.kek.Fingerprint == "" {
		return nil
	}
	var tables int
	if err := s.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'workspace_feishu_bots'`).Scan(&tables); err != nil {
		return fmt.Errorf("inspect the workspace bots of before: %w", err)
	}
	if tables == 0 {
		return nil
	}
	for column, statement := range map[string]string{
		"pairing_code_created_by": `ALTER TABLE workspace_feishu_bots ADD COLUMN pairing_code_created_by TEXT NOT NULL DEFAULT ''`,
		"bound_user_id":           `ALTER TABLE workspace_feishu_bots ADD COLUMN bound_user_id TEXT NOT NULL DEFAULT ''`,
	} {
		if err := s.ensureColumn(ctx, "workspace_feishu_bots", column, statement); err != nil {
			return err
		}
	}
	var summary []string
	err := s.withTx(ctx, func(tx *Store) error {
		var bots []legacyBot
		if err := scanRows(ctx, tx.conn(), `SELECT b.workspace_id, b.app_id, b.chat_id, b.chat_name, b.pairing_code, b.pairing_code_expires_at,
				b.pairing_code_created_by, b.bound_user_id, b.updated_at,
				COALESCE((SELECT user_id FROM workspace_members m WHERE m.workspace_id = b.workspace_id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1), '')
			FROM workspace_feishu_bots b WHERE b.workspace_id IN (SELECT id FROM workspaces)
			ORDER BY b.updated_at DESC, b.workspace_id`, func(rows *sql.Rows) error {
			var bot legacyBot
			if err := rows.Scan(&bot.workspaceID, &bot.appID, &bot.chatID, &bot.chatName, &bot.pairingCode, &bot.pairingExpiresAt,
				&bot.pairingCreator, &bot.boundUserID, &bot.updatedAt, &bot.ownerID); err != nil {
				return err
			}
			bot.appID = strings.TrimSpace(bot.appID)
			bots = append(bots, bot)
			return nil
		}); err != nil {
			return fmt.Errorf("read the workspace bots of before: %w", err)
		}
		apps := map[string]string{}
		for _, bot := range bots {
			if bot.appID == "" {
				summary = append(summary, bot.workspaceID+": never set up, dropped")
				continue
			}
			appID, ok := apps[bot.appID]
			if !ok {
				var err error
				if appID, err = tx.connectorAppForBot(ctx, bot); err != nil {
					return err
				}
				apps[bot.appID] = appID
			}
			note, err := tx.moveBotSecret(ctx, bot, appID)
			if err != nil {
				return err
			}
			if _, err := tx.conn().ExecContext(ctx, `INSERT OR IGNORE INTO feishu_gateway_rotate_apps (app_id, noticed_at) VALUES (?, ?)`,
				appID, formatTime(time.Now())); err != nil {
				return fmt.Errorf("mark %s to have its secret rotated: %w", appID, err)
			}
			if _, err := tx.workspacePairingRoute(ctx, bot.workspaceID); errors.Is(err, store.ErrNotFound) {
				if _, err := tx.insertFeishuRoute(ctx, store.FeishuBotRoute{
					AppID: appID, WorkspaceID: bot.workspaceID, Kind: store.FeishuRoutePairing,
					PairingCode: bot.pairingCode, PairingCodeCreatedBy: bot.pairingCreator, PairingCodeExpiresAt: bot.pairingExpiresAt,
				}); err != nil {
					return err
				}
			} else if err != nil {
				return err
			}
			if bot.chatID != "" {
				if _, err := tx.conn().ExecContext(ctx, `INSERT INTO feishu_bot_routes (`+feishuRouteColumns+`)
					VALUES (?, ?, ?, 'chat', ?, ?, ?, '', '', '', ?, ?) ON CONFLICT DO NOTHING`,
					"fbr_"+uuid.NewString(), appID, bot.workspaceID, bot.chatID, bot.chatName, bot.boundUserID,
					formatTime(time.Now()), formatTime(time.Now())); err != nil {
					return fmt.Errorf("route chat %s to %s: %w", bot.chatID, bot.workspaceID, err)
				}
			}
			summary = append(summary, fmt.Sprintf("%s: app %s -> %s, chat %t%s", bot.workspaceID, bot.appID, appID, bot.chatID != "", note))
		}
		var secretIDs []string
		if err := scanRows(ctx, tx.conn(), `SELECT id FROM secret_records WHERE id LIKE ?`, func(rows *sql.Rows) error {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			secretIDs = append(secretIDs, id)
			return nil
		}, legacyBotSecretPrefix+"%"); err != nil {
			return fmt.Errorf("list the bot secrets of before: %w", err)
		}
		for _, id := range secretIDs {
			if err := tx.DeleteSecret(ctx, id); err != nil && !errors.Is(err, store.ErrNotFound) {
				return err
			}
		}
		if _, err := tx.conn().ExecContext(ctx, `DROP TABLE workspace_feishu_bots`); err != nil {
			return fmt.Errorf("drop the workspace bots of before: %w", err)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("move workspace feishu bots onto connectors apps: %w", err)
	}
	for _, line := range summary {
		log.Printf("feishu bots moved onto Connectors apps: %s", line)
	}
	return nil
}

// connectorAppForBot is the Connectors app a bot of before moves onto: the
// newest one registered for its Feishu app id, else a new one owned by the
// person the bot acted as.
func (s *Store) connectorAppForBot(ctx context.Context, bot legacyBot) (string, error) {
	existing, err := s.FeishuProviderAppsByClientID(ctx, bot.appID)
	if err != nil {
		return "", err
	}
	if len(existing) > 0 {
		return existing[0].ID, nil
	}
	owner := bot.boundUserID
	for _, candidate := range []string{bot.pairingCreator, bot.ownerID} {
		if owner == "" {
			owner = candidate
		}
	}
	app, err := s.CreateExternalProviderApp(ctx, store.ExternalProviderApp{
		Provider: "feishu", OwnerUserID: owner, Visibility: store.ExternalAppPersonal,
		Label: "Feishu Bot " + bot.appID, ClientID: bot.appID, CreatedVia: "migrated_bot",
	})
	return app.ID, err
}

// moveBotSecret reseals the bot's secret under the Connectors app, unless
// the app holds one already (the newest bot of the app came first, or the
// app was registered in Connectors). It says what it did when that is not
// a plain move.
func (s *Store) moveBotSecret(ctx context.Context, bot legacyBot, appID string) (string, error) {
	secret, err := s.GetSecret(ctx, legacyBotSecretPrefix+bot.workspaceID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && len(secret) == 0) {
		return ", no secret", nil
	}
	if err != nil {
		return "", fmt.Errorf("unseal the bot secret of %s: %w", bot.workspaceID, err)
	}
	target := externalAppSecretPrefix + appID
	held, err := s.GetSecret(ctx, target)
	switch {
	case errors.Is(err, store.ErrNotFound):
		if err := s.PutSecret(ctx, target, secret, target); err != nil {
			return "", err
		}
		return "", nil
	case err != nil:
		return "", fmt.Errorf("read the secret of %s: %w", appID, err)
	case bytes.Equal(held, secret):
		return "", nil
	default:
		return ", a different secret than the app's; kept the app's", nil
	}
}
