package store

import (
	"context"
	"time"
)

// AppStoreConnectKeyRecord is the public part of an App Store Connect API key:
// Apple's issuer and key ids. The .p8 private key is sealed separately.
type AppStoreConnectKeyRecord struct {
	AppID     string
	IssuerID  string
	KeyID     string
	RevokedAt string
	CreatedAt string
	UpdatedAt string
}

// AppStoreConnectStore keeps App Store Connect key metadata beside the generic
// external app and account records.
type AppStoreConnectStore interface {
	SaveAppStoreConnectKey(ctx context.Context, key AppStoreConnectKeyRecord) error
	GetAppStoreConnectKey(ctx context.Context, appID string) (AppStoreConnectKeyRecord, error)
	ListAppStoreConnectKeys(ctx context.Context, ownerUserID string) ([]AppStoreConnectKeyRecord, error)
	UpdateAppStoreConnectKey(ctx context.Context, app ExternalProviderApp, key AppStoreConnectKeyRecord) (ExternalProviderApp, error)
	RevokeAppStoreConnectKey(ctx context.Context, appID string, at time.Time) error
	DeleteAppStoreConnectKey(ctx context.Context, appID string) error
}
