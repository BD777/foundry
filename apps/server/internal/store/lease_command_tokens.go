package store

import "context"

// LeaseCommandTokenStore mints the token a session hands the commands that
// use one of its compute leases.
type LeaseCommandTokenStore interface {
	// MintLeaseCommandToken returns a one-time plaintext bearer token that
	// acts for the session on one resource lease only.
	MintLeaseCommandToken(ctx context.Context, sessionID, leaseID string) (string, error)
}
