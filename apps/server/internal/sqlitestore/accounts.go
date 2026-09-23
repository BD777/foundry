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

var _ store.AccountStore = (*Store)(nil)

func (s *Store) setupAccounts(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			username TEXT NOT NULL,
			username_key TEXT NOT NULL UNIQUE,
			display_name TEXT NOT NULL,
			role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
			password_hash TEXT NOT NULL,
			disabled_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS user_sessions (
			token_hash TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at TEXT NOT NULL,
			last_used_at TEXT NOT NULL,
			expires_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id)`,
		`CREATE TABLE IF NOT EXISTS user_invites (
			id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
			created_by TEXT NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			used_by TEXT,
			used_at TEXT,
			revoked_at TEXT
		)`,
	}
	for _, statement := range statements {
		if _, err := s.conn().ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite accounts: %w", err)
		}
	}
	if err := s.migrateAdminRole(ctx); err != nil {
		return err
	}
	for column, statement := range map[string]string{
		"workspace_id":   `ALTER TABLE user_invites ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`,
		"workspace_role": `ALTER TABLE user_invites ADD COLUMN workspace_role TEXT NOT NULL DEFAULT ''`,
	} {
		if err := s.ensureColumn(ctx, "user_invites", column, statement); err != nil {
			return err
		}
	}
	return nil
}

// migrateAdminRole renames the instance role "owner" to "admin" in databases
// created before workspace roles existed. SQLite cannot alter a CHECK
// constraint, so users and user_invites are rebuilt; foreign keys are paused
// so dropping users does not cascade into sessions and device identities.
func (s *Store) migrateAdminRole(ctx context.Context) error {
	var legacy int
	if err := s.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'table' AND name IN ('users', 'user_invites') AND sql LIKE '%''owner''%'`).Scan(&legacy); err != nil {
		return fmt.Errorf("inspect account role schema: %w", err)
	}
	if legacy == 0 {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		return fmt.Errorf("pause foreign keys: %w", err)
	}
	defer func() { _, _ = s.db.ExecContext(ctx, `PRAGMA foreign_keys = ON`) }()
	return s.withTx(ctx, func(tx *Store) error {
		statements := []string{
			`CREATE TABLE users_admin_role (
				id TEXT PRIMARY KEY,
				username TEXT NOT NULL,
				username_key TEXT NOT NULL UNIQUE,
				display_name TEXT NOT NULL,
				role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
				password_hash TEXT NOT NULL,
				disabled_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
			`INSERT INTO users_admin_role SELECT id, username, username_key, display_name,
				CASE role WHEN 'owner' THEN 'admin' ELSE role END,
				password_hash, disabled_at, created_at, updated_at FROM users`,
			`DROP TABLE users`,
			`ALTER TABLE users_admin_role RENAME TO users`,
			`CREATE TABLE user_invites_admin_role (
				id TEXT PRIMARY KEY,
				token_hash TEXT NOT NULL UNIQUE,
				role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
				created_by TEXT NOT NULL,
				created_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				used_by TEXT,
				used_at TEXT,
				revoked_at TEXT
			)`,
			`INSERT INTO user_invites_admin_role SELECT id, token_hash,
				CASE role WHEN 'owner' THEN 'admin' ELSE role END,
				created_by, created_at, expires_at, used_by, used_at, revoked_at FROM user_invites`,
			`DROP TABLE user_invites`,
			`ALTER TABLE user_invites_admin_role RENAME TO user_invites`,
		}
		for _, statement := range statements {
			if _, err := tx.conn().ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("migrate account roles: %w", err)
			}
		}
		return nil
	})
}

func usernameKey(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

const userColumns = `id, username, display_name, role, disabled_at, created_at, updated_at`

func scanUser(row interface{ Scan(...any) error }, extra ...any) (store.User, error) {
	var user store.User
	var disabledAt sql.NullString
	var createdAt, updatedAt string
	dest := append([]any{&user.ID, &user.Username, &user.DisplayName, &user.Role, &disabledAt, &createdAt, &updatedAt}, extra...)
	if err := row.Scan(dest...); err != nil {
		return store.User{}, err
	}
	user.DisabledAt = parseOptionalTime(disabledAt)
	user.CreatedAt = parseStoredTime(createdAt)
	user.UpdatedAt = parseStoredTime(updatedAt)
	return user, nil
}

func parseStoredTime(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339Nano, value)
	return parsed
}

func parseOptionalTime(value sql.NullString) *time.Time {
	if !value.Valid || value.String == "" {
		return nil
	}
	parsed := parseStoredTime(value.String)
	return &parsed
}

func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var count int
	if err := s.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&count); err != nil {
		return 0, fmt.Errorf("count users: %w", err)
	}
	return count, nil
}

func (s *Store) CreateFirstOwner(ctx context.Context, input store.NewUser) (store.User, error) {
	var created store.User
	err := s.withTx(ctx, func(tx *Store) error {
		count, err := tx.CountUsers(ctx)
		if err != nil {
			return err
		}
		if count > 0 {
			return store.ErrAccountsInitialized
		}
		input.Role = store.RoleAdmin
		created, err = tx.insertUser(ctx, input)
		if err != nil {
			return err
		}
		// Everything registered before the first account belongs to it.
		return tx.assignUnownedResources(ctx, created.ID)
	})
	return created, err
}

func (s *Store) CreateUser(ctx context.Context, input store.NewUser) (store.User, error) {
	var created store.User
	err := s.withTx(ctx, func(tx *Store) error {
		var err error
		created, err = tx.insertUser(ctx, input)
		return err
	})
	return created, err
}

// insertUser must run inside withTx so the uniqueness check and insert are
// serialized.
func (s *Store) insertUser(ctx context.Context, input store.NewUser) (store.User, error) {
	username := strings.TrimSpace(input.Username)
	key := usernameKey(username)
	if !store.ValidRole(input.Role) {
		return store.User{}, fmt.Errorf("invalid role %q", input.Role)
	}
	var exists int
	if err := s.conn().QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE username_key = ?`, key).Scan(&exists); err != nil {
		return store.User{}, fmt.Errorf("check username: %w", err)
	}
	if exists > 0 {
		return store.User{}, store.ErrUsernameTaken
	}
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		displayName = username
	}
	now := time.Now().UTC()
	id := "user_" + uuid.NewString()
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO users
		(id, username, username_key, display_name, role, password_hash, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, username, key, displayName, input.Role, input.PasswordHash, formatTime(now), formatTime(now)); err != nil {
		return store.User{}, fmt.Errorf("insert user: %w", err)
	}
	return store.User{ID: id, Username: username, DisplayName: displayName, Role: input.Role, CreatedAt: now, UpdatedAt: now}, nil
}

func (s *Store) GetUser(ctx context.Context, id string) (store.User, error) {
	user, err := scanUser(s.conn().QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return store.User{}, store.ErrUserNotFound
	}
	if err != nil {
		return store.User{}, fmt.Errorf("get user: %w", err)
	}
	return user, nil
}

func (s *Store) GetUserCredentials(ctx context.Context, username string) (store.User, string, error) {
	var hash string
	user, err := scanUser(s.conn().QueryRowContext(ctx,
		`SELECT `+userColumns+`, password_hash FROM users WHERE username_key = ?`, usernameKey(username)), &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return store.User{}, "", store.ErrUserNotFound
	}
	if err != nil {
		return store.User{}, "", fmt.Errorf("get user credentials: %w", err)
	}
	return user, hash, nil
}

func (s *Store) ListUsers(ctx context.Context) ([]store.User, error) {
	rows, err := s.conn().QueryContext(ctx, `SELECT `+userColumns+` FROM users ORDER BY created_at ASC, id ASC`)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()
	users := []store.User{}
	for rows.Next() {
		user, err := scanUser(rows)
		if err != nil {
			return nil, fmt.Errorf("scan user: %w", err)
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (s *Store) UpdateUser(ctx context.Context, id string, update store.UserUpdate) (store.User, error) {
	var updated store.User
	err := s.withTx(ctx, func(tx *Store) error {
		current, err := tx.GetUser(ctx, id)
		if err != nil {
			return err
		}
		next := current
		if update.DisplayName != nil {
			name := strings.TrimSpace(*update.DisplayName)
			if name == "" {
				return errors.New("display name must not be empty")
			}
			next.DisplayName = name
		}
		if update.Role != nil {
			if !store.ValidRole(*update.Role) {
				return fmt.Errorf("invalid role %q", *update.Role)
			}
			next.Role = *update.Role
		}
		now := time.Now().UTC()
		if update.Disabled != nil {
			if *update.Disabled && next.DisabledAt == nil {
				next.DisabledAt = &now
			} else if !*update.Disabled {
				next.DisabledAt = nil
			}
		}
		losesOwner := current.Role == store.RoleAdmin && current.Active() &&
			(next.Role != store.RoleAdmin || !next.Active())
		if losesOwner {
			var owners int
			if err := tx.conn().QueryRowContext(ctx,
				`SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled_at IS NULL`).Scan(&owners); err != nil {
				return fmt.Errorf("count owners: %w", err)
			}
			if owners <= 1 {
				return store.ErrLastAdmin
			}
		}
		var disabledAt any
		if next.DisabledAt != nil {
			disabledAt = formatTime(*next.DisabledAt)
		}
		next.UpdatedAt = now
		if _, err := tx.conn().ExecContext(ctx,
			`UPDATE users SET display_name = ?, role = ?, disabled_at = ?, updated_at = ? WHERE id = ?`,
			next.DisplayName, next.Role, disabledAt, formatTime(now), id); err != nil {
			return fmt.Errorf("update user: %w", err)
		}
		if !next.Active() {
			if _, err := tx.conn().ExecContext(ctx, `DELETE FROM user_sessions WHERE user_id = ?`, id); err != nil {
				return fmt.Errorf("revoke user sessions: %w", err)
			}
		}
		updated = next
		return nil
	})
	return updated, err
}

func (s *Store) SetUserPassword(ctx context.Context, id string, passwordHash string) error {
	return s.withTx(ctx, func(tx *Store) error {
		result, err := tx.conn().ExecContext(ctx, `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`,
			passwordHash, formatTime(time.Now().UTC()), id)
		if err != nil {
			return fmt.Errorf("set user password: %w", err)
		}
		if affected, _ := result.RowsAffected(); affected == 0 {
			return store.ErrUserNotFound
		}
		if _, err := tx.conn().ExecContext(ctx, `DELETE FROM user_sessions WHERE user_id = ?`, id); err != nil {
			return fmt.Errorf("revoke user sessions: %w", err)
		}
		return nil
	})
}

func (s *Store) CreateUserSession(ctx context.Context, userID, tokenHash string, expiresAt time.Time) error {
	now := formatTime(time.Now().UTC())
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO user_sessions
		(token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		tokenHash, userID, now, now, formatTime(expiresAt)); err != nil {
		return fmt.Errorf("create user session: %w", err)
	}
	return nil
}

func (s *Store) ResolveUserSession(ctx context.Context, tokenHash string, now, refreshBefore, extendTo time.Time) (store.User, bool, error) {
	var expiresAt string
	user, err := scanUser(s.conn().QueryRowContext(ctx, `SELECT u.id, u.username, u.display_name, u.role,
			u.disabled_at, u.created_at, u.updated_at, s.expires_at
		FROM user_sessions AS s JOIN users AS u ON u.id = s.user_id
		WHERE s.token_hash = ?`, tokenHash), &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return store.User{}, false, store.ErrUserSessionInvalid
	}
	if err != nil {
		return store.User{}, false, fmt.Errorf("resolve user session: %w", err)
	}
	expiry := parseStoredTime(expiresAt)
	if !user.Active() || !now.Before(expiry) {
		_, _ = s.conn().ExecContext(ctx, `DELETE FROM user_sessions WHERE token_hash = ?`, tokenHash)
		return store.User{}, false, store.ErrUserSessionInvalid
	}
	if !expiry.Before(refreshBefore) {
		return user, false, nil
	}
	if _, err := s.conn().ExecContext(ctx, `UPDATE user_sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?`,
		formatTime(now), formatTime(extendTo), tokenHash); err != nil {
		return store.User{}, false, fmt.Errorf("extend user session: %w", err)
	}
	return user, true, nil
}

func (s *Store) DeleteUserSession(ctx context.Context, tokenHash string) error {
	if _, err := s.conn().ExecContext(ctx, `DELETE FROM user_sessions WHERE token_hash = ?`, tokenHash); err != nil {
		return fmt.Errorf("delete user session: %w", err)
	}
	return nil
}

const inviteColumns = `id, role, workspace_id, workspace_role, created_by, created_at, expires_at, used_by, used_at, revoked_at`

func scanInvite(row interface{ Scan(...any) error }) (store.Invite, error) {
	var invite store.Invite
	var createdAt, expiresAt string
	var usedBy, usedAt, revokedAt sql.NullString
	if err := row.Scan(&invite.ID, &invite.Role, &invite.WorkspaceID, &invite.WorkspaceRole, &invite.CreatedBy, &createdAt, &expiresAt, &usedBy, &usedAt, &revokedAt); err != nil {
		return store.Invite{}, err
	}
	invite.CreatedAt = parseStoredTime(createdAt)
	invite.ExpiresAt = parseStoredTime(expiresAt)
	invite.UsedBy = usedBy.String
	invite.UsedAt = parseOptionalTime(usedAt)
	invite.RevokedAt = parseOptionalTime(revokedAt)
	return invite, nil
}

func (s *Store) CreateInvite(ctx context.Context, tokenHash string, role, createdBy string, expiresAt time.Time, grant store.WorkspaceGrant) (store.Invite, error) {
	if !store.ValidRole(role) {
		return store.Invite{}, fmt.Errorf("invalid role %q", role)
	}
	if grant.WorkspaceID != "" && !store.ValidWorkspaceRole(grant.Role) {
		return store.Invite{}, fmt.Errorf("invalid workspace role %q", grant.Role)
	}
	now := time.Now().UTC()
	invite := store.Invite{ID: "inv_" + uuid.NewString(), Role: role, CreatedBy: createdBy, CreatedAt: now, ExpiresAt: expiresAt.UTC()}
	if grant.WorkspaceID != "" {
		invite.WorkspaceID, invite.WorkspaceRole = grant.WorkspaceID, grant.Role
	}
	if _, err := s.conn().ExecContext(ctx, `INSERT INTO user_invites
		(id, token_hash, role, workspace_id, workspace_role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		invite.ID, tokenHash, role, invite.WorkspaceID, invite.WorkspaceRole, createdBy, formatTime(now), formatTime(invite.ExpiresAt)); err != nil {
		return store.Invite{}, fmt.Errorf("create invite: %w", err)
	}
	return invite, nil
}

func (s *Store) ListInvites(ctx context.Context) ([]store.Invite, error) {
	rows, err := s.conn().QueryContext(ctx, `SELECT `+inviteColumns+` FROM user_invites ORDER BY created_at DESC, id ASC`)
	if err != nil {
		return nil, fmt.Errorf("list invites: %w", err)
	}
	defer rows.Close()
	invites := []store.Invite{}
	for rows.Next() {
		invite, err := scanInvite(rows)
		if err != nil {
			return nil, fmt.Errorf("scan invite: %w", err)
		}
		invites = append(invites, invite)
	}
	return invites, rows.Err()
}

func (s *Store) RevokeInvite(ctx context.Context, id string) error {
	result, err := s.conn().ExecContext(ctx,
		`UPDATE user_invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
		formatTime(time.Now().UTC()), id)
	if err != nil {
		return fmt.Errorf("revoke invite: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return store.ErrInviteNotFound
	}
	return nil
}

func (s *Store) GetPendingInvite(ctx context.Context, tokenHash string, now time.Time) (store.Invite, error) {
	invite, err := scanInvite(s.conn().QueryRowContext(ctx,
		`SELECT `+inviteColumns+` FROM user_invites WHERE token_hash = ?`, tokenHash))
	if errors.Is(err, sql.ErrNoRows) {
		return store.Invite{}, store.ErrInviteInvalid
	}
	if err != nil {
		return store.Invite{}, fmt.Errorf("get invite: %w", err)
	}
	if invite.UsedAt != nil || invite.RevokedAt != nil || !now.Before(invite.ExpiresAt) {
		return store.Invite{}, store.ErrInviteInvalid
	}
	return invite, nil
}

func (s *Store) RedeemInvite(ctx context.Context, tokenHash string, now time.Time, input store.NewUser) (store.User, error) {
	var created store.User
	err := s.withTx(ctx, func(tx *Store) error {
		invite, err := tx.GetPendingInvite(ctx, tokenHash, now)
		if err != nil {
			return err
		}
		input.Role = invite.Role
		created, err = tx.insertUser(ctx, input)
		if err != nil {
			return err
		}
		if _, err := tx.conn().ExecContext(ctx, `UPDATE user_invites SET used_by = ?, used_at = ? WHERE id = ?`,
			created.ID, formatTime(now), invite.ID); err != nil {
			return fmt.Errorf("consume invite: %w", err)
		}
		if invite.WorkspaceID == "" {
			return nil
		}
		roles, err := tx.WorkspaceRolesForUser(ctx, invite.CreatedBy)
		if err != nil {
			return err
		}
		if roles[invite.WorkspaceID] != store.WorkspaceRoleOwner {
			return nil
		}
		return tx.SetWorkspaceMember(ctx, invite.WorkspaceID, created.ID, invite.WorkspaceRole, invite.CreatedBy)
	})
	return created, err
}
