package store

import (
	"context"
	"fmt"
	"strings"
)

// Several people on one computer account (docs/devices-and-workspaces.md,
// "一台电脑上的几个人"). A worker reports a fingerprint of the system account
// it runs under; one account belongs to one owner by default, and a second
// person pairs under it only after choosing to share it. Nothing here keeps
// anyone apart. Mirrors packages/protocol/src/device-sharing.ts.

// DeviceAccountShare is another person's device under the same system
// account of the same computer (DeviceProjection.SharesSystemAccountWith).
type DeviceAccountShare struct {
	DeviceID    string `json:"deviceId"`
	DeviceLabel string `json:"deviceLabel"`
	OwnerName   string `json:"ownerName"`
	// AcceptedAt is when, pairing the later device, someone chose to share;
	// empty when Foundry found the shared account later.
	AcceptedAt string `json:"acceptedAt,omitempty"`
	AcceptedBy string `json:"acceptedBy,omitempty"`
	// NoticePending: the device was there first and its owner has not
	// dismissed the notice that someone else now shares its account.
	NoticePending bool `json:"noticePending,omitempty"`
}

// Pairing token states (DevicePairingStatus.State).
const (
	DevicePairingWaiting      = "waiting"
	DevicePairingNeedsConsent = "needs_consent"
	DevicePairingPaired       = "paired"
	DevicePairingCancelled    = "cancelled"
	DevicePairingExpired      = "expired"
)

// DevicePairingStatus is where a pairing token stands.
type DevicePairingStatus struct {
	State      string   `json:"state"`
	SharedWith []string `json:"sharedWith,omitempty"`
	DeviceID   string   `json:"deviceId,omitempty"`
}

// DevicePairingStatusRequest names a pairing token its creator asks about.
type DevicePairingStatusRequest struct {
	Token string `json:"token"`
}

// DevicePairingConsentRequest continues (shares the account) or cancels the
// pairing waiting on a token.
type DevicePairingConsentRequest struct {
	Token  string `json:"token"`
	Accept bool   `json:"accept"`
}

// SystemAccountSharedCode marks a pairing refused until someone chooses to
// share the system account (DevicePairingConsentNeeded).
const SystemAccountSharedCode = "system_account_shared"

// DevicePairingConsentNeeded is POST /api/daemon/pair's 409 answer.
type DevicePairingConsentNeeded struct {
	Error      string   `json:"error"`
	Code       string   `json:"code"`
	SharedWith []string `json:"sharedWith"`
}

// DeviceSharingCapability: the worker takes device_sharing and tells its
// sessions that the account is shared.
const DeviceSharingCapability = "device_sharing"

// DeviceSharingPayload tells a worker who else uses its system account.
type DeviceSharingPayload struct {
	SharedWith []string `json:"sharedWith"`
}

// DeviceAccountSharedError refuses a pairing under a system account other
// people's devices use, until someone chooses to share it. The token stays
// good and records that it waits for that choice.
type DeviceAccountSharedError struct {
	// SharedWith are the other devices' owners, by display name.
	SharedWith []string
}

func (e *DeviceAccountSharedError) Error() string {
	return fmt.Sprintf("this computer account is already used by %s in Foundry", strings.Join(e.SharedWith, ", "))
}

// DeviceAccountIdentity is what a worker reports about where it runs, as
// hashes only: the system account (machine id, account id and the
// account's own Foundry folder) and the machine.
type DeviceAccountIdentity struct {
	OSAccountFingerprint string `json:"osAccountFingerprint,omitempty"`
	HostFingerprint      string `json:"hostFingerprint,omitempty"`
}

// DeviceSharingStore keeps who shares a system account.
type DeviceSharingStore interface {
	// RecordDeviceAccountIdentity keeps what a device's worker reported;
	// true when it changed. Empty fields are left as they are.
	RecordDeviceAccountIdentity(ctx context.Context, deviceID string, identity DeviceAccountIdentity) (bool, error)
	// ListDeviceAccountShares answers, by device, the other people's live
	// devices under the same system account.
	ListDeviceAccountShares(ctx context.Context) (map[string][]DeviceAccountShare, error)
	// DismissDeviceAccountShareNotice clears the device's pending notices.
	DismissDeviceAccountShareNotice(ctx context.Context, deviceID string) error
	// DevicePairingStatus answers where userID's token stands.
	DevicePairingStatus(ctx context.Context, tokenHash, userID string) (DevicePairingStatus, error)
	// SetDevicePairingConsent records userID's choice on a token waiting
	// for one.
	SetDevicePairingConsent(ctx context.Context, tokenHash, userID string, accept bool) (DevicePairingStatus, error)
}
