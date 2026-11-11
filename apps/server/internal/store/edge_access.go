package store

import (
	"context"
	"errors"
)

// EdgeAccessStore keeps the metadata of a person's edge access credentials
// (see contracts/models/edge_access.yaml). The client id and secret are not
// here: the secret store seals them under the credential id.
type EdgeAccessStore interface {
	ListEdgeAccess(ctx context.Context, ownerUserID string) ([]EdgeAccess, error)
	GetEdgeAccess(ctx context.Context, ownerUserID, id string) (EdgeAccess, error)
	// SaveEdgeAccess inserts or updates by id; ErrEdgeAccessConflict when
	// another credential of the owner has the same host and path prefix.
	SaveEdgeAccess(ctx context.Context, ownerUserID string, item EdgeAccess) error
	DeleteEdgeAccess(ctx context.Context, ownerUserID, id string) error
	TouchEdgeAccess(ctx context.Context, ownerUserID, id, usedAt string) error
}

// ErrEdgeAccessConflict: the owner already has a credential for this host and path prefix.
var ErrEdgeAccessConflict = errors.New("an edge access credential for this address already exists")
