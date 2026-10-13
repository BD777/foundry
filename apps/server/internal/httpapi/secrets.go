package httpapi

import (
	"context"
	"errors"
	"fmt"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// secretKeeper is the part of the backend that seals credentials. It needs
// a secret key path: secretsConfigured tells whether a key is actually
// loaded, so a store opened without FOUNDRY_SECRET_KEY_PATH keeps rejecting
// credential payloads outright instead of storing them in the clear.
type secretKeeper interface {
	PutSecret(ctx context.Context, id string, plaintext []byte, additionalData string) error
	GetSecret(ctx context.Context, id string) ([]byte, error)
	HasSecret(ctx context.Context, id string) (bool, error)
	DeleteSecret(ctx context.Context, id string) error
	RenameSecret(ctx context.Context, oldID string, newID string) error
	SecretKEKFingerprint() string
}

func secretsConfigured(keeper secretKeeper) bool {
	return keeper.SecretKEKFingerprint() != ""
}

// openSecret unseals one credential for a single outbound request: "" when
// no key is loaded or nothing is stored under id. The value is never
// persisted, logged, or written to a response.
func openSecret(ctx context.Context, keeper secretKeeper, id string) (string, error) {
	if !secretsConfigured(keeper) {
		return "", nil
	}
	credential, err := keeper.GetSecret(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return string(credential), nil
}

// agentProfileSecretID binds a server-held credential to one profile on one
// device. The same string is the record id and its additional data, so a row
// moved between profiles fails to unseal.
func agentProfileSecretID(deviceID string, profileID string) string {
	return fmt.Sprintf("agent-profile:%s:%s", deviceID, profileID)
}

// serverProfileSecretID binds a credential to a server profile. A server
// profile is not tied to a device, so the record id carries no device segment;
// promotion renames the device-scoped record onto this id.
func serverProfileSecretID(profileID string) string {
	return "agent-profile:" + profileID
}

// sealProfileCredential stores the credential for the upserted profile. It
// runs after the daemon accepted the (already redacted) profile so a failed
// forward never leaves an orphaned secret behind.
func (s *Server) sealProfileCredential(ctx context.Context, deviceID string, profileID string, credential string) error {
	if !secretsConfigured(s.store) {
		return errors.New("server secret store is not configured; set FOUNDRY_SECRET_KEY_PATH to hold credentials server-side")
	}
	return s.store.PutSecret(ctx, agentProfileSecretID(deviceID, profileID), []byte(credential), agentProfileSecretID(deviceID, profileID))
}

// sealServerProfileCredential stores the credential for a server profile. It
// runs after the row is saved, mirroring sealProfileCredential: a failed write
// never leaves a secret behind for a profile that does not exist.
func (s *Server) sealServerProfileCredential(ctx context.Context, profileID string, credential string) error {
	if !secretsConfigured(s.store) {
		return errors.New("server secret store is not configured; set FOUNDRY_SECRET_KEY_PATH to hold credentials server-side")
	}
	id := serverProfileSecretID(profileID)
	return s.store.PutSecret(ctx, id, []byte(credential), id)
}

// profileHasCredential reports whether a server profile carries a sealed
// credential. A store failure reads as "no credential": the settings UI then
// offers to store one, which is the recoverable direction.
func (s *Server) profileHasCredential(ctx context.Context, profileID string) bool {
	if !secretsConfigured(s.store) || profileID == "" {
		return false
	}
	stored, err := s.store.HasSecret(ctx, serverProfileSecretID(profileID))
	return err == nil && stored
}

// deleteServerProfileCredential removes a sealed credential. A record that was
// never stored is not an error: the caller wants the credential gone, and it
// is.
func (s *Server) deleteServerProfileCredential(ctx context.Context, profileID string) error {
	if !secretsConfigured(s.store) || profileID == "" {
		return nil
	}
	if err := s.store.DeleteSecret(ctx, serverProfileSecretID(profileID)); err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	return nil
}

// serverProfileCredential unseals the credential dispatched with a session
// that runs a server profile. A missing record is not an error: the profile
// may legitimately rely on the device's own login.
func (h *DaemonHub) serverProfileCredential(ctx context.Context, profileID string) (string, error) {
	if profileID == "" {
		return "", nil
	}
	return openSecret(ctx, h.store, serverProfileSecretID(profileID))
}

// dispatchCredential returns the server-held credential for a session's
// profile, or "" when none is stored. A non-NotFound unseal failure is an
// error: silently dispatching without the credential would surface as a
// confusing provider auth failure instead of a store problem.
func (h *DaemonHub) dispatchCredential(ctx context.Context, session store.AgentSession) (string, error) {
	if session.ProfileID == "" {
		return "", nil
	}
	return openSecret(ctx, h.store, agentProfileSecretID(session.DeviceID, session.ProfileID))
}

// overlayServerCredential hydrates daemon-reported projections with what the
// server, not the device, knows: which credentials it holds, so the UI can
// show "managed by server" without ever reading the value.
func (s *Server) overlayServerCredential(ctx context.Context, profiles []store.AgentProfileProjection) []store.AgentProfileProjection {
	configured := secretsConfigured(s.store)
	for i := range profiles {
		hydrateDeviceProfile(&profiles[i])
		if !configured || profiles[i].ID == "" {
			continue
		}
		if stored, err := s.store.HasSecret(ctx, agentProfileSecretID(profiles[i].DeviceID, profiles[i].ID)); err == nil {
			profiles[i].ServerCredential = stored
		}
	}
	return profiles
}

// injectModelListCredential fills the transient profile forwarded to the
// daemon for model listing with the server-held credential, mirroring how
// dispatch delivers it. Nothing here is persisted by the daemon.
func (s *Server) injectModelListCredential(ctx context.Context, input *store.CreateAgentProfileInput) {
	if !secretsConfigured(s.store) || input.APIKey != "" || input.ID == "" {
		return
	}
	// The id may name a device-configured profile or a server profile; a server
	// profile's record carries no device segment, so both places are tried.
	for _, secretID := range []string{
		agentProfileSecretID(input.DeviceID, input.ID),
		serverProfileSecretID(input.ID),
	} {
		credential, err := s.store.GetSecret(ctx, secretID)
		if err == nil && len(credential) > 0 {
			input.APIKey = string(credential)
			return
		}
	}
}
