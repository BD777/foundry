package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// DemoResetter is an optional store capability used only by the dev-only
// POST /api/dev/reset-demo endpoint. It is intentionally kept out of the
// main store.Store interface so production stores don't need to implement
// demo seeding concerns.
type DemoResetter interface {
	ResetDemo(ctx context.Context) error
}

type Server struct {
	projections        projectionCache
	issueMutationLocks sync.Map
	titles             *chatTitleService
	events             *browserEventHub
	hub                *DaemonHub
	feishu             *feishu.WSManager
	options            ServerOptions
	startedAt          time.Time
	store              store.Store
	secrets            secretKeeper
	accounts           store.AccountStore
	loginLimiter       *loginLimiter
	setupMu            sync.Mutex
	setupCode          string
	// testActor authenticates every browser request in package tests, and
	// testFullAccess lets it reach every workspace and device so handler
	// tests exercise behaviour, not membership. Authorization tests use real
	// accounts instead.
	testActor      *Actor
	testFullAccess bool
}

type healthResponse struct {
	Status    string `json:"status"`
	StartedAt string `json:"startedAt"`
}

func NewServerWithOptions(store store.Store, options ServerOptions) *Server {
	options = normalizeServerOptions(options)
	events := newBrowserEventHub()
	server := &Server{
		events:       events,
		hub:          NewDaemonHub(store, events, options.AllowedOrigin),
		options:      options,
		startedAt:    time.Now().UTC(),
		store:        store,
		loginLimiter: newLoginLimiter(),
	}
	server.initAccounts()
	if keeper, ok := store.(secretKeeper); ok {
		server.secrets = keeper
		server.hub.secrets = keeper
	}
	server.titles = &chatTitleService{store: store, dispatch: server.hub.DispatchAgentSession, connected: server.hub.HasConnection, publish: events.Publish}
	server.hub.onSessionCompleted = server.titles.SessionCompleted
	server.hub.onEvidenceConnected = server.recoverEvidenceVerifications
	server.feishu = feishu.NewWSManager(store, server.secrets, server)
	server.events.SubscribeInternal(server.feishu.HandleInternalEvent)
	go server.feishu.StartAllConfiguredBots(context.Background())
	return server
}

// Shutdown terminates the protocol-specific resources that net/http's own
// Shutdown cannot reach: SSE handlers block in their own loop rather than in
// a request the server tracks, and hijacked WebSockets leave http.Server's
// accounting entirely. Call it before or during http.Server.Shutdown. It is
// idempotent and safe to call concurrently.
func (s *Server) Shutdown(ctx context.Context) error {
	if s.feishu != nil {
		s.feishu.StopAll()
	}
	s.events.Shutdown()
	return s.hub.Shutdown(ctx)
}

func (s *Server) PublishEvent(eventType string, payload any) {
	s.events.Publish(eventType, payload)
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("OPTIONS /", s.handleOptions)
	mux.HandleFunc("GET /healthz", s.handleHealth)
	for _, route := range s.routeTable() {
		mux.Handle(route.pattern, s.guard(route.rule, route.handler))
	}
	if s.options.WebDistDir != "" {
		mux.Handle("GET /{path...}", s.serveWeb(s.options.WebDistDir))
	}
	return withCORS(s.options.AllowedOrigin, s.withAuthentication(enforceAgentRoute(mux)))
}

func (s *Server) handleOptions(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, healthResponse{
		Status:    "ok",
		StartedAt: s.startedAt.Format(time.RFC3339),
	})
}

func (s *Server) handleFoundryData(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	workspaceID, allowed := effectiveWorkspace(actor, r.URL.Query().Get("workspaceId"))
	if !allowed {
		writeForbidden(w, "workspace is outside the token's scope")
		return
	}
	view, err := s.visibilityFor(r.Context(), actor)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	started := time.Now()
	// The projection is per caller: the key carries the caller's reach, so a
	// membership change never serves a stale view.
	cacheKey := workspaceID + "|" + view.scope.fingerprint()
	payload, err := s.projections.load(r.Context(), cacheKey, s.events.revision.Load, func() ([]byte, bool, error) {
		data, err := s.foundryData(r.Context(), workspaceID, view)
		if err != nil {
			return nil, false, err
		}
		cacheable := true
		for _, session := range data.AgentSessions {
			if isRecoverableAgentSessionStatus(session.Status) {
				cacheable = false
				break
			}
		}
		encoded, err := json.Marshal(data)
		return encoded, cacheable, err
	})
	w.Header().Set("Server-Timing", fmt.Sprintf("projection;dur=%.3f", float64(time.Since(started).Microseconds())/1000))
	if err != nil {
		writeResult(w, payload, err)
		return
	}
	writeCacheableJSON(w, r, payload)
}

// foundryData projects what one caller may see: visible workspaces, the
// devices it owns or reaches through them, and its own connections.
func (s *Server) foundryData(ctx context.Context, workspaceID string, view visibility) (store.FoundryDataProjection, error) {
	workspaces := view.workspaces
	if view.scope.all {
		all, err := s.store.ListWorkspaces(ctx)
		if err != nil {
			return store.FoundryDataProjection{}, err
		}
		workspaces = view.scope.filterWorkspaces(all)
	}
	if workspaceID != "" && !view.scope.can(workspaceID, store.WorkspaceRoleViewer) {
		return store.FoundryDataProjection{}, store.ErrNotFound
	}
	workspace, err := selectWorkspace(ctx, s.store, workspaces, workspaceID)
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	if workspace.ID != "" {
		workspace.AccessRole = view.scope.role(workspace.ID)
	}
	allDevices, err := s.store.ListDevices(ctx)
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	devices := view.filterDevices(allDevices)
	allProfiles, err := s.store.ListProfiles(ctx)
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	profiles := s.overlayProfileCredentials(ctx, view.filterConnections(allProfiles))
	deviceProfiles, err := s.store.ListDeviceProfiles(ctx, "")
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	deviceProfiles = filterOwnedDevice(view, deviceProfiles, func(item store.DeviceProfileBinding) string { return item.DeviceID })
	providerHealth, err := s.store.ListProviderHealth(ctx, "")
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	providerHealth = filterByDevice(view, providerHealth, func(item store.ProviderHealth) string { return item.DeviceID })
	agentProfiles, err := s.store.ListAgentProfiles(ctx, "")
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	agentProfiles = filterByDevice(view, s.overlayServerCredential(ctx, agentProfiles),
		func(item store.AgentProfileProjection) string { return item.DeviceID })
	if workspace.ID == "" {
		// Server profiles exist before any workspace does, so the settings and
		// devices views stay accurate on a fresh install.
		serverProfiles, _, err := s.serverProfileProjections(ctx, workspace, devices, profiles, deviceProfiles, agentProfiles, []store.AgentProjection{})
		if err != nil {
			return store.FoundryDataProjection{}, err
		}
		return store.FoundryDataProjection{
			Workspace:      workspace,
			Workspaces:     workspaces,
			Devices:        devices,
			ProviderHealth: providerHealth,
			AgentProfiles:  serverProfiles,
			Profiles:       profiles,
			DeviceProfiles: deviceProfiles,
			Agents:         []store.AgentProjection{},
			WorkspaceFiles: []store.WorkspaceFileEntry{},
			AgentSessions:  []store.AgentSession{},
			Skills:         []store.SkillPackRef{},
			Issues:         []store.Issue{},
			Chats:          []store.ChatThread{},
			Assets:         []store.AssetProjection{},
		}, nil
	}
	deviceID := strings.TrimSpace(workspace.DeviceID)
	agents, err := s.store.ListAgents(ctx, workspace.ID, deviceID)
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	agentProfiles, agents, err = s.serverProfileProjections(ctx, workspace, devices, profiles, deviceProfiles, agentProfiles, agents)
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	workspaceFiles, err := s.store.ListWorkspaceFiles(ctx, workspace.ID)
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	agentSessions, err := s.store.ListAgentSessionSummaries(ctx, workspace.ID)
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	agentSessions = summarizeAgentSessionsForList(s.reconcileAgentSessions(ctx, agentSessions))
	assets, err := s.store.ListAssets(ctx, workspace.ID)
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	skills, err := s.store.ListSkills(ctx, workspace.ID)
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	issues, err := s.store.ListIssues(ctx, workspace.ID)
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	chats, err := s.store.ListChats(ctx, workspace.ID)
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	runs, err := s.store.ListRuns(ctx, workspace.ID)
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	promotedSkills, err := s.store.ListPromotedSkills(ctx)
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	deviceSkills, err := s.store.ListDeviceSkills(ctx, "")
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	deviceSkills = filterOwnedDevice(view, deviceSkills, func(item store.DeviceSkill) string { return item.DeviceID })
	deviceSkillRoots, err := s.allEffectiveSkillRoots(ctx, devices)
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	deviceSkillRoots = filterOwnedDevice(view, deviceSkillRoots, func(item store.DeviceSkillRoot) string { return item.DeviceID })
	workspaceSkillBindings, err := s.store.ListWorkspaceSkillBindings(ctx, workspace.ID)
	if err != nil {
		return store.FoundryDataProjection{}, err
	}
	return store.FoundryDataProjection{
		Runs:                   runs,
		Workspace:              workspace,
		Workspaces:             workspaces,
		Devices:                devices,
		ProviderHealth:         providerHealth,
		AgentProfiles:          agentProfiles,
		Profiles:               profiles,
		DeviceProfiles:         deviceProfiles,
		DeviceSkillRoots:       deviceSkillRoots,
		DeviceSkills:           deviceSkills,
		PromotedSkills:         promotedSkills,
		WorkspaceSkillBindings: workspaceSkillBindings,
		Agents:                 agents,
		WorkspaceFiles:         workspaceFiles,
		AgentSessions:          agentSessions,
		Skills:                 skills,
		Issues:                 issues,
		Chats:                  chats,
		Assets:                 assets,
	}, nil
}

// allEffectiveSkillRoots reports every device's effective scan roots in one
// list so the global device-skills views do not issue N store reads.
func (s *Server) allEffectiveSkillRoots(ctx context.Context, devices []store.DeviceProjection) ([]store.DeviceSkillRoot, error) {
	custom, err := s.store.ListDeviceSkillRoots(ctx, "")
	if err != nil {
		return nil, err
	}
	byDevice := map[string][]store.DeviceSkillRoot{}
	for _, root := range custom {
		byDevice[root.DeviceID] = append(byDevice[root.DeviceID], root)
	}
	isDefault := map[string]bool{}
	for _, path := range defaultSkillRoots {
		isDefault[path] = true
	}
	result := []store.DeviceSkillRoot{}
	for _, device := range devices {
		rows := byDevice[device.ID]
		if len(rows) == 0 {
			for _, path := range defaultSkillRoots {
				result = append(result, store.DeviceSkillRoot{DeviceID: device.ID, Path: path, IsDefault: true})
			}
			continue
		}
		for _, root := range rows {
			root.IsDefault = isDefault[root.Path]
			result = append(result, root)
		}
	}
	return result, nil
}

func selectWorkspace(ctx context.Context, st store.Store, workspaces []store.WorkspaceProjection, workspaceID string) (store.WorkspaceProjection, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID != "" {
		return st.GetWorkspace(ctx, workspaceID)
	}
	if len(workspaces) > 0 {
		return workspaces[0], nil
	}
	return store.WorkspaceProjection{
		ID:             "",
		Name:           "No workspace",
		LocalPath:      "Run local daemon setup",
		Baseline:       "main",
		ContextSummary: "No local daemon has registered a workspace yet.",
		AcceptedCount:  0,
		ResolvedCount:  0,
	}, nil
}

func (s *Server) handleListWorkspaces(w http.ResponseWriter, r *http.Request) {
	view, err := s.visibilityFor(r.Context(), actorFromContext(r.Context()))
	writeResult(w, view.workspaces, err)
}

func (s *Server) handleGetWorkspace(w http.ResponseWriter, r *http.Request) {
	item, err := s.store.GetWorkspace(r.Context(), r.PathValue("id"))
	if err == nil {
		scope, scopeErr := s.requestScope(r)
		if scopeErr != nil {
			writeResult(w, nil, scopeErr)
			return
		}
		item.AccessRole = scope.role(item.ID)
	}
	writeResult(w, item, err)
}

func (s *Server) handleCreateWorkspace(w http.ResponseWriter, r *http.Request) {
	var input store.CreateWorkspaceInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceOwner(w, r, strings.TrimSpace(input.DeviceID)) {
		return
	}
	path := strings.TrimSpace(input.Path)
	if path == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	item, err := s.hub.SetupWorkspace(ctx, strings.TrimSpace(input.DeviceID), path)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "local daemon is not connected")
		return
	}
	writeResultWithStatus(w, http.StatusCreated, item, err)
}

func (s *Server) handleRenameWorkspace(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name string `json:"name"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	name := strings.TrimSpace(input.Name)
	if name == "" || len([]rune(name)) > 120 || strings.ContainsAny(name, "\r\n\t") {
		writeError(w, http.StatusBadRequest, "display name must be 1–120 characters on one line")
		return
	}
	item, err := s.store.RenameWorkspace(r.Context(), r.PathValue("id"), name)
	writeResult(w, item, err)
}

func (s *Server) handleDeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "workspace id is required")
		return
	}
	workspace, err := s.store.DeleteWorkspace(r.Context(), id)
	if errors.Is(err, store.ErrWorkspaceBusy) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if s.feishu != nil {
		s.feishu.StopBot(id)
	}
	if workspace.DeviceID != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := s.hub.ForgetWorkspace(ctx, workspace); err != nil && !errors.Is(err, store.ErrNotFound) {
			log.Printf("daemon forget workspace failed id=%s path=%s: %v", workspace.ID, workspace.LocalPath, err)
		}
	}
	writeResult(w, workspace, nil)
}

func (s *Server) handleListWorkspaceSubdirectories(w http.ResponseWriter, r *http.Request) {
	var input store.CreateWorkspaceInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceOwner(w, r, strings.TrimSpace(input.DeviceID)) {
		return
	}
	path := strings.TrimSpace(input.Path)
	if path == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	items, err := s.hub.ListSubdirectories(ctx, strings.TrimSpace(input.DeviceID), path)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "local daemon is not connected")
		return
	}
	writeResult(w, items, err)
}

func (s *Server) handleListDevices(w http.ResponseWriter, r *http.Request) {
	view, err := s.visibilityFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	items, err := s.store.ListDevices(r.Context())
	writeResult(w, view.filterDevices(items), err)
}

func (s *Server) handleUpsertAgentRuntimeSettings(w http.ResponseWriter, r *http.Request) {
	var input store.UpsertAgentRuntimeSettingsInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceOwner(w, r, strings.TrimSpace(input.DeviceID)) {
		return
	}
	if input.Settings.ActiveRuntimeTtlMs <= 0 {
		writeError(w, http.StatusBadRequest, "activeRuntimeTtlMs must be positive")
		return
	}
	if input.Settings.MaxConcurrentTasks < 1 || input.Settings.MaxConcurrentTasks > 16 {
		writeError(w, http.StatusBadRequest, "maxConcurrentTasks must be between 1 and 16")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	settings, err := s.hub.UpsertAgentRuntimeSettings(ctx, input)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "local daemon is not connected")
		return
	}
	writeResult(w, settings, err)
}

func (s *Server) handleProviderHealth(w http.ResponseWriter, r *http.Request) {
	view, err := s.visibilityFor(r.Context(), actorFromContext(r.Context()))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	items, err := s.store.ListProviderHealth(r.Context(), r.URL.Query().Get("deviceId"))
	writeResult(w, filterByDevice(view, items, func(item store.ProviderHealth) string { return item.DeviceID }), err)
}

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
	credential := strings.TrimSpace(input.APIKey)
	input.APIKey = ""
	if input.Command != "" || len(input.Env) > 0 {
		writeError(w, http.StatusBadRequest, "command and env are local-only profile fields")
		return
	}
	if credential != "" && !secretsConfigured(s.secrets) {
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
		profile.ServerCredential = true
	} else if s.secrets != nil {
		if stored, err := s.secrets.HasSecret(r.Context(), agentProfileSecretID(profile.DeviceID, profile.ID)); err == nil {
			profile.ServerCredential = stored
		}
	}
	hydrateDeviceProfile(&profile)
	writeResultWithStatus(w, http.StatusCreated, profile, nil)
}

func (s *Server) handleListAgentModels(w http.ResponseWriter, r *http.Request) {
	var input store.ListAgentModelsInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !actorFromContext(r.Context()).Agent() && !s.canUseModelCatalog(r, input.Profile) {
		writeError(w, http.StatusNotFound, "profile not found")
		return
	}
	if input.Profile.Command != "" || len(input.Profile.Env) > 0 {
		writeError(w, http.StatusBadRequest, "command and env are local-only profile fields")
		return
	}
	if actor := actorFromContext(r.Context()); actor.Agent() {
		if input.Profile.DeviceID != "" && input.Profile.DeviceID != actor.Identity.DeviceID {
			writeForbidden(w, "session token can only query models on its own device")
			return
		}
		input.Profile.DeviceID = actor.Identity.DeviceID
		input.Profile.WorkspaceID = actor.Identity.WorkspaceID
	}
	s.injectModelListCredential(r.Context(), &input.Profile)
	// A cold CLI catalog on macOS pays a one-time code-signing check that can run
	// past half a minute, so the wait is generous rather than optimistic.
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	models, err := s.hub.ListAgentModels(ctx, input.Profile)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "local daemon is not connected")
		return
	}
	writeResult(w, models, err)
}

func (s *Server) handleListAgents(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	workspaceID, allowed := effectiveWorkspace(actor, r.URL.Query().Get("workspaceId"))
	if !allowed {
		writeForbidden(w, "workspace is outside the token's scope")
		return
	}
	deviceID := r.URL.Query().Get("deviceId")
	if actor.Agent() {
		deviceID = actor.Identity.DeviceID
	}
	items, err := s.store.ListAgents(r.Context(), workspaceID, deviceID)
	writeResult(w, items, err)
}

func (s *Server) handleListWorkspaceFiles(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListWorkspaceFiles(r.Context(), r.URL.Query().Get("workspaceId"))
	writeResult(w, items, err)
}

func (s *Server) handleReadWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimSpace(r.URL.Query().Get("workspaceId"))
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if workspaceID == "" || path == "" {
		writeError(w, http.StatusBadRequest, "workspaceId and path are required")
		return
	}
	workspace, err := s.store.GetWorkspace(r.Context(), workspaceID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	result, err := s.hub.ReadWorkspaceFile(ctx, workspace, path)
	writeResult(w, result, err)
}

// handleListWorkspaceTree lists one folder of the workspace for the file
// browser; the device refuses paths outside the workspace.
func (s *Server) handleListWorkspaceTree(w http.ResponseWriter, r *http.Request) {
	workspace, err := s.store.GetWorkspace(r.Context(), strings.TrimSpace(r.URL.Query().Get("workspaceId")))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	entries, err := s.hub.ListWorkspaceTree(ctx, workspace, strings.TrimSpace(r.URL.Query().Get("path")))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "local daemon is not connected")
		return
	}
	writeResult(w, entries, err)
}

func (s *Server) handleListAssets(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListAssets(r.Context(), r.URL.Query().Get("workspaceId"))
	writeResult(w, items, err)
}

func (s *Server) handleListSkills(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListSkills(r.Context(), r.URL.Query().Get("workspaceId"))
	writeResult(w, items, err)
}

func (s *Server) handleListChats(w http.ResponseWriter, r *http.Request) {
	workspaceID, allowed := effectiveWorkspace(actorFromContext(r.Context()), r.URL.Query().Get("workspaceId"))
	if !allowed {
		writeForbidden(w, "workspace is outside the token's scope")
		return
	}
	items, err := s.store.ListChats(r.Context(), workspaceID)
	writeResult(w, items, err)
}

func (s *Server) handleGetChat(w http.ResponseWriter, r *http.Request) {
	item, err := s.store.GetChat(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, item, err)
		return
	}
	actor := actorFromContext(r.Context())
	if !s.canReadNativeChat(r.Context(), actor, item.WorkspaceID, item.ID) {
		writeForbidden(w, "session token cannot read this chat")
		return
	}
	writeResult(w, item, nil)
}

func (s *Server) handleListIssues(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListIssues(r.Context(), r.URL.Query().Get("workspaceId"))
	writeResult(w, items, err)
}

func (s *Server) handleGetIssue(w http.ResponseWriter, r *http.Request) {
	item, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	writeResult(w, item, err)
}

func (s *Server) handleCreateIssue(w http.ResponseWriter, r *http.Request) {
	var input store.CreateIssueInput
	if !decodeEvidenceRequest(w, r, "", &input) {
		return
	}
	if err := input.ValidateRuntimeOptions(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	st, ok := s.evidenceStore(w)
	if !ok {
		return
	}
	actor := actorFromContext(r.Context())
	if workspaceID, allowed := effectiveWorkspace(actor, input.WorkspaceID); !allowed {
		writeForbidden(w, "workspace is outside the token's scope")
		return
	} else {
		input.WorkspaceID = workspaceID
	}
	if !s.requireWorkspace(w, r, strings.TrimSpace(input.WorkspaceID), store.WorkspaceRoleMember) {
		return
	}
	input.CreatedByUserID = actor.AccountID()
	item, err := st.CreateIssueIdempotent(r.Context(), input, r.Header.Get("Idempotency-Key"))
	if err != nil {
		writeEvidenceMutation(w, nil, err)
		return
	}
	writeResultWithStatus(w, http.StatusCreated, item, err)
}

func (s *Server) handleAcceptIssue(w http.ResponseWriter, r *http.Request) {
	// The legacy environment-revision endpoint must never become a fallback
	// for the structured review gate.
	s.handleEvidenceAccept(w, r)
}

func (s *Server) handleRequestChanges(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Message       string `json:"message"`
		ExpectedRunID string `json:"expectedRunId"`
	}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, "Invalid feedback", http.StatusBadRequest)
			return
		}
	}
	issue, err := s.store.GetIssue(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, issue, err)
		return
	}
	unlock := s.lockIssueMutation(issue.ID)
	defer unlock()
	issue, err = s.store.GetIssue(r.Context(), issue.ID)
	if err != nil {
		writeResult(w, issue, err)
		return
	}
	if issue.Status == "in_progress" || issue.Status == "accepted" || issue.Status == "abandoned" {
		http.Error(w, "Issue cannot be retried in its current state", http.StatusConflict)
		return
	}
	if issue.Run != nil && issue.Run.EnvironmentID != "" {
		workspace, lookupErr := s.store.GetWorkspace(r.Context(), issue.WorkspaceID)
		if lookupErr == nil {
			lookupErr = s.hub.checkIssueRetry(r.Context(), workspace, issue)
		}
		if lookupErr != nil {
			http.Error(w, lookupErr.Error(), http.StatusConflict)
			return
		}
	}
	item, err := s.store.RequestIssueChanges(r.Context(), r.PathValue("id"), input.Message, input.ExpectedRunID)
	if err == nil {
		go s.hub.DispatchReady()
	}
	writeResult(w, item, err)
}

func (s *Server) handleListRuns(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListRuns(r.Context(), r.URL.Query().Get("workspaceId"))
	writeResult(w, items, err)
}

func (s *Server) handleListRunEvents(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListRunEvents(r.Context(), r.URL.Query().Get("workspaceId"))
	writeResult(w, items, err)
}

func (s *Server) handleListAgentSessions(w http.ResponseWriter, r *http.Request) {
	workspaceID, allowed := effectiveWorkspace(actorFromContext(r.Context()), r.URL.Query().Get("workspaceId"))
	if !allowed {
		writeForbidden(w, "workspace is outside the token's scope")
		return
	}
	items, err := s.store.ListAgentSessionSummaries(r.Context(), workspaceID)
	if err == nil {
		items = summarizeAgentSessionsForList(s.reconcileAgentSessions(r.Context(), items))
	}
	writeResult(w, items, err)
}

func summarizeAgentSessionsForList(sessions []store.AgentSession) []store.AgentSession {
	for index := range sessions {
		sessions[index] = summarizeAgentSessionForList(sessions[index])
	}
	return sessions
}

func summarizeAgentSessionForList(session store.AgentSession) store.AgentSession {
	session.ImportedContext = ""
	session.ProfileTransitionNote = ""
	session.Response = ""
	session.Error = ""
	session.Events = nil
	return session
}

func (s *Server) handleGetAgentSession(w http.ResponseWriter, r *http.Request) {
	// Authorize against the side-effect-free summary first; only a permitted
	// caller may then trigger stale-session reconciliation.
	anchor, err := s.store.GetAgentSessionSummary(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, anchor, err)
		return
	}
	actor := actorFromContext(r.Context())
	if !s.canReadSession(r.Context(), actor, anchor) {
		writeForbidden(w, "session token cannot read this session")
		return
	}
	item, err := s.store.GetAgentSession(r.Context(), anchor.ID)
	if err != nil {
		writeResult(w, item, err)
		return
	}
	item, _, err = s.reconcileAgentSession(r.Context(), item)
	writeResult(w, item, err)
}

func (s *Server) handleGetAgentSessionThread(w http.ResponseWriter, r *http.Request) {
	workspaceID, allowed := effectiveWorkspace(actorFromContext(r.Context()), r.URL.Query().Get("workspaceId"))
	if !allowed {
		writeForbidden(w, "workspace is outside the token's scope")
		return
	}
	items, err := s.store.ListAgentSessionThread(
		r.Context(),
		workspaceID,
		r.PathValue("id"),
	)
	if err != nil {
		writeResult(w, items, err)
		return
	}
	actor := actorFromContext(r.Context())
	if actor.Agent() {
		anchor, anchorErr := s.store.GetAgentSessionSummary(r.Context(), r.PathValue("id"))
		if anchorErr != nil || !s.canReadSession(r.Context(), actor, anchor) {
			writeForbidden(w, "session token cannot read this thread")
			return
		}
	}
	items = s.reconcileAgentSessions(r.Context(), items)
	writeResult(w, items, nil)
}

func (s *Server) handleGetAgentSubagentTranscript(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSpace(r.PathValue("id"))
	taskID := strings.TrimSpace(r.PathValue("taskId"))
	if sessionID == "" || taskID == "" {
		writeError(w, http.StatusBadRequest, "session id and task id are required")
		return
	}
	session, err := s.store.GetAgentSessionSummary(r.Context(), sessionID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if !s.canReadSession(r.Context(), actorFromContext(r.Context()), session) {
		writeForbidden(w, "session token cannot read this session's subagents")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	transcript, err := s.hub.ReadAgentSubagentTranscript(ctx, session, taskID)
	writeResult(w, transcript, err)
}

func (s *Server) handleListAgentSubagents(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSpace(r.PathValue("id"))
	if sessionID == "" {
		writeError(w, http.StatusBadRequest, "session id is required")
		return
	}
	session, err := s.store.GetAgentSessionSummary(r.Context(), sessionID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if !s.canReadSession(r.Context(), actorFromContext(r.Context()), session) {
		writeForbidden(w, "session token cannot read this session's subagents")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	subagents, err := s.hub.ListAgentSubagents(ctx, session)
	writeResult(w, subagents, err)
}

// applySessionFork resolves forkSessionId: the forked session's native
// transcript, provider and profile are inherited, but the new session starts a
// fresh Foundry thread. Forking needs ordinary read visibility into the source.
func (s *Server) applySessionFork(r *http.Request, input *store.CreateAgentSessionInput, actor Actor) (int, error) {
	target, err := s.store.GetAgentSessionSummary(r.Context(), strings.TrimSpace(input.ForkSessionID))
	if err != nil {
		return http.StatusNotFound, fmt.Errorf("fork source session not found")
	}
	if !s.canReadSession(r.Context(), actor, target) {
		return http.StatusForbidden, fmt.Errorf("session token cannot fork this session")
	}
	if strings.TrimSpace(target.NativeSessionID) == "" {
		return http.StatusConflict, fmt.Errorf("source session has no resumable native transcript")
	}
	input.ForkSessionID = ""
	input.NativeSessionID = target.NativeSessionID
	input.ThreadID = ""
	input.Provider = target.Provider
	input.AgentID = target.AgentID
	if input.ProfileID == "" {
		input.ProfileID = target.ProfileID
	}
	if input.WorkspaceID == "" {
		input.WorkspaceID = target.WorkspaceID
	}
	return 0, nil
}

func (s *Server) handleCreateAgentSession(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	var input store.CreateAgentSessionInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	// Agents inherit their parent session's creator in the store.
	input.CreatedByUserID = actor.AccountID()
	if actor.Agent() {
		// A session-scoped token always creates within its own workspace, on
		// its own device, and the new session's lineage parent is the caller.
		input.WorkspaceID = actor.Identity.WorkspaceID
		input.ParentSessionID = actor.Identity.SessionID
		input.Source = "agent"
	}
	if !s.requireWorkspace(w, r, strings.TrimSpace(input.WorkspaceID), store.WorkspaceRoleMember) {
		return
	}
	if input.Verification {
		input.Source = "verification"
	}
	if strings.TrimSpace(input.ForkSessionID) != "" {
		if status, forkErr := s.applySessionFork(r, &input, actor); forkErr != nil {
			writeError(w, status, forkErr.Error())
			return
		}
	}
	agents, err := s.store.ListAgents(r.Context(), input.WorkspaceID, "")
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	deviceID := ""
	for _, agent := range agents {
		if input.AgentID != "" && agent.ID == input.AgentID {
			deviceID = agent.DeviceID
			break
		}
		if input.AgentID == "" && input.Provider != "" && agent.Provider == input.Provider {
			deviceID = agent.DeviceID
			break
		}
	}
	// A session token must not be able to pin an arbitrary agentId. If it did
	// not resolve on the actor's device, drop it and resolve by provider/profile
	// through the trusted chain like the stdio client does.
	if actor.Agent() && deviceID != actor.Identity.DeviceID {
		input.AgentID = ""
		deviceID = ""
		for _, agent := range agents {
			if input.ProfileID != "" && agent.ProfileID == input.ProfileID {
				deviceID, input.AgentID = agent.DeviceID, agent.ID
				break
			}
			if input.Provider != "" && agent.Provider == input.Provider {
				deviceID, input.AgentID = agent.DeviceID, agent.ID
				break
			}
		}
	}
	// Server-owned profile agents are projected per snapshot, never persisted
	// as agents rows (see serverProfileProjections). Resolve that id from the
	// trusted workspace -> device -> enabled binding -> profile chain so a
	// picker selection can start a session; client fields never authorise it.
	if deviceID == "" && (input.AgentID != "" || input.ProfileID != "") {
		resolved, resolveErr := s.store.ResolveSessionAgent(r.Context(), input)
		if resolveErr == nil {
			deviceID = resolved.DeviceID
		} else if !errors.Is(resolveErr, store.ErrNotFound) &&
			!errors.Is(resolveErr, store.ErrProfileNotFound) &&
			!errors.Is(resolveErr, store.ErrDeviceRemoved) {
			writeResult(w, nil, resolveErr)
			return
		}
	}
	if actor.Agent() && deviceID != actor.Identity.DeviceID {
		writeForbidden(w, "session token can only start sessions on its own device")
		return
	}
	if deviceID == "" {
		writeError(w, http.StatusBadRequest, "no agent is available for the selected runtime and profile")
		return
	}
	if deviceID != "" && !s.hub.HasConnection(deviceID) {
		writeError(w, http.StatusConflict, "local daemon is not connected")
		return
	}
	if input.WorkspaceID != "" {
		if sessions, err := s.store.ListAgentSessionSummaries(r.Context(), input.WorkspaceID); err == nil {
			s.reconcileAgentSessions(r.Context(), sessions)
		}
	}
	session, err := s.store.CreateAgentSession(r.Context(), input)
	if err != nil {
		if errors.Is(err, store.ErrDeviceRemoved) {
			writeError(w, http.StatusGone, "device_removed")
			return
		}
		writeResult(w, nil, err)
		return
	}
	s.events.Publish("agent_session_created", session)
	if groupID := strings.TrimSpace(session.CreatedGroupID); groupID != "" {
		// Best-effort asynchronous AI naming; failures keep the deterministic
		// placeholder name and never block session dispatch.
		go s.titles.StartGroupName(context.Background(), session.WorkspaceID, groupID, session.ParentSessionID)
	}
	if err := s.hub.DispatchAgentSession(session); err != nil {
		session, _ = s.store.FailAgentSession(r.Context(), session.ID, "local daemon is not connected")
		s.events.Publish("agent_session_completed", session)
		writeJSON(w, http.StatusConflict, session)
		return
	}
	writeJSON(w, http.StatusCreated, session)
}

var ErrLocalDaemonNotConnected = errors.New("local daemon is not connected")

func (s *Server) CreateSessionAndDispatch(ctx context.Context, input store.CreateAgentSessionInput) (store.AgentSession, error) {
	agents, err := s.store.ListAgents(ctx, input.WorkspaceID, "")
	if err != nil {
		return store.AgentSession{}, err
	}
	deviceID := ""
	for _, agent := range agents {
		if input.AgentID != "" && agent.ID == input.AgentID {
			deviceID = agent.DeviceID
			break
		}
		if input.AgentID == "" && input.Provider != "" && agent.Provider == input.Provider {
			deviceID = agent.DeviceID
			break
		}
	}
	if deviceID == "" && (input.AgentID != "" || input.ProfileID != "") {
		resolved, resolveErr := s.store.ResolveSessionAgent(ctx, input)
		if resolveErr == nil {
			deviceID = resolved.DeviceID
		} else if !errors.Is(resolveErr, store.ErrNotFound) &&
			!errors.Is(resolveErr, store.ErrProfileNotFound) &&
			!errors.Is(resolveErr, store.ErrDeviceRemoved) {
			return store.AgentSession{}, resolveErr
		}
	}
	if deviceID == "" && len(agents) > 0 {
		for _, a := range agents {
			if s.hub.HasConnection(a.DeviceID) {
				deviceID = a.DeviceID
				input.AgentID = a.ID
				input.Provider = a.Provider
				break
			}
		}
		if deviceID == "" {
			deviceID = agents[0].DeviceID
			input.AgentID = agents[0].ID
			input.Provider = agents[0].Provider
		}
	}
	if deviceID != "" && !s.hub.HasConnection(deviceID) {
		return store.AgentSession{}, ErrLocalDaemonNotConnected
	}
	if input.WorkspaceID != "" {
		if sessions, err := s.store.ListAgentSessionSummaries(ctx, input.WorkspaceID); err == nil {
			s.reconcileAgentSessions(ctx, sessions)
		}
	}
	session, err := s.store.CreateAgentSession(ctx, input)
	if err != nil {
		return store.AgentSession{}, err
	}
	s.events.Publish("agent_session_created", session)
	if groupID := strings.TrimSpace(session.CreatedGroupID); groupID != "" {
		go s.titles.StartGroupName(context.Background(), session.WorkspaceID, groupID, session.ParentSessionID)
	}
	if err := s.hub.DispatchAgentSession(session); err != nil {
		session, _ = s.store.FailAgentSession(ctx, session.ID, "local daemon is not connected")
		s.events.Publish("agent_session_completed", session)
		return session, ErrLocalDaemonNotConnected
	}
	return session, nil
}

func (s *Server) SteerSessionAndDispatch(ctx context.Context, sessionID, message string) error {
	session, err := s.store.GetAgentSession(ctx, sessionID)
	if err != nil {
		return err
	}
	session, _, err = s.reconcileAgentSession(ctx, session)
	if err != nil {
		return err
	}
	if !isRecoverableAgentSessionStatus(session.Status) {
		return fmt.Errorf("session %s is already %s", session.ID, session.Status)
	}
	return s.hub.SteerAgentSession(ctx, session, message)
}

func (s *Server) handleSteerAgentSession(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	anchor, err := s.store.GetAgentSessionSummary(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if !s.canControlSession(r.Context(), actor, anchor) {
		writeForbidden(w, "session token can only steer sessions it created")
		return
	}
	session, err := s.store.GetAgentSession(r.Context(), anchor.ID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	var recovered bool
	session, recovered, err = s.reconcileAgentSession(r.Context(), session)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if recovered {
		writeError(w, http.StatusConflict, "agent session is not active")
		return
	}
	if !activeOrBlocked(session.Status) {
		writeError(w, http.StatusConflict, "agent session is not active")
		return
	}
	if !s.hub.HasConnection(session.DeviceID) {
		writeError(w, http.StatusConflict, "local daemon is not connected")
		return
	}
	var input struct {
		Message string `json:"message"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	message := strings.TrimSpace(input.Message)
	if message == "" {
		writeError(w, http.StatusBadRequest, "steer message is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.hub.SteerAgentSession(ctx, session, message); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	s.appendSessionControlAudit(r.Context(), session.ID, "Steered by orchestrator", actor)
	session, err = s.store.GetAgentSession(r.Context(), session.ID)
	writeResult(w, session, err)
}

func (s *Server) handleCancelAgentSession(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	anchor, err := s.store.GetAgentSessionSummary(r.Context(), r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if !s.canControlSession(r.Context(), actor, anchor) {
		writeForbidden(w, "session token can only cancel sessions it created")
		return
	}
	session, err := s.store.GetAgentSession(r.Context(), anchor.ID)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	var recovered bool
	session, recovered, err = s.reconcileAgentSession(r.Context(), session)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	if recovered {
		writeError(w, http.StatusConflict, "agent session is not active")
		return
	}
	if !activeOrBlocked(session.Status) {
		writeError(w, http.StatusConflict, "agent session is not active")
		return
	}
	if !s.hub.HasConnection(session.DeviceID) {
		writeError(w, http.StatusConflict, "local daemon is not connected")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.hub.CancelAgentSession(ctx, session); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	// Cancellation is never cascaded: sessions are first-class, child
	// sessions keep running after their parent stops (CHAT-01).
	cancelMessage := "Canceled by user"
	if actor.Agent() {
		cancelMessage = "Canceled by orchestrator session"
	}
	session, err = s.store.CancelAgentSession(r.Context(), session.ID, cancelMessage)
	if err == nil {
		s.appendSessionControlAudit(r.Context(), session.ID, "Canceled by orchestrator", actor)
		s.events.Publish("agent_session_completed", session)
	}
	writeResult(w, session, err)
}

func (s *Server) appendSessionControlAudit(ctx context.Context, sessionID string, label string, actor Actor) {
	if !actor.Agent() {
		return
	}
	event := store.AgentSessionEvent{
		ID:        fmt.Sprintf("audit_%d", time.Now().UnixNano()),
		SessionID: sessionID,
		Label:     label,
		Detail:    actor.Identity.SessionID,
		Level:     "info",
		Metadata: &store.AgentSessionEventMetadata{
			TaskID: actor.Identity.SessionID,
		},
	}
	_ = s.store.AppendAgentSessionEvent(ctx, event)
}

// handleAdoptAgentSession assigns (or clears, with an empty supervisorId) a
// human-confirmed supervisor. Session tokens cannot adopt: a takeover is a
// human decision in the Web, never an agent self-promotion.
func (s *Server) handleAdoptAgentSession(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	if !actor.FullAccess() {
		writeForbidden(w, "session supervision can only be assigned by a human")
		return
	}
	var input struct {
		SupervisorSessionID string `json:"supervisorSessionId"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	targetID := r.PathValue("id")
	var (
		session store.AgentSession
		err     error
	)
	if strings.TrimSpace(input.SupervisorSessionID) == "" {
		session, err = s.store.ClearSupervisor(r.Context(), targetID)
	} else {
		session, err = s.store.AdoptSupervisor(r.Context(), targetID, input.SupervisorSessionID)
	}
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	s.events.Publish("agent_session_supervisor_changed", session)
	writeResult(w, session, err)
}

func (s *Server) handleDaemonRegister(w http.ResponseWriter, r *http.Request) {
	var input store.DaemonRegistration
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !actorFromContext(r.Context()).ActsAsDevice(input.Device.ID) {
		writeError(w, http.StatusForbidden, "registration device does not match its credential")
		return
	}
	if err := s.store.RegisterDaemon(r.Context(), input); err != nil {
		if errors.Is(err, store.ErrDeviceRemoved) {
			writeError(w, http.StatusGone, "device_removed")
			return
		}
		if errors.Is(err, store.ErrWorkspaceOwnedByAnotherDevice) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "registered"})
}

func (s *Server) handleDaemonSyncChats(w http.ResponseWriter, r *http.Request) {
	var input store.SyncChatsInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceWorkspace(w, r, input.WorkspaceID) {
		return
	}
	if err := s.store.SyncChats(r.Context(), input); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "synced", "count": len(input.Chats)})
}

func (s *Server) handleDaemonWebSocket(w http.ResponseWriter, r *http.Request) {
	s.hub.ServeHTTP(w, r)
}

func (s *Server) handleDaemonClaimIssue(w http.ResponseWriter, r *http.Request) {
	var input struct {
		DeviceID    string `json:"deviceId"`
		WorkspaceID string `json:"workspaceId"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !actorFromContext(r.Context()).ActsAsDevice(input.DeviceID) {
		writeError(w, http.StatusForbidden, "claim device does not match its credential")
		return
	}
	if input.WorkspaceID != "" && !s.requireDeviceWorkspace(w, r, input.WorkspaceID) {
		return
	}
	issue, err := s.store.ClaimNextIssue(r.Context(), input.DeviceID, input.WorkspaceID)
	if errors.Is(err, store.ErrDeviceRemoved) {
		writeError(w, http.StatusGone, "device_removed")
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeResult(w, issue, err)
}

func (s *Server) handleDaemonStartRun(w http.ResponseWriter, r *http.Request) {
	var input store.StartRunInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceIssue(w, r, r.PathValue("id")) {
		return
	}
	issue, err := s.store.StartIssueRun(r.Context(), r.PathValue("id"), input.Run)
	if errors.Is(err, store.ErrDeviceRemoved) {
		writeError(w, http.StatusGone, "device_removed")
		return
	}
	if err == nil {
		s.events.Publish("issue_updated", issue)
	}
	writeResult(w, issue, err)
}

func (s *Server) handleDaemonAppendRunEvent(w http.ResponseWriter, r *http.Request) {
	var input store.AppendRunEventInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if input.Event.RunID == "" {
		input.Event.RunID = r.PathValue("id")
	}
	if !s.requireDeviceWorkspace(w, r, s.hub.runWorkspace(r.Context(), input.Event.RunID)) {
		return
	}
	if err := s.store.AppendRunEvent(r.Context(), input.Event); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.events.PublishIn(s.hub.runWorkspace(r.Context(), input.Event.RunID), "issue_run_event", input.Event)
	writeJSON(w, http.StatusOK, map[string]string{"status": "recorded"})
}

func (s *Server) handleDaemonCompleteIssue(w http.ResponseWriter, r *http.Request) {
	var input store.CompleteIssueInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	if !s.requireDeviceIssue(w, r, r.PathValue("id")) {
		return
	}
	issue, err := s.store.CompleteIssue(r.Context(), r.PathValue("id"), input)
	if err == nil {
		s.events.Publish("issue_updated", issue)
	}
	writeResult(w, issue, err)
}

func (s *Server) handleDevResetDemo(w http.ResponseWriter, r *http.Request) {
	resetter, ok := s.store.(DemoResetter)
	if !ok {
		writeError(w, http.StatusNotImplemented, "demo reset is not supported by this store")
		return
	}
	if err := resetter.ResetDemo(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "reset"})
}

func writeResult(w http.ResponseWriter, payload any, err error) {
	writeResultWithStatus(w, http.StatusOK, payload, err)
}

func writeResultWithStatus(w http.ResponseWriter, status int, payload any, err error) {
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		if errors.Is(err, store.ErrSessionParentNotFound) {
			writeError(w, http.StatusBadRequest, store.ErrSessionParentNotFound.Error())
			return
		}
		if errors.Is(err, store.ErrSessionParentMismatch) {
			writeForbidden(w, store.ErrSessionParentMismatch.Error())
			return
		}
		if errors.Is(err, store.ErrAgentLineageTooDeep) ||
			errors.Is(err, store.ErrAgentFanOutLimit) ||
			errors.Is(err, store.ErrIssueEnvironmentUnavailable) {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		if errors.Is(err, store.ErrAgentAdoptInvalid) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, status, payload)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		return
	}
}

func writeCacheableJSON(w http.ResponseWriter, r *http.Request, encoded []byte) {
	digest := sha256.Sum256(encoded)
	etag := `"` + fmt.Sprintf("%x", digest) + `"`
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", etag)
	if strings.TrimSpace(r.Header.Get("If-None-Match")) == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(encoded)
	_, _ = w.Write([]byte("\n"))
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
