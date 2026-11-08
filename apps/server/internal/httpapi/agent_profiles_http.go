package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func (s *Server) handleListAgentProfiles(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := actorFromContext(ctx)
	deviceID := r.URL.Query().Get("deviceId")
	if actor.Agent() {
		// A session token only ever sees its own device's profiles.
		deviceID = actor.Identity.DeviceID
	}
	items, err := s.deviceAgentProfiles(ctx, actor, deviceID)
	writeResult(w, items, err)
}

// deviceAgentProfiles are the profiles a device runs, as the caller sees
// them: what the device reported, and the model services set up in Foundry
// that the caller owns and assigned to it (origin "server", with their base
// URL; never a key). "" lists every device the caller sees.
func (s *Server) deviceAgentProfiles(ctx context.Context, actor Actor, deviceID string) ([]store.AgentProfileProjection, error) {
	view, err := s.visibilityFor(ctx, actor)
	if err != nil {
		return nil, err
	}
	items, err := s.store.ListAgentProfiles(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	items = filterByDevice(view, s.overlayServerCredential(ctx, items),
		func(item store.AgentProfileProjection) string { return item.DeviceID })

	// The device's own rows still answer when the server's cannot be read.
	devices, err := s.store.ListDevices(ctx)
	if err == nil {
		profiles, err := s.store.ListProfiles(ctx)
		if err == nil {
			bindings, err := s.store.ListDeviceProfiles(ctx, deviceID)
			if err == nil {
				projected, _, err := s.serverProfileProjections(ctx, store.WorkspaceProjection{}, devices, s.overlayProfileCredentials(ctx, view.filterConnections(profiles)), bindings, items, nil)
				if err == nil {
					items = projected
				}
			}
		}
	}
	return items, nil
}

func (s *Server) handleCreateAgentProfile(w http.ResponseWriter, r *http.Request) {
	var input store.CreateAgentProfileInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if message := checkDeviceProfileInput(&input); message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	if strings.TrimSpace(input.APIKey) != "" && !secretsConfigured(s.store) {
		writeError(w, http.StatusBadRequest, "apiKey storage requires the server secret store; start the server with FOUNDRY_SECRET_KEY_PATH")
		return
	}
	// Never fall back to "any connected daemon": the profile is written on
	// the named device, which the caller must own.
	if !s.requireDeviceOwner(w, r, strings.TrimSpace(input.DeviceID)) {
		return
	}
	profile, err := s.saveDeviceProfile(r.Context(), input)
	writeResultWithStatus(w, http.StatusCreated, profile, err)
}

// checkDeviceProfileInput validates a device profile write in place and
// answers the first problem, or "".
func checkDeviceProfileInput(input *store.CreateAgentProfileInput) string {
	windows := store.SaveProfileInput{ContextWindows: input.ContextWindows}
	if message := normalizeContextWindows(&windows); message != "" {
		return message
	}
	input.ContextWindows = windows.ContextWindows
	if input.Command != "" || len(input.Env) > 0 {
		return "command and env are local-only profile fields"
	}
	if strings.TrimSpace(input.Runtime) == "" || strings.TrimSpace(input.Label) == "" {
		return "runtime and label are required"
	}
	if strings.TrimSpace(input.BaseURL) != "" && !deviceLocalConnectionType(input.ConnectionType) {
		baseURL, _, code := normalizeProviderBaseURL(strings.TrimSpace(input.Runtime), input.BaseURL, true)
		if code != "" {
			return endpointErrorMessages[code]
		}
		input.BaseURL = baseURL
	}
	return ""
}

// saveDeviceProfile writes a profile (its defaults included) on the device
// that runs it, sealing a key it carries on the server. The caller has
// validated the input and decided the person owns the device.
func (s *Server) saveDeviceProfile(ctx context.Context, input store.CreateAgentProfileInput) (store.AgentProfileProjection, error) {
	credential := strings.TrimSpace(input.APIKey)
	input.APIKey = ""
	if credential != "" && !secretsConfigured(s.store) {
		return store.AgentProfileProjection{}, &statusError{http.StatusBadRequest, errors.New("apiKey storage requires the server secret store; start the server with FOUNDRY_SECRET_KEY_PATH")}
	}
	requestCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	profile, err := s.hub.UpsertAgentProfile(requestCtx, input)
	if errors.Is(err, store.ErrNotFound) {
		return store.AgentProfileProjection{}, &statusError{http.StatusConflict, errors.New("local daemon is not connected")}
	}
	if err != nil {
		return store.AgentProfileProjection{}, &statusError{http.StatusBadGateway, err}
	}
	if credential != "" {
		if err := s.sealProfileCredential(ctx, profile.DeviceID, profile.ID, credential); err != nil {
			return store.AgentProfileProjection{}, err
		}
		// The device's agent profile now shows a server credential.
		s.projectionsChanged("", fieldAgentProfiles, fieldAgents)
		profile.ServerCredential = true
	} else if stored, err := s.store.HasSecret(ctx, agentProfileSecretID(profile.DeviceID, profile.ID)); err == nil {
		profile.ServerCredential = stored
	}
	s.modelCatalogs.forgetProfile(profile.DeviceID, profile.ID)
	hydrateDeviceProfile(&profile)
	return profile, nil
}

func (s *Server) handleListAgentModels(w http.ResponseWriter, r *http.Request) {
	var input listAgentModelsRequest
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	actor := actorFromContext(r.Context())
	if !s.canUseModelCatalog(r, input.Profile) {
		writeError(w, http.StatusNotFound, "profile not found")
		return
	}
	models, err := s.readAgentModels(r.Context(), actor, input.Profile, input.Refresh)
	writeResult(w, models, err)
}

func (s *Server) listAgentModels(ctx context.Context, actor Actor, profile store.CreateAgentProfileInput) (any, error) {
	return s.readAgentModels(ctx, actor, profile, false)
}

// readAgentModels asks a profile's device for its model catalog, answering
// from the server's copy unless refresh (agent_model_catalog.go). A session
// token is confined to its own device and workspace. A refusal is a
// statusError; any other err is an ordinary failure.
func (s *Server) readAgentModels(ctx context.Context, actor Actor, profile store.CreateAgentProfileInput, refresh bool) (any, error) {
	if profile.Command != "" || len(profile.Env) > 0 {
		return nil, &statusError{http.StatusBadRequest, errors.New("command and env are local-only profile fields")}
	}
	if actor.Agent() && (profile.DeviceID == "" || profile.DeviceID == actor.Identity.DeviceID) {
		profile.DeviceID = actor.Identity.DeviceID
		profile.WorkspaceID = actor.Identity.WorkspaceID
	}
	// Runtime and account changes must not reuse a catalog from the old executable.
	var runtimeGeneration string
	if health, err := s.store.ListProviderHealth(ctx, profile.DeviceID); err == nil {
		for _, item := range health {
			if item.Provider == profile.Runtime && item.Cli != nil {
				runtimeGeneration = item.Cli.Generation + ":" + item.AccountLabel
			}
		}
	}
	s.injectModelListCredential(ctx, &profile)
	models, err := s.modelCatalogs.list(ctx, profile, runtimeGeneration, refresh, s.hub.ListAgentModels)
	if errors.Is(err, store.ErrNotFound) {
		return nil, &statusError{http.StatusConflict, errors.New("local daemon is not connected")}
	}
	return models, err
}

func (s *Server) handleListAgents(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	workspaceID := requestedWorkspace(actor, r.URL.Query().Get("workspaceId"))
	items, err := s.store.ListAgents(r.Context(), workspaceID, r.URL.Query().Get("deviceId"))
	writeResult(w, items, err)
}
