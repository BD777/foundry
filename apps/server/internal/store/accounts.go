package store

import (
	"context"
	"errors"
	"time"
)

// Instance roles. Admins manage accounts, devices, credentials and Accept;
// members use the workspace. "Owner" is reserved for workspace roles.
const (
	RoleAdmin  = "admin"
	RoleMember = "member"
)

func ValidRole(role string) bool {
	return role == RoleAdmin || role == RoleMember
}

var (
	ErrUserNotFound        = errors.New("user not found")
	ErrUsernameTaken       = errors.New("username is already taken")
	ErrAccountsInitialized = errors.New("an admin account already exists")
	ErrLastAdmin           = errors.New("the last active admin cannot be demoted or disabled")
	ErrUserSessionInvalid  = errors.New("login session is invalid or expired")
	ErrInviteInvalid       = errors.New("invite link is invalid, expired or already used")
	ErrInviteNotFound      = errors.New("invite not found")
)

type User struct {
	ID          string     `json:"id"`
	Username    string     `json:"username"`
	DisplayName string     `json:"displayName"`
	Role        string     `json:"role"`
	DisabledAt  *time.Time `json:"disabledAt,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

func (u User) Active() bool { return u.DisabledAt == nil }

// NewUser carries an already-hashed password; the store never sees plaintext.
type NewUser struct {
	Username     string
	DisplayName  string
	Role         string
	PasswordHash string
}

type UserUpdate struct {
	DisplayName *string
	Role        *string
	Disabled    *bool
}

type Invite struct {
	ID   string `json:"id"`
	Role string `json:"role"`
	// WorkspaceID and WorkspaceRole, when set, make the new account a member
	// of that workspace on acceptance.
	WorkspaceID   string     `json:"workspaceId,omitempty"`
	WorkspaceRole string     `json:"workspaceRole,omitempty"`
	CreatedBy string     `json:"createdBy"`
	CreatedAt time.Time  `json:"createdAt"`
	ExpiresAt time.Time  `json:"expiresAt"`
	UsedBy    string     `json:"usedBy,omitempty"`
	UsedAt    *time.Time `json:"usedAt,omitempty"`
	RevokedAt *time.Time `json:"revokedAt,omitempty"`
}

// AccountStore holds Foundry's own login identities. Tokens (sessions and
// invites) arrive as SHA-256 hashes; plaintext never reaches the store.
type AccountStore interface {
	CountUsers(ctx context.Context) (int, error)
	// CreateFirstOwner succeeds only while no user exists.
	CreateFirstOwner(ctx context.Context, input NewUser) (User, error)
	CreateUser(ctx context.Context, input NewUser) (User, error)
	GetUser(ctx context.Context, id string) (User, error)
	// GetUserCredentials looks up by username (case-insensitive) and returns
	// the stored password hash for verification.
	GetUserCredentials(ctx context.Context, username string) (User, string, error)
	ListUsers(ctx context.Context) ([]User, error)
	UpdateUser(ctx context.Context, id string, update UserUpdate) (User, error)
	// SetUserPassword replaces the hash and revokes every session of the user.
	SetUserPassword(ctx context.Context, id string, passwordHash string) error

	CreateUserSession(ctx context.Context, userID, tokenHash string, expiresAt time.Time) error
	// ResolveUserSession returns the active user behind a session. When the
	// stored expiry is earlier than refreshBefore it slides to extendTo and
	// reports extended=true so the caller can refresh the cookie.
	ResolveUserSession(ctx context.Context, tokenHash string, now, refreshBefore, extendTo time.Time) (user User, extended bool, err error)
	DeleteUserSession(ctx context.Context, tokenHash string) error

	// CreateInvite stores an invite; a non-empty grant.WorkspaceID also grants
	// that workspace role on acceptance.
	CreateInvite(ctx context.Context, tokenHash string, role, createdBy string, expiresAt time.Time, grant WorkspaceGrant) (Invite, error)
	ListInvites(ctx context.Context) ([]Invite, error)
	RevokeInvite(ctx context.Context, id string) error
	// GetPendingInvite resolves an unused, unrevoked, unexpired invite.
	GetPendingInvite(ctx context.Context, tokenHash string, now time.Time) (Invite, error)
	// RedeemInvite atomically consumes the invite and creates the user with
	// the invite's role (input.Role is ignored). A workspace grant is applied
	// only while its creator still owns that workspace.
	RedeemInvite(ctx context.Context, tokenHash string, now time.Time, input NewUser) (User, error)
}

// Workspace roles, from least to most authority.
const (
	WorkspaceRoleViewer     = "viewer"
	WorkspaceRoleMember     = "member"
	WorkspaceRoleMaintainer = "maintainer"
	WorkspaceRoleOwner      = "owner"
)

func ValidWorkspaceRole(role string) bool {
	switch role {
	case WorkspaceRoleViewer, WorkspaceRoleMember, WorkspaceRoleMaintainer, WorkspaceRoleOwner:
		return true
	}
	return false
}

// WorkspaceGrant is a workspace role carried by an invite.
type WorkspaceGrant struct {
	WorkspaceID string
	Role        string
}

type WorkspaceMember struct {
	WorkspaceID string    `json:"workspaceId"`
	UserID      string    `json:"userId"`
	Role        string    `json:"role"`
	AddedBy     string    `json:"addedBy"`
	CreatedAt   time.Time `json:"createdAt"`
}

// OwnershipStore answers who may reach which workspace and device.
type OwnershipStore interface {
	// WorkspaceRolesForUser maps workspace id to the user's workspace role.
	WorkspaceRolesForUser(ctx context.Context, userID string) (map[string]string, error)
	// DevicesOwnedBy lists the device ids paired by the user.
	DevicesOwnedBy(ctx context.Context, userID string) ([]string, error)
	ListWorkspaceMembers(ctx context.Context, workspaceID string) ([]WorkspaceMember, error)
	// SetWorkspaceMember adds a member or changes their role.
	SetWorkspaceMember(ctx context.Context, workspaceID, userID, role, addedBy string) error
	// RemoveWorkspaceMember deletes a membership (ErrNotFound if none).
	RemoveWorkspaceMember(ctx context.Context, workspaceID, userID string) error
	// RunWorkspace is the workspace a run belongs to (ErrNotFound if none).
	RunWorkspace(ctx context.Context, runID string) (string, error)
}
