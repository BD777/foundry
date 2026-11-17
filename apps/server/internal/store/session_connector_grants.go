package store

import "context"

// SessionConnectorGrant is server-side state attached to a session (DEV-265):
// one object on one connector account the session may write without the
// person's confirmation. A session created by a granted session inherits its
// grants through the parent chain. Grants are never shown to the agent.
type SessionConnectorGrant struct {
	SessionID  string `json:"sessionId"`
	AccountID  string `json:"accountId"`
	ObjectType string `json:"type"`
	ObjectID   string `json:"id"`
	// Label names the object for the person, e.g. a conversation's name.
	Label string `json:"label,omitempty"`
}

// SessionConnectorGrantStore keeps session grants.
type SessionConnectorGrantStore interface {
	SessionConnectorGrants(ctx context.Context, sessionID string) ([]SessionConnectorGrant, error)
	// SetSessionConnectorGrants replaces what sessionID may write on
	// accountID; grants of other accounts stay.
	SetSessionConnectorGrants(ctx context.Context, sessionID, accountID string, grants []SessionConnectorGrant) error
}
