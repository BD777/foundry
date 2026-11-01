package store

import (
	"context"
	"errors"
	"time"
)

var (
	ErrDevicePairingInvalid    = errors.New("device pairing token is invalid, expired or already used")
	ErrDeviceCredentialInvalid = errors.New("device credential is invalid or revoked")
	// ErrDevicePairingCancelled: the person cancelled, in the web, a pairing
	// that waited for them to choose to share a system account.
	ErrDevicePairingCancelled = errors.New("this pairing was cancelled in the Foundry web app")
)

// DeviceIdentity is the server's record of who a worker device is: the
// account that paired it and the machine it runs on.
type DeviceIdentity struct {
	DeviceID           string    `json:"deviceId"`
	OwnerUserID        string    `json:"ownerUserId"`
	MachineFingerprint string    `json:"-"`
	PairedAt           time.Time `json:"pairedAt"`
}

// PairDeviceInput redeems a one-time pairing token. Tokens and credentials
// arrive as SHA-256 hashes; plaintext never reaches the store.
type PairDeviceInput struct {
	TokenHash string
	// RequestedDeviceID is the worker's existing local id, kept when it is
	// free so a re-paired machine keeps its history.
	RequestedDeviceID string
	CredentialHash    string
	Now               time.Time
	// WorkerFingerprint identifies the worker's own Foundry state on its
	// system account and keys the device, so separate accounts and state
	// roots are separate devices.
	WorkerFingerprint string
	// Identity is the system account and machine the worker runs on.
	Identity DeviceAccountIdentity
	// AcceptSharedAccount: the person chose, in the terminal, to share a
	// system account other people's devices use.
	AcceptSharedAccount bool
}

// DeviceCredentialStore authenticates worker devices. One machine
// (fingerprint) has at most one device per account; pairing it again rotates
// the credential of that same device.
type DeviceCredentialStore interface {
	CreateDevicePairingToken(ctx context.Context, tokenHash, userID string, expiresAt time.Time) error
	PairDevice(ctx context.Context, input PairDeviceInput) (DeviceIdentity, error)
	ResolveDeviceCredential(ctx context.Context, credentialHash string) (DeviceIdentity, error)
	RevokeDeviceCredential(ctx context.Context, deviceID string) error
	// DeviceOwner is the account that paired the device; "" when it predates
	// device credentials.
	DeviceOwner(ctx context.Context, deviceID string) (string, error)
}
