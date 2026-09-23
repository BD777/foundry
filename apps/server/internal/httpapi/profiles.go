package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

const (
	// A server profile belongs to the control plane, not to one machine, so it
	// reads as workspace-scoped wherever the UI groups by configuration source.
	serverProfileConfigScope = "workspace"
	serverProfileConfigLabel = "foundry server profile settings"
	profileOriginDevice      = "device"
	profileOriginServer      = "server"
	secretPlacementLocal     = "local"
	secretPlacementServer    = "server"
	profileAuthModeConfig    = "local_config"
	profileAuthModeMissing   = "missing"
	deviceStatusConnected    = "connected"
)

func profileConnectionType(runtime string, authMode string) string {
	if authMode == "official" {
		return "local_login"
	}
	if runtime == "claude" {
		return "anthropic_compatible"
	}
	return "openai_compatible"
}

func deviceLocalConnectionType(connectionType string) bool {
	switch connectionType {
	case "local_login", "env", "custom_command":
		return true
	default:
		return false
	}
}

// normalizeProfileInput trims the input in place and returns the first
// validation failure as a message, or "" when the input is usable.
func normalizeProfileInput(input *store.SaveProfileInput) string {
	input.ID = strings.TrimSpace(input.ID)
	input.Runtime = strings.TrimSpace(input.Runtime)
	input.Label = strings.TrimSpace(input.Label)
	input.AuthMode = strings.TrimSpace(input.AuthMode)
	input.BaseURL = strings.TrimSpace(input.BaseURL)
	input.Model = strings.TrimSpace(input.Model)
	if input.Label == "" {
		return "label is required"
	}
	if input.Runtime != "claude" && input.Runtime != "codex" {
		return "runtime must be claude or codex"
	}
	if input.AuthMode == "" {
		input.AuthMode = "custom"
	}
	if input.AuthMode != "official" && input.AuthMode != "custom" {
		return "authMode must be official or custom"
	}
	input.ConnectionType = profileConnectionType(input.Runtime, input.AuthMode)
	if input.AuthMode == "official" {
		input.BaseURL = ""
		return ""
	}
	if input.BaseURL == "" {
		return "baseUrl is required for custom profiles"
	}
	return ""
}

// invalidateProjections drops cached foundry-data snapshots after a profile
// write. Profiles carry no browser stream event of their own, so this bumps
// the cache revision directly rather than publishing a type clients discard.
func (s *Server) invalidateProjections() {
	s.events.revision.Add(1)
}

func (s *Server) handleListProfiles(w http.ResponseWriter, r *http.Request) {
	view, err := s.visibilityFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	profiles, err := s.store.ListProfiles(r.Context())
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	writeResult(w, s.overlayProfileCredentials(r.Context(), view.filterConnections(profiles)), nil)
}

// handleCreateProfile mints an id unless the caller supplies a free one. The
// store upserts by id, so the conflict check is what keeps a create from
// silently overwriting an existing profile.
func (s *Server) handleCreateProfile(w http.ResponseWriter, r *http.Request) {
	var input store.SaveProfileInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if id := strings.TrimSpace(input.ID); id != "" {
		_, err := s.store.GetProfile(r.Context(), id)
		if err == nil {
			writeError(w, http.StatusConflict, "profile "+id+" already exists")
			return
		}
		if !errors.Is(err, store.ErrProfileNotFound) {
			writeResult(w, nil, err)
			return
		}
	}
	input.OwnerUserID = actorFromContext(r.Context()).AccountID()
	s.saveProfile(w, r, input, http.StatusCreated)
}

func (s *Server) handleUpdateProfile(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "profile id is required")
		return
	}
	var input store.SaveProfileInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if _, err := s.store.GetProfile(r.Context(), id); err != nil {
		writeProfileResult(w, store.ProfileDefinition{}, err)
		return
	}
	input.ID = id
	s.saveProfile(w, r, input, http.StatusOK)
}

// saveProfile seals the credential only after the row exists, so a failed
// write never strands a secret under an id nothing references.
func (s *Server) saveProfile(w http.ResponseWriter, r *http.Request, input store.SaveProfileInput, status int) {
	credential := strings.TrimSpace(input.APIKey)
	input.APIKey = ""
	if message := normalizeProfileInput(&input); message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	if input.AuthMode == "official" && credential != "" {
		writeError(w, http.StatusBadRequest, "official profiles use the agent CLI login and cannot store an apiKey")
		return
	}
	if credential != "" && !secretsConfigured(s.secrets) {
		writeError(w, http.StatusBadRequest, "apiKey storage requires the server secret store; start the server with FOUNDRY_SECRET_KEY_PATH")
		return
	}
	profile, err := s.store.SaveProfile(r.Context(), input)
	if err != nil {
		writeProfileResult(w, store.ProfileDefinition{}, err)
		return
	}
	if credential != "" {
		if err := s.sealServerProfileCredential(r.Context(), profile.ID, credential); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if input.AuthMode == "official" {
		if err := s.deleteServerProfileCredential(r.Context(), profile.ID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	profile.HasCredential = s.profileHasCredential(r.Context(), profile.ID)
	s.invalidateProjections()
	writeResultWithStatus(w, status, profile, nil)
}

// handleDeleteProfile answers with the removed definition so the caller can
// report what disappeared without a second read.
func (s *Server) handleDeleteProfile(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "profile id is required")
		return
	}
	profile, err := s.store.GetProfile(r.Context(), id)
	if err != nil {
		writeProfileResult(w, store.ProfileDefinition{}, err)
		return
	}
	profile.HasCredential = s.profileHasCredential(r.Context(), id)
	if err := s.store.DeleteProfile(r.Context(), id); err != nil {
		writeProfileResult(w, store.ProfileDefinition{}, err)
		return
	}
	if err := s.deleteServerProfileCredential(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.invalidateProjections()
	writeResult(w, profile, nil)
}

// handleClearProfileCredential drops the sealed credential and keeps the row,
// which is how a profile falls back to whatever login the device already has.
func (s *Server) handleClearProfileCredential(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "profile id is required")
		return
	}
	profile, err := s.store.GetProfile(r.Context(), id)
	if err != nil {
		writeProfileResult(w, store.ProfileDefinition{}, err)
		return
	}
	if err := s.deleteServerProfileCredential(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	profile.HasCredential = false
	s.invalidateProjections()
	writeResult(w, profile, nil)
}

func (s *Server) handleStartProfileAuthorization(w http.ResponseWriter, r *http.Request) {
	profileID := strings.TrimSpace(r.PathValue("id"))
	profile, err := s.store.GetProfile(r.Context(), profileID)
	if err != nil {
		writeProfileResult(w, store.ProfileDefinition{}, err)
		return
	}
	if profile.AuthMode != "official" {
		writeError(w, http.StatusBadRequest, "only official profiles use agent CLI authorization")
		return
	}
	var input struct {
		DeviceID string `json:"deviceId"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	deviceID := strings.TrimSpace(input.DeviceID)
	if deviceID == "" {
		writeError(w, http.StatusBadRequest, "deviceId is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	authorization, err := s.hub.StartProfileAuthorization(ctx, deviceID, profile.ID, profile.Runtime)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "local daemon is not connected")
		return
	}
	writeResult(w, authorization, err)
}

func (s *Server) handleCompleteProfileAuthorization(w http.ResponseWriter, r *http.Request) {
	profileID := strings.TrimSpace(r.PathValue("id"))
	flowID := strings.TrimSpace(r.PathValue("flowId"))
	profile, err := s.store.GetProfile(r.Context(), profileID)
	if err != nil {
		writeProfileResult(w, store.ProfileDefinition{}, err)
		return
	}
	if profile.AuthMode != "official" {
		writeError(w, http.StatusBadRequest, "only official profiles use agent CLI authorization")
		return
	}
	var input struct {
		DeviceID            string `json:"deviceId"`
		AuthorizationResult string `json:"authorizationResult,omitempty"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	deviceID := strings.TrimSpace(input.DeviceID)
	if deviceID == "" {
		writeError(w, http.StatusBadRequest, "deviceId is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	authorization, err := s.hub.CompleteProfileAuthorization(
		ctx,
		deviceID,
		flowID,
		input.AuthorizationResult,
	)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "local daemon is not connected")
		return
	}
	if authorization.ProfileID != "" && authorization.ProfileID != profile.ID {
		writeError(w, http.StatusConflict, "authorization session belongs to another profile")
		return
	}
	writeResult(w, authorization, err)
}

// handlePromoteProfile lifts a daemon-discovered profile into a server profile.
// A credential the server already holds moves with it untouched: the record is
// renamed under the server-scoped id, so no one has to retype a key that the
// server can already unseal.
func (s *Server) handlePromoteProfile(w http.ResponseWriter, r *http.Request) {
	var input store.PromoteProfileInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceOwner(w, r, strings.TrimSpace(input.DeviceID)) {
		return
	}
	deviceID := strings.TrimSpace(input.DeviceID)
	profileID := strings.TrimSpace(input.ProfileID)
	if deviceID == "" || profileID == "" {
		writeError(w, http.StatusBadRequest, "deviceId and profileId are required")
		return
	}
	source, err := s.deviceProfileProjection(r.Context(), deviceID, profileID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if deviceLocalConnectionType(source.ConnectionType) {
		writeError(w, http.StatusBadRequest, "local_login, env and custom_command profiles describe machine-local state and cannot be promoted to a server profile")
		return
	}
	if !secretsConfigured(s.secrets) {
		writeError(w, http.StatusBadRequest, "promoting a profile moves its credential to the server; start the server with FOUNDRY_SECRET_KEY_PATH")
		return
	}
	saveInput := store.SaveProfileInput{
		OwnerUserID:          actorFromContext(r.Context()).AccountID(),
		ID:                   profileID,
		Runtime:              source.Runtime,
		Label:                source.Label,
		ConnectionType:       source.ConnectionType,
		BaseURL:              source.BaseURL,
		Model:                source.Model,
		Models:               source.Models,
		PromptPrefix:         source.PromptPrefix,
		ClaudeEffort:         source.ClaudeEffort,
		ClaudePermissionMode: source.ClaudePermissionMode,
		CodexReasoningEffort: source.CodexReasoningEffort,
		CodexSandboxMode:     source.CodexSandboxMode,
		CodexApprovalPolicy:  source.CodexApprovalPolicy,
		CodexSpeed:           source.CodexSpeed,
	}
	if message := normalizeProfileInput(&saveInput); message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	// Two devices can report unrelated profiles under the same local id, so an
	// id already taken by a different profile mints a fresh one instead of
	// overwriting someone else's configuration.
	if _, err := s.store.GetProfile(r.Context(), profileID); err == nil {
		saveInput.ID = ""
	} else if !errors.Is(err, store.ErrProfileNotFound) {
		writeResult(w, nil, err)
		return
	}
	profile, err := s.store.SaveProfile(r.Context(), saveInput)
	if err != nil {
		writeProfileResult(w, store.ProfileDefinition{}, err)
		return
	}
	if err := s.adoptPromotedCredential(r.Context(), deviceID, profileID, profile.ID); err != nil {
		// A promoted profile with no credential authenticates nowhere, so the
		// half-finished record is removed instead of being left behind for
		// someone to debug later.
		_ = s.store.DeleteProfile(r.Context(), profile.ID)
		status := http.StatusBadGateway
		if errors.Is(err, errDeviceHoldsNoCredential) {
			status = http.StatusBadRequest
		}
		writeError(w, status, err.Error())
		return
	}
	// The user is promoting a profile they already run on this machine, so the
	// device keeps it: without a binding the promoted profile would vanish from
	// every view until someone hunted down a checkbox.
	if err := s.enableProfileOnDevice(r.Context(), deviceID, profile.ID); err != nil {
		writeResult(w, nil, err)
		return
	}
	profile.HasCredential = s.profileHasCredential(r.Context(), profile.ID)
	s.invalidateProjections()
	writeResultWithStatus(w, http.StatusCreated, profile, nil)
}

// errDeviceHoldsNoCredential reports a device that cannot hand over a key for
// the profile being promoted, which makes the promotion pointless rather than
// broken infrastructure.
var errDeviceHoldsNoCredential = errors.New(
	"this device holds no API key for the profile, so promoting it would create a profile that cannot authenticate anywhere",
)

// adoptPromotedCredential moves the device profile's credential onto the new
// server profile. Renaming an already sealed record needs no user input: the
// server unseals with its own key and reseals under the new id. Otherwise the
// daemon is asked for the key this machine uses, because a server profile
// without a credential cannot authenticate on any device.
func (s *Server) adoptPromotedCredential(ctx context.Context, deviceID string, sourceProfileID string, profileID string) error {
	if !secretsConfigured(s.secrets) {
		return nil
	}
	legacyID := agentProfileSecretID(deviceID, sourceProfileID)
	targetID := serverProfileSecretID(profileID)
	if legacyID != targetID {
		stored, err := s.secrets.HasSecret(ctx, legacyID)
		if err != nil {
			return err
		}
		if stored {
			return s.secrets.RenameSecret(ctx, legacyID, targetID)
		}
	}
	if stored, err := s.secrets.HasSecret(ctx, targetID); err != nil {
		return err
	} else if stored {
		return nil
	}

	requestCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	credential, err := s.hub.ReadProfileCredential(requestCtx, deviceID, sourceProfileID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return errors.New("local daemon is not connected")
		}
		return err
	}
	if strings.TrimSpace(credential) == "" {
		return errDeviceHoldsNoCredential
	}
	return s.sealServerProfileCredential(ctx, profileID, credential)
}

func (s *Server) handleSetDeviceProfiles(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(r.PathValue("deviceId"))
	if deviceID == "" {
		writeError(w, http.StatusBadRequest, "device id is required")
		return
	}
	var input store.SetDeviceProfilesInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	input.DeviceID = deviceID
	if err := s.store.SetDeviceProfiles(r.Context(), input); err != nil {
		writeProfileResult(w, store.ProfileDefinition{}, err)
		return
	}
	bindings, err := s.store.ListDeviceProfiles(r.Context(), deviceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	s.invalidateProjections()
	writeResult(w, bindings, nil)
}

// writeProfileResult maps a missing profile onto 404; everything else follows
// the shared result mapping.
func writeProfileResult(w http.ResponseWriter, profile store.ProfileDefinition, err error) {
	if errors.Is(err, store.ErrProfileNotFound) {
		writeError(w, http.StatusNotFound, "profile not found")
		return
	}
	writeResult(w, profile, err)
}

func (s *Server) overlayProfileCredentials(ctx context.Context, profiles []store.ProfileDefinition) []store.ProfileDefinition {
	if profiles == nil {
		return []store.ProfileDefinition{}
	}
	if !secretsConfigured(s.secrets) {
		return profiles
	}
	for i := range profiles {
		profiles[i].HasCredential = s.profileHasCredential(ctx, profiles[i].ID)
	}
	return profiles
}

func (s *Server) profileEnabledOnDevice(ctx context.Context, deviceID string, profileID string) (bool, error) {
	bindings, err := s.store.ListDeviceProfiles(ctx, deviceID)
	if err != nil {
		return false, err
	}
	for _, binding := range bindings {
		if binding.ProfileID == profileID {
			return binding.Enabled, nil
		}
	}
	return false, nil
}

// enableProfileOnDevice adds one profile to a device's enabled set. The set is
// replaced wholesale by the store, so the current bindings are read back and
// carried over rather than dropped.
func (s *Server) enableProfileOnDevice(ctx context.Context, deviceID string, profileID string) error {
	bindings, err := s.store.ListDeviceProfiles(ctx, deviceID)
	if err != nil {
		return err
	}
	profileIDs := make([]string, 0, len(bindings)+1)
	for _, binding := range bindings {
		if binding.Enabled && binding.ProfileID != profileID {
			profileIDs = append(profileIDs, binding.ProfileID)
		}
	}
	profileIDs = append(profileIDs, profileID)
	return s.store.SetDeviceProfiles(ctx, store.SetDeviceProfilesInput{DeviceID: deviceID, ProfileIDs: profileIDs})
}

// deviceProfileProjection finds the daemon-reported profile promotion reads
// from. It reports store.ErrNotFound when that device never reported it.
func (s *Server) deviceProfileProjection(ctx context.Context, deviceID string, profileID string) (store.AgentProfileProjection, error) {
	profiles, err := s.store.ListAgentProfiles(ctx, deviceID)
	if err != nil {
		return store.AgentProfileProjection{}, err
	}
	for _, profile := range profiles {
		if profile.ID == profileID {
			return profile, nil
		}
	}
	return store.AgentProfileProjection{}, store.ErrNotFound
}

// hydrateDeviceProfile stamps the facts a daemon does not report about its own
// profiles: they are device-owned, and their credential - when one exists at
// all - lives on that machine. It is the single definition of what a
// daemon-reported row looks like once the server has seen it, and it is
// idempotent so any path may apply it.
func hydrateDeviceProfile(profile *store.AgentProfileProjection) {
	profile.Origin = profileOriginDevice
	if profile.SecretStored == "" {
		profile.SecretStored = secretPlacementLocal
	}
}

// agentProfileInputFrom shapes a server profile into the transient profile the
// daemon accepts for model listing. Nothing here is persisted by the daemon.
func agentProfileInputFrom(profile store.ProfileDefinition, deviceID string) store.CreateAgentProfileInput {
	return store.CreateAgentProfileInput{
		ID:                   profile.ID,
		DeviceID:             deviceID,
		Runtime:              profile.Runtime,
		Label:                profile.Label,
		ConfigScope:          serverProfileConfigScope,
		ConnectionType:       profile.ConnectionType,
		BaseURL:              profile.BaseURL,
		Model:                profile.Model,
		Models:               profile.Models,
		PromptPrefix:         profile.PromptPrefix,
		ClaudeEffort:         profile.ClaudeEffort,
		ClaudePermissionMode: profile.ClaudePermissionMode,
		CodexReasoningEffort: profile.CodexReasoningEffort,
		CodexSandboxMode:     profile.CodexSandboxMode,
		CodexApprovalPolicy:  profile.CodexApprovalPolicy,
		CodexSpeed:           profile.CodexSpeed,
	}
}

// serverProfileForSession resolves the server profile a session runs, or nil
// when the session runs a device-local profile. The binding is what makes a
// profile the device's to run, so an unbound profile resolves to nil and the
// daemon keeps using its own definition.
//
// One fallback exists: a session pinned to a device-local connection id whose
// endpoint is also published to this device as an enabled server profile (a
// promotion twin) runs that server profile. Both identities describe the same
// runtime+endpoint — native resume already treats them as one via its
// fingerprint — and the device copy holds no control-plane credential, so
// dispatching the server definition is the only way the pinned session can
// authenticate. The fallback never fires for an id that names a server-owned
// profile (a disabled admin binding stays disabled) or when the device has its
// own sealed credential (a working local configuration is left untouched).
func (h *DaemonHub) serverProfileForSession(ctx context.Context, session store.AgentSession) (*store.ProfileDefinition, error) {
	profileID := strings.TrimSpace(session.ProfileID)
	deviceID := strings.TrimSpace(session.DeviceID)
	if profileID == "" || deviceID == "" {
		return nil, nil
	}
	bindings, err := h.store.ListDeviceProfiles(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	for _, binding := range bindings {
		if binding.ProfileID != profileID || !binding.Enabled {
			continue
		}
		profile, err := h.store.GetProfile(ctx, profileID)
		if errors.Is(err, store.ErrProfileNotFound) {
			break
		}
		if err != nil {
			return nil, err
		}
		return &profile, nil
	}
	// A server-owned id that reached here is unbound or disabled: that is an
	// administrative decision, never bypassed onto a different profile.
	if _, err := h.store.GetProfile(ctx, profileID); err == nil {
		return nil, nil
	} else if !errors.Is(err, store.ErrProfileNotFound) {
		return nil, err
	}
	return h.endpointTwinProfile(ctx, deviceID, profileID, bindings)
}

// endpointTwinProfile finds the unique credential-bearing enabled server
// profile bound to deviceID that serves the same runtime and custom endpoint
// as the device-local profile localProfileID. It returns nil when no twin
// exists, the twin carries no credential, the device holds its own credential,
// or the match is ambiguous (multiple credentials for one endpoint could be
// different accounts and must not be guessed).
func (h *DaemonHub) endpointTwinProfile(
	ctx context.Context,
	deviceID string,
	localProfileID string,
	bindings []store.DeviceProfileBinding,
) (*store.ProfileDefinition, error) {
	reported, err := h.store.ListAgentProfiles(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	var local store.AgentProfileProjection
	for _, profile := range reported {
		if profile.ID == localProfileID {
			local = profile
			break
		}
	}
	if local.ID == "" || local.BaseURL == "" || deviceLocalConnectionType(local.ConnectionType) {
		return nil, nil
	}
	// The device controls its own credential for this connection (key entered
	// on the device profile). Dispatch keeps using it rather than swapping the
	// session onto another account.
	if secretsConfigured(h.secrets) {
		stored, err := h.secrets.HasSecret(
			ctx,
			agentProfileSecretID(deviceID, localProfileID),
		)
		if err != nil {
			return nil, err
		}
		if stored {
			return nil, nil
		}
	}
	var candidates []store.ProfileDefinition
	for _, binding := range bindings {
		if !binding.Enabled || binding.DeviceID != deviceID {
			continue
		}
		profile, err := h.store.GetProfile(ctx, binding.ProfileID)
		if errors.Is(err, store.ErrProfileNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if profile.Runtime != local.Runtime ||
			profile.ConnectionType != local.ConnectionType ||
			profile.BaseURL != local.BaseURL ||
			deviceLocalConnectionType(profile.ConnectionType) {
			continue
		}
		if !secretsConfigured(h.secrets) {
			continue
		}
		hasCredential, err := h.secrets.HasSecret(
			ctx,
			serverProfileSecretID(profile.ID),
		)
		if err != nil {
			return nil, err
		}
		if hasCredential {
			candidates = append(candidates, profile)
		}
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	if len(candidates) > 1 {
		var labelMatches []store.ProfileDefinition
		for _, candidate := range candidates {
			if candidate.Label == local.Label {
				labelMatches = append(labelMatches, candidate)
			}
		}
		if len(labelMatches) != 1 {
			return nil, nil
		}
		candidates = labelMatches
	}
	return &candidates[0], nil
}

// serverProfileStatus derives how a server profile looks from one device. The
// device's own reachability comes first: a profile the server considers fully
// configured is still unusable while the machine that would run it is offline.
//
// For custom API/gateway profiles a sealed key is optional: internal proxies
// commonly authenticate themselves, and the device runtime may already hold
// credentials. "healthy" therefore means "configured and selectable", never
// "verified online" — nothing probes the provider, and an SDK authentication
// failure at run time is surfaced as a run failure. Only official profiles
// gate on the device's native login.
func serverProfileStatus(device store.DeviceProjection, health []store.ProviderHealth, runtime string, authMode string, hasCredential bool) (string, string) {
	if device.Status != deviceStatusConnected {
		return "unavailable", "Device is offline."
	}
	for _, row := range health {
		if row.DeviceID != device.ID || row.Provider != runtime {
			continue
		}
		if row.Status == "unavailable" {
			return "unavailable", row.StatusDetail
		}
		if authMode == "official" {
			if row.Status == "healthy" {
				return "healthy", ""
			}
			return "missing_auth", "Authorize this profile on the device."
		}
	}
	if authMode == "official" {
		return "missing_auth", "Authorize this profile on the device."
	}
	return "healthy", ""
}

// serverProfileProjections renders the server profiles a device may run as the
// same projection rows the daemon reports, so every consumer sees one list.
// A server row replaces the daemon row with the same id: once a profile is
// server-owned its definition, not the device's file, is authoritative.
func (s *Server) serverProfileProjections(
	ctx context.Context,
	workspace store.WorkspaceProjection,
	devices []store.DeviceProjection,
	profiles []store.ProfileDefinition,
	bindings []store.DeviceProfileBinding,
	agentProfiles []store.AgentProfileProjection,
	agents []store.AgentProjection,
) ([]store.AgentProfileProjection, []store.AgentProjection, error) {
	for i := range agentProfiles {
		hydrateDeviceProfile(&agentProfiles[i])
	}
	deviceByID := make(map[string]store.DeviceProjection, len(devices))
	for _, device := range devices {
		deviceByID[device.ID] = device
	}
	profileByID := make(map[string]store.ProfileDefinition, len(profiles))
	for _, profile := range profiles {
		profileByID[profile.ID] = profile
	}
	resolved := make([]store.DeviceProfileBinding, 0, len(bindings))
	for _, binding := range bindings {
		if !binding.Enabled {
			continue
		}
		if _, ok := deviceByID[binding.DeviceID]; !ok {
			continue
		}
		if _, ok := profileByID[binding.ProfileID]; !ok {
			continue
		}
		resolved = append(resolved, binding)
	}
	if len(resolved) == 0 {
		return agentProfiles, agents, nil
	}
	// Bindings can name devices other than the one this workspace runs on, and
	// their health rows are not in the workspace-scoped snapshot.
	health, err := s.store.ListProviderHealth(ctx, "")
	if err != nil {
		return nil, nil, err
	}
	workspaceDeviceID := strings.TrimSpace(workspace.DeviceID)
	for _, binding := range resolved {
		device := deviceByID[binding.DeviceID]
		profile := profileByID[binding.ProfileID]
		hasCredential := s.profileHasCredential(ctx, profile.ID)
		status, detail := serverProfileStatus(device, health, profile.Runtime, profile.AuthMode, hasCredential)
		authMode := profileAuthModeMissing
		secretPlacement := secretPlacementServer
		configLabel := serverProfileConfigLabel
		if profile.AuthMode == "official" {
			secretPlacement = secretPlacementLocal
			configLabel = "official agent login on this device"
			if status == "healthy" {
				authMode = profileAuthModeConfig
			}
		} else {
			// The server definition itself is the configuration; a sealed key
			// is optional for custom profiles (keyless internal gateways).
			authMode = profileAuthModeConfig
		}
		// The device row is kept rather than replaced: the machine really does
		// carry this configuration, and hiding it made a promoted profile look
		// like it had vanished from the device.
		agentProfiles = markPromotedDeviceProfile(agentProfiles, device.ID, profile)
		agentProfiles = upsertAgentProfileRow(agentProfiles, store.AgentProfileProjection{
			ID:                   profile.ID,
			DeviceID:             device.ID,
			Runtime:              profile.Runtime,
			Label:                profile.Label,
			Status:               status,
			AuthMode:             authMode,
			SecretStored:         secretPlacement,
			ServerCredential:     profile.AuthMode != "official" && hasCredential,
			ConfigScope:          serverProfileConfigScope,
			ConfigLabel:          configLabel,
			ConnectionType:       profile.ConnectionType,
			Model:                profile.Model,
			Models:               profile.Models,
			PromptPrefix:         profile.PromptPrefix,
			ClaudeEffort:         profile.ClaudeEffort,
			ClaudePermissionMode: profile.ClaudePermissionMode,
			CodexReasoningEffort: profile.CodexReasoningEffort,
			CodexSandboxMode:     profile.CodexSandboxMode,
			CodexApprovalPolicy:  profile.CodexApprovalPolicy,
			CodexSpeed:           profile.CodexSpeed,
			BaseURL:              profile.BaseURL,
			Origin:               profileOriginServer,
			LastSeenLabel:        device.LastSeenLabel,
			StatusDetail:         detail,
		})
		// An agent is a profile on the machine that runs this workspace, so a
		// binding on any other device contributes no selectable agent here.
		if workspace.ID == "" || device.ID != workspaceDeviceID {
			continue
		}
		agents = upsertAgentRow(agents, store.AgentProjection{
			ID:             store.ServerAgentID(device.ID, workspace.ID, profile.ID),
			WorkspaceID:    workspace.ID,
			DeviceID:       device.ID,
			DeviceLabel:    device.Label,
			Provider:       profile.Runtime,
			ProfileID:      profile.ID,
			ProfileLabel:   profile.Label,
			ConnectionType: profile.ConnectionType,
			Status:         status,
			AuthMode:       authMode,
			SecretStored:   secretPlacement,
			ConfigScope:    serverProfileConfigScope,
			ConfigLabel:    configLabel,
			LastSeenLabel:  device.LastSeenLabel,
			StatusDetail:   detail,
		})
	}
	return agentProfiles, agents, nil
}

// markPromotedDeviceProfile flags the daemon-reported row that describes the
// same endpoint as a server profile. Matching is by id or by endpoint, because
// promotion reuses the daemon's id while a profile discovered later only
// matches on runtime and base URL.
func markPromotedDeviceProfile(rows []store.AgentProfileProjection, deviceID string, profile store.ProfileDefinition) []store.AgentProfileProjection {
	for i := range rows {
		row := rows[i]
		if row.Origin != profileOriginDevice || row.DeviceID != deviceID {
			continue
		}
		sameEndpoint := row.Runtime == profile.Runtime &&
			row.BaseURL != "" &&
			row.BaseURL == profile.BaseURL
		if row.ID == profile.ID || sameEndpoint {
			rows[i].PromotedProfileID = profile.ID
		}
	}
	return rows
}

// upsertAgentProfileRow keeps device and server rows apart: a promoted profile
// exists twice on purpose, once as the machine's configuration and once as the
// control-plane definition.
func upsertAgentProfileRow(rows []store.AgentProfileProjection, row store.AgentProfileProjection) []store.AgentProfileProjection {
	for i := range rows {
		if rows[i].DeviceID == row.DeviceID &&
			rows[i].ID == row.ID &&
			rows[i].Origin == row.Origin {
			rows[i] = row
			return rows
		}
	}
	return append(rows, row)
}

func upsertAgentRow(rows []store.AgentProjection, row store.AgentProjection) []store.AgentProjection {
	for i := range rows {
		if rows[i].DeviceID == row.DeviceID && rows[i].WorkspaceID == row.WorkspaceID && rows[i].ProfileID == row.ProfileID {
			row.ID = rows[i].ID
			rows[i] = row
			return rows
		}
	}
	return append(rows, row)
}
