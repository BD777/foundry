package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The explicit check of a server profile on a device it is assigned to: the
// device runs one short conversation through its agent's own SDK with the
// profile's definition and key, exactly as a session would get them
// (packages/worker/src/session/provider-check.ts). It uses a little quota, so
// it runs only when someone asks; Foundry never calls the provider itself.

// A check waits up to two minutes for the agent's answer.
const profileCheckTimeout = 150 * time.Second

// wsCheckAgentProfilePayload carries the definition and the unsealed key the
// way run_session does; the device keeps neither.
type wsCheckAgentProfilePayload struct {
	Profile    store.ProfileDefinition `json:"profile"`
	Credential string                  `json:"credential,omitempty"`
}

type wsAgentProfileCheckedPayload struct {
	Result *store.AgentProfileCheck `json:"result,omitempty"`
	wsReplyError
}

type checkProfileRequest struct {
	DeviceID string `json:"deviceId"`
}

// handleCheckProfile checks the caller's server profile on one of their
// devices it is assigned to.
func (s *Server) handleCheckProfile(w http.ResponseWriter, r *http.Request) {
	var input checkProfileRequest
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	deviceID := strings.TrimSpace(input.DeviceID)
	if deviceID == "" {
		writeError(w, http.StatusBadRequest, "deviceId is required")
		return
	}
	if !s.requireDeviceOwner(w, r, deviceID) {
		return
	}
	check, err := s.checkServerProfile(r.Context(), strings.TrimSpace(r.PathValue("id")), deviceID)
	writeResult(w, check, err)
}

// checkServerProfile runs and records the check. The caller has decided that
// the profile and the device are the person's.
func (s *Server) checkServerProfile(ctx context.Context, profileID, deviceID string) (store.AgentProfileCheck, error) {
	profile, err := s.store.GetProfile(ctx, profileID)
	if errors.Is(err, store.ErrProfileNotFound) {
		return store.AgentProfileCheck{}, &statusError{http.StatusNotFound, errors.New("profile not found")}
	}
	if err != nil {
		return store.AgentProfileCheck{}, err
	}
	if profile.AuthMode == "official" {
		return store.AgentProfileCheck{}, &statusError{http.StatusBadRequest, errors.New("an official login is checked on its device's login, not as an API endpoint")}
	}
	assigned, err := s.profileEnabledOnDevice(ctx, deviceID, profile.ID)
	if err != nil {
		return store.AgentProfileCheck{}, err
	}
	if !assigned {
		return store.AgentProfileCheck{}, &statusError{http.StatusBadRequest, errors.New(profile.Label + " is not assigned to this device; assign it before checking it there")}
	}
	credential, err := s.hub.serverProfileCredential(ctx, profile.ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return store.AgentProfileCheck{}, err
	}
	check, err := s.hub.CheckServerProfile(ctx, deviceID, profile, credential)
	if err != nil {
		return store.AgentProfileCheck{}, err
	}
	if err := s.store.SaveProfileCheck(ctx, profile.ID, deviceID, check); err != nil {
		return store.AgentProfileCheck{}, err
	}
	s.projectionsChanged("", connectionFields...)
	return check, nil
}

// CheckServerProfile hands the device the profile to check and waits for the
// result. A worker that cannot check one is told to update.
func (h *DaemonHub) CheckServerProfile(ctx context.Context, deviceID string, profile store.ProfileDefinition, credential string) (store.AgentProfileCheck, error) {
	connection := h.connectionFor(deviceID)
	if connection == nil {
		return store.AgentProfileCheck{}, &statusError{http.StatusConflict, errors.New("connect this device before checking a model provider on it")}
	}
	if !connection.hasCapability(store.DaemonCapabilityProfileCheck) {
		return store.AgentProfileCheck{}, &statusError{http.StatusConflict, errors.New("this device's worker cannot check a model provider yet: update its worker")}
	}
	ctx, cancel := context.WithTimeout(ctx, profileCheckTimeout)
	defer cancel()
	value, err := callDevice[wsAgentProfileCheckedPayload](ctx, connection, wsCheckAgentProfileType,
		wsCheckAgentProfilePayload{Profile: profile, Credential: credential})
	if err != nil {
		return store.AgentProfileCheck{}, err
	}
	if value.Result == nil || value.Result.Status == "" {
		return store.AgentProfileCheck{}, errors.New("the device did not report a check result")
	}
	return *value.Result, nil
}
