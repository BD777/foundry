package connectors

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The server owns identity and display lifetime. Native continuation credentials
// stay on the worker. A server restart makes old operations explicitly unknown.
type authorizationSlot struct {
	mu               sync.Mutex
	owner, requestID string
	answer           store.DeviceConnectorSignIn
	expires, polled  time.Time
	running          bool
}

var ErrAuthorizationOperation = errors.New("this authorization is no longer known; check the device login before starting again")

type AuthorizationWork func(operationID, phase string, progress func(string)) (store.DeviceConnectorSignIn, error)

func (d *DeviceHeld) authorization(deviceID, kind string) *authorizationSlot {
	d.authorizationMu.Lock()
	defer d.authorizationMu.Unlock()
	if d.authorizations == nil {
		d.authorizations = map[string]*authorizationSlot{}
	}
	key := deviceID + "\x00" + kind
	if d.authorizations[key] == nil {
		d.authorizations[key] = &authorizationSlot{}
	}
	return d.authorizations[key]
}

// Authorize returns the operation receipt immediately. One bounded work step runs
// at a time; status retries resume its observed phase, never blindly replay begin.
func (d *DeviceHeld) Authorize(owner, deviceID, kind, requestID, operationID string, begin bool, run AuthorizationWork) (store.DeviceConnectorSignIn, error) {
	slot := d.authorization(deviceID, kind)
	slot.mu.Lock()
	defer slot.mu.Unlock()
	now := d.Now()
	if !slot.expires.IsZero() && !now.Before(slot.expires) {
		slot.answer = store.DeviceConnectorSignIn{Status: "expired", OperationID: slot.answer.OperationID, ExpiresAt: slot.expires.UTC().Format(time.RFC3339), IntervalSeconds: 3}
	}
	if begin {
		if slot.owner == owner && slot.answer.OperationID != "" && (slot.answer.Status == "pending" || (requestID != "" && slot.requestID == requestID)) {
			return slot.answer, nil
		}
		id := make([]byte, 24)
		if _, err := rand.Read(id); err != nil {
			return store.DeviceConnectorSignIn{}, err
		}
		slot.owner, slot.requestID = owner, requestID
		slot.expires = now.Add(10 * time.Minute)
		slot.polled = time.Time{}
		slot.running = false
		slot.answer = store.DeviceConnectorSignIn{Status: "pending", Phase: "checking", OperationID: hex.EncodeToString(id), ExpiresAt: slot.expires.UTC().Format(time.RFC3339), IntervalSeconds: 3}
	} else if owner != slot.owner || operationID == "" || operationID != slot.answer.OperationID {
		return store.DeviceConnectorSignIn{}, ErrAuthorizationOperation
	}
	if slot.answer.Status != "pending" || slot.running || (!slot.polled.IsZero() && now.Sub(slot.polled) < 3*time.Second) {
		return slot.answer, nil
	}
	slot.running = true
	slot.polled = now
	slot.answer.Error = ""
	id, phase := slot.answer.OperationID, slot.answer.Phase
	progress := func(next string) {
		switch next {
		case "checking", "starting", "awaiting_user", "verifying":
		default:
			return
		}
		slot.mu.Lock()
		defer slot.mu.Unlock()
		if slot.answer.OperationID == id && slot.answer.Status == "pending" {
			slot.answer.Phase = next
		}
	}
	go func() {
		var answer store.DeviceConnectorSignIn
		var err error
		func() {
			defer func() {
				if recover() != nil {
					err = errors.New("authorization step interrupted")
				}
			}()
			answer, err = run(id, phase, progress)
		}()
		slot.mu.Lock()
		defer slot.mu.Unlock()
		if slot.answer.OperationID != id || slot.answer.Status != "pending" {
			return
		}
		slot.running = false
		if !d.Now().Before(slot.expires) {
			slot.answer = store.DeviceConnectorSignIn{Status: "expired", OperationID: id, ExpiresAt: slot.expires.UTC().Format(time.RFC3339), IntervalSeconds: 3}
			return
		}
		if err != nil {
			// A missing RPC receipt is not a provider refusal. The phase records whether
			// retry may check status or must reconcile the already-dispatched operation.
			slot.answer.Error = "The device has not confirmed this step yet. Retry status for this operation; do not start another sign-in."
			return
		}
		switch answer.Status {
		case "pending", "complete", "expired", "denied", "failed":
		default:
			answer = store.DeviceConnectorSignIn{Status: "failed", Error: "The device returned an unknown authorization state."}
		}
		if answer.VerificationURL != "" {
			u, e := url.Parse(answer.VerificationURL)
			if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
				answer = store.DeviceConnectorSignIn{Status: "failed", Error: "Invalid authorization page."}
			}
		}
		if expiry, e := time.Parse(time.RFC3339, answer.ExpiresAt); e == nil && expiry.Before(slot.expires) {
			slot.expires = expiry
		}
		if answer.Status == "pending" {
			if answer.Challenge == nil {
				answer.Challenge = slot.answer.Challenge
			}
			if len(answer.Image) == 0 {
				answer.Image = slot.answer.Image
			}
			if answer.VerificationURL == "" {
				answer.VerificationURL = slot.answer.VerificationURL
				answer.UserCode = slot.answer.UserCode
			}
			if answer.Phase == "" {
				answer.Phase = slot.answer.Phase
			}
		} else {
			answer.Challenge = nil
			answer.Image = nil
			answer.VerificationURL = ""
			answer.UserCode = ""
			answer.Phase = ""
		}
		answer.OperationID = id
		answer.ExpiresAt = slot.expires.UTC().Format(time.RFC3339)
		answer.IntervalSeconds = 3
		slot.answer = answer
	}()
	return slot.answer, nil
}

func (d *DeviceHeld) InvalidateAuthorization(deviceID, kind string, run func() error) error {
	d.authorizationMu.Lock()
	slots := []*authorizationSlot{}
	prefix := deviceID + "\x00" + kind
	for key, slot := range d.authorizations {
		if key == prefix || strings.HasPrefix(key, prefix+"\x00") {
			slots = append(slots, slot)
		}
	}
	d.authorizationMu.Unlock()
	for _, slot := range slots {
		slot.mu.Lock()
		slot.answer = store.DeviceConnectorSignIn{}
		slot.mu.Unlock()
	}
	return run()
}
func (d *DeviceHeld) AuthorizationImage(owner, deviceID, scope, operationID string) ([]byte, error) {
	slot := d.authorization(deviceID, scope)
	slot.mu.Lock()
	defer slot.mu.Unlock()
	if slot.owner != owner || operationID == "" || slot.answer.OperationID != operationID || slot.answer.Status != "pending" || !d.Now().Before(slot.expires) || len(slot.answer.Image) == 0 {
		return nil, ErrAuthorizationOperation
	}
	return append([]byte(nil), slot.answer.Image...), nil
}

// Dismiss hides and revokes the resource; it cannot claim a native command stopped.
func (d *DeviceHeld) Dismiss(owner, deviceID, scope, operationID string) error {
	slot := d.authorization(deviceID, scope)
	slot.mu.Lock()
	defer slot.mu.Unlock()
	if slot.owner != owner || operationID == "" || slot.answer.OperationID != operationID {
		return ErrAuthorizationOperation
	}
	slot.answer = store.DeviceConnectorSignIn{}
	return nil
}
