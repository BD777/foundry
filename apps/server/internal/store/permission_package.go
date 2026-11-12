package store

import "context"

const (
	ConnectorAccessLevelOff   = "off"
	ConnectorAccessLevelRead  = "read"
	ConnectorAccessLevelWrite = "write"
)

// PermissionListRule.Scope: all (also when empty) or only the listed ids.
const (
	PermissionListScopeAll    = "all"
	PermissionListScopeListed = "listed"
)

// PermissionPackageStore keeps each assistant's permission package. The
// package is the one source of what that assistant may reach; workspace and
// skill rules with an empty include list mean every object the person already
// has access to.
type PermissionPackageStore interface {
	GetPermissionPackage(ctx context.Context, ownerUserID, id string) (PermissionPackage, error)
	SavePermissionPackage(ctx context.Context, pkg PermissionPackage) (PermissionPackage, error)
}
