package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A pairing token is shown in the web app and typed into a terminal soon
// after, so it lives only long enough for that.
const devicePairingTokenTTL = 15 * time.Minute

func (s *Server) deviceCredentials() (store.DeviceCredentialStore, bool) {
	credentials, ok := s.store.(store.DeviceCredentialStore)
	return credentials, ok
}

// authenticateDevice resolves a device credential to a daemon actor that acts
// with its owner's account. It writes the error response itself.
func (s *Server) authenticateDevice(w http.ResponseWriter, r *http.Request, credential string) (Actor, bool) {
	credentials, ok := s.deviceCredentials()
	if !ok || s.accounts == nil {
		writeError(w, http.StatusServiceUnavailable, "this server's store does not support device credentials")
		return Actor{}, false
	}
	identity, err := credentials.ResolveDeviceCredential(r.Context(), accounts.HashToken(credential))
	if errors.Is(err, store.ErrDeviceCredentialInvalid) {
		writeError(w, http.StatusUnauthorized, "device credential is invalid or revoked; pair this worker again")
		return Actor{}, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve device credential")
		return Actor{}, false
	}
	owner, err := s.accounts.GetUser(r.Context(), identity.OwnerUserID)
	if err != nil || !owner.Active() {
		writeError(w, http.StatusUnauthorized, "device owner is not an active account")
		return Actor{}, false
	}
	return Actor{Kind: ActorDaemon, DeviceID: identity.DeviceID, Account: &owner}, true
}

func (s *Server) handleCreateDevicePairingToken(w http.ResponseWriter, r *http.Request) {
	account, ok := currentAccount(w, r)
	if !ok {
		return
	}
	credentials, ok := s.deviceCredentials()
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "this server's store does not support device credentials")
		return
	}
	token, err := accounts.NewToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create pairing token")
		return
	}
	expiresAt := time.Now().UTC().Add(devicePairingTokenTTL)
	if err := credentials.CreateDevicePairingToken(r.Context(), accounts.HashToken(token), account.ID, expiresAt); err != nil {
		writeError(w, http.StatusInternalServerError, "create pairing token")
		return
	}
	// The token is returned once; only its hash is stored.
	writeJSON(w, http.StatusCreated, struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expiresAt"`
	}{token, expiresAt})
}

func (s *Server) handleDaemonPair(w http.ResponseWriter, r *http.Request) {
	credentials, ok := s.deviceCredentials()
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "this server's store does not support device credentials")
		return
	}
	var input struct {
		Token              string `json:"token"`
		MachineFingerprint string `json:"machineFingerprint"`
		DeviceID           string `json:"deviceId"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	key := "pair-ip:" + clientIP(r)
	if s.loginLimiter.locked(key) {
		writeError(w, http.StatusTooManyRequests, "too many pairing attempts; try again later")
		return
	}
	if strings.TrimSpace(input.MachineFingerprint) == "" {
		writeError(w, http.StatusBadRequest, "machineFingerprint is required")
		return
	}
	credential, err := accounts.NewToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create device credential")
		return
	}
	identity, err := credentials.PairDevice(r.Context(), store.PairDeviceInput{
		TokenHash:          accounts.HashToken(strings.TrimSpace(input.Token)),
		MachineFingerprint: input.MachineFingerprint,
		RequestedDeviceID:  input.DeviceID,
		CredentialHash:     accounts.HashToken(credential),
		Now:                time.Now().UTC(),
	})
	if errors.Is(err, store.ErrDevicePairingInvalid) {
		s.loginLimiter.fail(key)
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "pair device")
		return
	}
	s.loginLimiter.succeed(key)
	// Re-pairing rotates the credential; any daemon still holding the old one
	// is disconnected so the new one is the only live identity.
	s.hub.closeDevice(identity.DeviceID)
	writeJSON(w, http.StatusCreated, struct {
		DeviceID   string `json:"deviceId"`
		Credential string `json:"credential"`
	}{identity.DeviceID, credential})
}

// requireDeviceWorkspace keeps a daemon call to the workspaces of its own
// device. Only package tests produce a daemon actor without a device id.
func (s *Server) requireDeviceWorkspace(w http.ResponseWriter, r *http.Request, workspaceID string) bool {
	deviceID := actorFromContext(r.Context()).DeviceID
	if deviceID == "" || s.hub.workspaceOnDevice(r.Context(), workspaceID, deviceID) {
		return true
	}
	writeError(w, http.StatusNotFound, "not found")
	return false
}

func (s *Server) requireDeviceIssue(w http.ResponseWriter, r *http.Request, issueID string) bool {
	deviceID := actorFromContext(r.Context()).DeviceID
	if deviceID == "" || s.hub.issueOnDevice(r.Context(), issueID, deviceID) {
		return true
	}
	writeError(w, http.StatusNotFound, "not found")
	return false
}
