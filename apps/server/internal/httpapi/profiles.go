package httpapi

import (
	"context"
	"errors"
	"fmt"
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
	deviceStatusRemoved      = "removed"
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

// normalizeProfileInput trims the input in place, puts its base URL in the
// runtime's form (provider_endpoint.go) and returns the first validation
// failure as a message, or "" when the input is usable. addMissingVersion
// gives a bare Codex host /v1; a promotion keeps the endpoint its device runs.
func normalizeProfileInput(input *store.SaveProfileInput, addMissingVersion bool) string {
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
	if message := normalizeCodexTransport(input); message != "" {
		return message
	}
	if input.AuthMode == "official" {
		// An official login runs with the CLI's own windows.
		input.BaseURL = ""
		input.ContextWindows = nil
		return ""
	}
	if message := normalizeContextWindows(input); message != "" {
		return message
	}
	baseURL, _, code := normalizeProviderBaseURL(input.Runtime, input.BaseURL, addMissingVersion)
	if code != "" {
		return endpointErrorMessages[code]
	}
	input.BaseURL = baseURL
	return ""
}

// normalizeCodexTransport keeps the Responses transport choice on a
// compatible Codex endpoint only; empty there is auto.
func normalizeCodexTransport(input *store.SaveProfileInput) string {
	input.CodexTransport = strings.TrimSpace(input.CodexTransport)
	if input.ConnectionType != "openai_compatible" {
		input.CodexTransport = ""
		return ""
	}
	switch input.CodexTransport {
	case "":
		input.CodexTransport = store.CodexTransportAuto
	case store.CodexTransportAuto, store.CodexTransportWebSocket, store.CodexTransportHTTPS:
	default:
		return "codexTransport must be auto, websocket or https"
	}
	return ""
}

// Bounds of a context window a person may set (protocol model-context.ts).
const (
	minProfileContextWindow = 1_000
	maxProfileContextWindow = 10_000_000
)

// normalizeContextWindows trims the model ids of the per-model windows and
// rejects a window outside the bounds.
func normalizeContextWindows(input *store.SaveProfileInput) string {
	if input.ContextWindows == nil {
		return ""
	}
	cleaned := make(map[string]int64, len(input.ContextWindows))
	for model, tokens := range input.ContextWindows {
		model = strings.TrimSpace(model)
		if model == "" {
			return "contextWindows needs a model id for every window"
		}
		if tokens < minProfileContextWindow || tokens > maxProfileContextWindow {
			return fmt.Sprintf("contextWindows: %s must be between %d and %d tokens", model, minProfileContextWindow, maxProfileContextWindow)
		}
		cleaned[model] = tokens
	}
	input.ContextWindows = cleaned
	return ""
}

// projectionsChanged announces a write to what foundry-data returns that no
// other event carries (connections, skills, worker updates, ...): cached
// snapshots are dropped and clients told to read the named fields again
// (foundry_data_changed; none names any). workspaceID scopes it to one
// workspace's data; "" is what every workspace's view shows.
func (s *Server) projectionsChanged(workspaceID string, resources ...string) {
	s.dataChanges.changed(workspaceID, resources...)
	if skillPreparationChanged(resources) {
		s.hub.queueSkillPreparation()
	}
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
	current, err := s.store.GetProfile(r.Context(), id)
	if err != nil {
		writeProfileResult(w, store.ProfileDefinition{}, err)
		return
	}
	if input.ContextWindows == nil {
		input.ContextWindows = current.ContextWindows
	}
	if strings.TrimSpace(input.CodexTransport) == "" {
		input.CodexTransport = current.CodexTransport
	}
	input.ID = id
	s.saveProfile(w, r, input, http.StatusOK)
}

// saveProfile seals the credential only after the row exists, so a failed
// write never strands a secret under an id nothing references.
func (s *Server) saveProfile(w http.ResponseWriter, r *http.Request, input store.SaveProfileInput, status int) {
	credential := strings.TrimSpace(input.APIKey)
	input.APIKey = ""
	if message := normalizeProfileInput(&input, true); message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	if input.AuthMode == "official" && credential != "" {
		writeError(w, http.StatusBadRequest, "official profiles use the agent CLI login and cannot store an apiKey")
		return
	}
	if credential != "" && !secretsConfigured(s.store) {
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
	s.projectionsChanged("", connectionFields...)
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
	s.projectionsChanged("", connectionFields...)
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
	s.projectionsChanged("", connectionFields...)
	writeResult(w, profile, nil)
}

// handlePromoteProfile copies an API provider from a device's own Claude Code
// or Codex configuration into a server profile, or updates the profile it was
// promoted into before. The device's configuration is never modified. The key
// is copied only with the person's explicit confirmation (input.CopyKey), and
// only the one the provider's configuration names.
func (s *Server) handlePromoteProfile(w http.ResponseWriter, r *http.Request) {
	var input store.PromoteProfileInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	deviceID := strings.TrimSpace(input.DeviceID)
	sourceID := strings.TrimSpace(input.ProfileID)
	if deviceID == "" || sourceID == "" {
		writeError(w, http.StatusBadRequest, "deviceId and profileId are required")
		return
	}
	if !s.requireDeviceOwner(w, r, deviceID) {
		return
	}
	ctx := r.Context()
	source, err := s.deviceProfileProjection(ctx, deviceID, sourceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if deviceLocalConnectionType(source.ConnectionType) {
		writeError(w, http.StatusBadRequest, "local_login, env and custom_command profiles describe machine-local state and cannot be promoted to a server profile")
		return
	}
	if input.CopyKey && !secretsConfigured(s.store) {
		writeError(w, http.StatusBadRequest, "copying the key needs the server secret store; start the server with FOUNDRY_SECRET_KEY_PATH")
		return
	}
	saveInput, existing, err := s.promotionSaveInput(ctx, deviceID, source)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	saveInput.OwnerUserID = actorFromContext(ctx).AccountID()
	if message := normalizeProfileInput(&saveInput, false); message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	// The key is read before anything is written, so a key that cannot be read
	// leaves no half-promoted profile behind.
	var key promotionKey
	if input.CopyKey {
		key, err = s.readPromotionKey(ctx, deviceID, sourceID)
		if err != nil {
			status := http.StatusBadGateway
			if errors.Is(err, errPromotionKeyUnavailable) {
				status = http.StatusBadRequest
			}
			writeError(w, status, err.Error())
			return
		}
	}
	profile, err := s.store.SaveProfile(ctx, saveInput)
	if err != nil {
		writeProfileResult(w, store.ProfileDefinition{}, err)
		return
	}
	if input.CopyKey {
		if err := s.storePromotionKey(ctx, key, profile.ID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if err := s.store.SaveProfilePromotion(ctx, store.ProfilePromotion{
		ProfileID:       profile.ID,
		DeviceID:        deviceID,
		SourceProfileID: sourceID,
	}); err != nil {
		writeResult(w, nil, err)
		return
	}
	// The person runs this provider on the device already, so the device keeps
	// it: without a binding the promoted profile would vanish from its views.
	if err := s.enableProfileOnDevice(ctx, deviceID, profile.ID); err != nil {
		writeResult(w, nil, err)
		return
	}
	if profile, err = s.store.GetProfile(ctx, profile.ID); err != nil {
		writeProfileResult(w, store.ProfileDefinition{}, err)
		return
	}
	profile.HasCredential = s.profileHasCredential(ctx, profile.ID)
	s.projectionsChanged("", connectionFields...)
	status := http.StatusCreated
	if existing {
		status = http.StatusOK
	}
	writeResultWithStatus(w, status, profile, nil)
}

// promotionSaveInput shapes what promotion writes. A provider promoted before
// updates its profile: the copied fields follow the device, while what the
// person set on the server since (efforts, permissions, added models) stays.
// A first promotion keeps the device's id when it is free; two devices can
// report unrelated providers under one id, so a taken id mints a fresh one.
func (s *Server) promotionSaveInput(ctx context.Context, deviceID string, source store.AgentProfileProjection) (store.SaveProfileInput, bool, error) {
	copied := store.SaveProfileInput{
		Runtime:        source.Runtime,
		Label:          source.Label,
		ConnectionType: source.ConnectionType,
		BaseURL:        source.BaseURL,
		Model:          source.Model,
		Models:         source.Models,
	}
	profileID, err := s.store.ProfilePromotionFor(ctx, deviceID, source.ID)
	if errors.Is(err, store.ErrNotFound) {
		copied.ID = source.ID
		copied.PromptPrefix = source.PromptPrefix
		copied.ClaudeEffort = source.ClaudeEffort
		copied.ClaudePermissionMode = source.ClaudePermissionMode
		copied.CodexReasoningEffort = source.CodexReasoningEffort
		copied.CodexSandboxMode = source.CodexSandboxMode
		copied.CodexApprovalPolicy = source.CodexApprovalPolicy
		copied.CodexSpeed = source.CodexSpeed
		if _, err := s.store.GetProfile(ctx, source.ID); err == nil {
			copied.ID = ""
		} else if !errors.Is(err, store.ErrProfileNotFound) {
			return store.SaveProfileInput{}, false, err
		}
		return copied, false, nil
	}
	if err != nil {
		return store.SaveProfileInput{}, false, err
	}
	current, err := s.store.GetProfile(ctx, profileID)
	if err != nil {
		return store.SaveProfileInput{}, false, err
	}
	updated := profileSaveInput(current)
	updated.Runtime = copied.Runtime
	updated.Label = copied.Label
	updated.ConnectionType = copied.ConnectionType
	updated.BaseURL = copied.BaseURL
	if copied.Model != "" {
		updated.Model = copied.Model
	}
	updated.Models = append(append([]string{}, copied.Models...), current.Models...)
	return updated, true, nil
}

// profileSaveInput is a stored profile as the input that saves it unchanged.
func profileSaveInput(profile store.ProfileDefinition) store.SaveProfileInput {
	return store.SaveProfileInput{
		ID:                   profile.ID,
		Runtime:              profile.Runtime,
		Label:                profile.Label,
		AuthMode:             profile.AuthMode,
		ConnectionType:       profile.ConnectionType,
		BaseURL:              profile.BaseURL,
		Model:                profile.Model,
		Models:               profile.Models,
		ContextWindows:       profile.ContextWindows,
		PromptPrefix:         profile.PromptPrefix,
		ClaudeEffort:         profile.ClaudeEffort,
		ClaudePermissionMode: profile.ClaudePermissionMode,
		CodexReasoningEffort: profile.CodexReasoningEffort,
		CodexSandboxMode:     profile.CodexSandboxMode,
		CodexApprovalPolicy:  profile.CodexApprovalPolicy,
		CodexSpeed:           profile.CodexSpeed,
		CodexTransport:       profile.CodexTransport,
		OwnerUserID:          profile.OwnerUserID,
	}
}

// errPromotionKeyUnavailable reports a key the provider's configuration does
// not name or the device does not have: the person's setup, not a fault.
var errPromotionKeyUnavailable = errors.New("no key to copy")

// promotionKey is the credential promotion seals: either a key the server
// already holds for the device provider (moved, never re-read) or the value
// the device read.
type promotionKey struct {
	sealedID string
	value    string
}

// readPromotionKey gets the provider's key for sealing. A key the server
// already holds for this device provider is moved as it is. Otherwise the
// device reads the one key the provider's configuration names; the request
// names the provider, never a variable, so no other value can be asked for.
func (s *Server) readPromotionKey(ctx context.Context, deviceID string, sourceID string) (promotionKey, error) {
	sealedID := agentProfileSecretID(deviceID, sourceID)
	if stored, err := s.store.HasSecret(ctx, sealedID); err != nil {
		return promotionKey{}, err
	} else if stored {
		return promotionKey{sealedID: sealedID}, nil
	}
	requestCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	keySource, credential, err := s.hub.ReadProviderKey(requestCtx, deviceID, sourceID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return promotionKey{}, errors.New("the device is not connected, so its key cannot be read")
	case errors.Is(err, context.DeadlineExceeded):
		return promotionKey{}, errors.New("the device did not answer the key request; update its worker and try again")
	case err != nil:
		return promotionKey{}, err
	case keySource == "":
		return promotionKey{}, fmt.Errorf("%w: this provider's configuration names no key", errPromotionKeyUnavailable)
	case strings.TrimSpace(credential) == "":
		return promotionKey{}, fmt.Errorf("%w: %s has no value on the device", errPromotionKeyUnavailable, keySource)
	}
	return promotionKey{value: strings.TrimSpace(credential)}, nil
}

func (s *Server) storePromotionKey(ctx context.Context, key promotionKey, profileID string) error {
	if key.sealedID != "" {
		return s.store.RenameSecret(ctx, key.sealedID, serverProfileSecretID(profileID))
	}
	return s.sealServerProfileCredential(ctx, profileID, key.value)
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
	if message, err := s.deviceBoundConflict(r.Context(), deviceID, input.ProfileIDs); err != nil {
		writeResult(w, nil, err)
		return
	} else if message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	if err := s.store.SetDeviceProfiles(r.Context(), input); err != nil {
		writeProfileResult(w, store.ProfileDefinition{}, err)
		return
	}
	bindings, err := s.store.ListDeviceProfiles(r.Context(), deviceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	s.projectionsChanged("", connectionFields...)
	writeResult(w, bindings, nil)
}

// deviceBoundConflict refuses to newly enable, on another device, a profile
// promoted from a provider at its device's own loopback address: no other
// device reaches that address. A binding that already exists is left alone,
// so one stale row never blocks every later change to the device's set.
func (s *Server) deviceBoundConflict(ctx context.Context, deviceID string, profileIDs []string) (string, error) {
	current, err := s.store.ListDeviceProfiles(ctx, deviceID)
	if err != nil {
		return "", err
	}
	enabled := map[string]bool{}
	for _, binding := range current {
		enabled[binding.ProfileID] = binding.Enabled
	}
	for _, profileID := range profileIDs {
		profileID = strings.TrimSpace(profileID)
		if profileID == "" || enabled[profileID] {
			continue
		}
		profile, err := s.store.GetProfile(ctx, profileID)
		if errors.Is(err, store.ErrProfileNotFound) {
			continue
		}
		if err != nil {
			return "", err
		}
		if from := profile.PromotedFrom; from != nil && from.DeviceBound && from.DeviceID != deviceID {
			return profile.Label + " calls " + profile.BaseURL + ", the loopback address of the device it was promoted from, so it can run only on that device", nil
		}
	}
	return "", nil
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
	if !secretsConfigured(s.store) {
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

// agentProfileInputFromProjection shapes a listed profile the same way, so a
// caller that only knows a profile id can ask for its catalog.
func agentProfileInputFromProjection(profile store.AgentProfileProjection) store.CreateAgentProfileInput {
	return store.CreateAgentProfileInput{
		ID:                   profile.ID,
		DeviceID:             profile.DeviceID,
		Runtime:              profile.Runtime,
		Label:                profile.Label,
		ConfigScope:          profile.ConfigScope,
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
	if secretsConfigured(h.store) {
		stored, err := h.store.HasSecret(
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
			!sameProviderEndpoint(profile.Runtime, profile.BaseURL, local.BaseURL) ||
			deviceLocalConnectionType(profile.ConnectionType) {
			continue
		}
		if !secretsConfigured(h.store) {
			continue
		}
		hasCredential, err := h.store.HasSecret(
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
		row := serverProfileRow(device, profile, health, s.profileHasCredential(ctx, profile.ID))
		// The device row is kept rather than replaced: the machine really does
		// carry this configuration, and hiding it made a promoted profile look
		// like it had vanished from the device.
		agentProfiles = markPromotedDeviceProfile(agentProfiles, device.ID, profile)
		agentProfiles = upsertAgentProfileRow(agentProfiles, row)
		// An agent is a profile on the machine that runs this workspace, so a
		// binding on any other device contributes no selectable agent here.
		if workspace.ID == "" || device.ID != workspaceDeviceID {
			continue
		}
		agents = upsertAgentRow(agents, serverAgentRow(workspace, device, row))
	}
	return agentProfiles, agents, nil
}

// serverProfileRow is a server profile as the device it is enabled on runs
// it, with that device's status for it.
func serverProfileRow(device store.DeviceProjection, profile store.ProfileDefinition, health []store.ProviderHealth, hasCredential bool) store.AgentProfileProjection {
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
	return store.AgentProfileProjection{
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
	}
}

// serverAgentRow is a server profile's row as the agent it is in a
// workspace on the row's device.
func serverAgentRow(workspace store.WorkspaceProjection, device store.DeviceProjection, row store.AgentProfileProjection) store.AgentProjection {
	return store.AgentProjection{
		ID:             store.ServerAgentID(device.ID, workspace.ID, row.ID),
		WorkspaceID:    workspace.ID,
		DeviceID:       device.ID,
		DeviceLabel:    device.Label,
		Provider:       row.Runtime,
		ProfileID:      row.ID,
		ProfileLabel:   row.Label,
		ConnectionType: row.ConnectionType,
		Status:         row.Status,
		AuthMode:       row.AuthMode,
		SecretStored:   row.SecretStored,
		ConfigScope:    row.ConfigScope,
		ConfigLabel:    row.ConfigLabel,
		LastSeenLabel:  row.LastSeenLabel,
		StatusDetail:   row.StatusDetail,
	}
}

// markPromotedDeviceProfile flags the daemon-reported row that describes the
// same endpoint as a server profile. Matching is by the recorded promotion
// source, by id or by endpoint: promotion reuses the daemon's id when it is
// free, while a profile discovered later only matches on runtime and base URL.
func markPromotedDeviceProfile(rows []store.AgentProfileProjection, deviceID string, profile store.ProfileDefinition) []store.AgentProfileProjection {
	for i := range rows {
		row := rows[i]
		if row.Origin != profileOriginDevice || row.DeviceID != deviceID {
			continue
		}
		sameEndpoint := row.Runtime == profile.Runtime &&
			row.BaseURL != "" &&
			sameProviderEndpoint(profile.Runtime, row.BaseURL, profile.BaseURL)
		promotedFrom := profile.PromotedFrom != nil &&
			profile.PromotedFrom.DeviceID == deviceID &&
			profile.PromotedFrom.ProfileID == row.ID
		if row.ID == profile.ID || sameEndpoint || promotedFrom {
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
