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
	actor := actorFromContext(r.Context())
	deviceID := r.URL.Query().Get("deviceId")
	if actor.Agent() {
		// A session token only ever sees its own device's profiles.
		deviceID = actor.Identity.DeviceID
	}
	view, err := s.visibilityFor(r.Context(), actor)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	items, err := s.store.ListAgentProfiles(r.Context(), deviceID)
	if err == nil {
		items = filterByDevice(view, s.overlayServerCredential(r.Context(), items),
			func(item store.AgentProfileProjection) string { return item.DeviceID })
	}
	writeResult(w, items, err)
}

func (s *Server) handleCreateAgentProfile(w http.ResponseWriter, r *http.Request) {
	var input store.CreateAgentProfileInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	windows := store.SaveProfileInput{ContextWindows: input.ContextWindows}
	if message := normalizeContextWindows(&windows); message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}
	input.ContextWindows = windows.ContextWindows
	credential := strings.TrimSpace(input.APIKey)
	input.APIKey = ""
	if input.Command != "" || len(input.Env) > 0 {
		writeError(w, http.StatusBadRequest, "command and env are local-only profile fields")
		return
	}
	if credential != "" && !secretsConfigured(s.store) {
		writeError(w, http.StatusBadRequest, "apiKey storage requires the server secret store; start the server with FOUNDRY_SECRET_KEY_PATH")
		return
	}
	if strings.TrimSpace(input.Runtime) == "" || strings.TrimSpace(input.Label) == "" {
		writeError(w, http.StatusBadRequest, "runtime and label are required")
		return
	}
	// Never fall back to "any connected daemon": the profile is written on
	// the named device, which the caller must own.
	if !s.requireDeviceOwner(w, r, strings.TrimSpace(input.DeviceID)) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	profile, err := s.hub.UpsertAgentProfile(ctx, input)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "local daemon is not connected")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if credential != "" {
		if err := s.sealProfileCredential(r.Context(), profile.DeviceID, profile.ID, credential); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		// The device's agent profile now shows a server credential.
		s.projectionsChanged("", fieldAgentProfiles, fieldAgents)
		profile.ServerCredential = true
	} else if stored, err := s.store.HasSecret(r.Context(), agentProfileSecretID(profile.DeviceID, profile.ID)); err == nil {
		profile.ServerCredential = stored
	}
	s.modelCatalogs.forgetProfile(profile.DeviceID, profile.ID)
	hydrateDeviceProfile(&profile)
	writeResultWithStatus(w, http.StatusCreated, profile, nil)
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
	if health, err := s.store.ListProviderHealth(ctx, profile.DeviceID); err == nil {
		for _, item := range health {
			if item.Provider == profile.Runtime && item.Cli != nil {
				profile.RuntimeGeneration = item.Cli.Generation + ":" + item.AccountLabel
			}
		}
	}
	s.injectModelListCredential(ctx, &profile)
	models, err := s.modelCatalogs.list(ctx, profile, refresh, s.hub.ListAgentModels)
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
