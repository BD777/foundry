package httpapi

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents"
	"github.com/foundry-dev/foundry/apps/server/internal/feishugateway"
	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/skillrepo"
	"github.com/foundry-dev/foundry/apps/server/internal/skilltools"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Backend is everything the server keeps in its database: store.Store and
// the module interfaces its features use. The SQLite store implements it;
// composing it here keeps store.Store itself from growing.
type Backend interface {
	store.Store
	store.AccountStore
	store.OwnershipStore
	store.DeviceCredentialStore
	store.RequestLedger
	store.DaemonChangeStore
	store.WorkspaceDeletionStore
	store.WorkspaceAvailabilityStore
	store.DeviceSessionStore
	store.ActiveAgentSessionStore
	store.QueuedAgentSessionStore
	store.SessionEventRecorder
	store.SessionEventWindowStore
	store.SessionEventCatchUpStore
	store.SessionStateStore
	store.SessionInspectionStore
	store.SessionTimerStore
	store.ChatQueueStore
	store.ChatDigestStore
	store.ProfilePromotionStore
	store.IssueExecutionStore
	store.EvidenceStore
	store.ResourceStore
	store.ResourceLeaseStore
	store.FeishuGatewayStore
	feishuAppStore
	secretKeeper
	deviceNamer
	chatsByIDStore
	sessionConversationStore
	sessionUsageStore
	workspaceNativeSessionLister
	skillRepositoryStore
	bundleStore
	defaultSkillStore
	skillExclusionStore
	skillPinner
	deviceToolStore
	deviceSkillScanStore
	// ResetDemo backs the dev-only POST /api/dev/reset-demo.
	ResetDemo(ctx context.Context) error
}

type Server struct {
	projections        projectionCache
	issueMutationLocks sync.Map
	idempotencyLocks   sync.Map
	titles             *chatTitleService
	hub                *DaemonHub
	feishu             *feishu.WSManager
	feishuEvents       *feishuevents.Hub
	options            ServerOptions
	startedAt          time.Time
	store              Backend
	// modelCatalogs keeps the catalogs devices answered (agent_model_catalog.go).
	modelCatalogs modelCatalogCache
	// externalAccounts holds people's third-party logins (external_accounts.go).
	externalAccounts *externalaccounts.Service
	// resources is the inventory devices report (resources.go).
	resources *resources.Service
	// leases decide who holds which instance (resource_leases.go).
	leases *resources.Leases
	// feishuGateway is how sessions reach Feishu with those logins
	// (external_accounts_gateway.go).
	feishuGateway *feishugateway.Gateway
	loginLimiter  *loginLimiter
	setupMu       sync.Mutex
	workerUpdates workerUpdates
	setupCode     string
	// stream is GET /api/events; the notifiers tell browsers on it, by
	// domain, what the server's handlers change.
	stream      *eventstream.Hub
	sessions    sessionNotifier
	issues      issueNotifier
	chats       chatListNotifier
	devices     deviceNotifier
	dataChanges dataChangeNotifier
	// skillRepos reads git repositories for the skill library; repoMu runs
	// one repository operation at a time.
	skillRepos skillrepo.Source
	repoMu     sync.Mutex
	// skillRepositoryFirstCheck is how long after start the followed
	// repositories are first checked; tests shorten it.
	skillRepositoryFirstCheck time.Duration
	// repoUploads holds the files devices upload for repositories they read.
	repoUploads deviceUploads
	// toolResolver finds the tools bundles need; tests point its GitHub and
	// PyPI bases at local servers.
	toolResolver skilltools.Resolver
	// chatQueueLocks runs one chat queue dispatch per workspace at a time;
	// chatQueueKicks counts the dispatches in flight.
	chatQueueLocks sync.Map
	chatQueueKicks sync.WaitGroup
	// testActor authenticates every browser request in package tests, and
	// testFullAccess lets it reach every workspace and device so handler
	// tests exercise behaviour, not membership. Authorization tests use real
	// accounts instead.
	testActor      *Actor
	testFullAccess bool
}

// What the server's handlers tell browsers, by domain: each is the part of
// the domain's notifier (events_*.go, data_changes.go) they use.
type (
	sessionChangeNotifier interface {
		changed(ctx context.Context, change sessionChange, session store.AgentSession)
	}
	sessionNotifier interface {
		sessionChangeNotifier
		recorded(ctx context.Context, workspaceID string, event store.AgentSessionEvent)
	}
	issueNotifier interface {
		created(issue store.Issue)
		updated(issue store.Issue)
		evidenceChanged(issue store.Issue, entityID string, version int, status string)
	}
	chatListNotifier interface {
		sessionCreated(session store.AgentSession)
		announceTitles(workspaceID string, chatIDs ...string)
		layoutChanged(workspaceID string, layout store.ChatLayout)
		queueChanged(queue store.ChatQueue)
		announceQueue(ctx context.Context, workspaceID, chatID string)
	}
	deviceNotifier interface {
		changed(ctx context.Context, deviceID string) bool
	}
	dataChangeNotifier interface {
		changed(workspaceID string, resources ...string)
	}
)

type healthResponse struct {
	Status    string `json:"status"`
	StartedAt string `json:"startedAt"`
}

func NewServerWithOptions(store Backend, options ServerOptions) *Server {
	options = normalizeServerOptions(options)
	stream := newBrowserStream()
	data := newDataChanges(stream)
	sessions := newSessionEvents(stream)
	issues := &issueEvents{stream: stream}
	chats := newChatListEvents(stream, store, data)
	server := &Server{
		stream:                    stream,
		sessions:                  sessions,
		issues:                    issues,
		chats:                     chats,
		dataChanges:               data,
		options:                   options,
		startedAt:                 time.Now().UTC(),
		store:                     store,
		loginLimiter:              newLoginLimiter(),
		skillRepos:                skillrepo.DefaultSources(),
		skillRepositoryFirstCheck: time.Minute,
		toolResolver:              skilltools.Resolver{ReleaseAPI: "https://api.github.com", PyPIAPI: "https://pypi.org"},
	}
	devices := newDeviceEvents(stream, store, data, server)
	server.devices = devices
	server.hub = NewDaemonHub(store, daemonNotifiers{sessions: sessions, issues: issues, devices: devices, chats: chats, dataChanges: data}, options.AllowedOrigin)
	server.initAccounts()
	server.externalAccounts = newExternalAccountService(store, options.Integrations)
	server.hub.externalAccounts = server.externalAccounts
	server.resources = newResourceService(store, server.hub, stream)
	server.hub.resources = server.resources
	server.leases = newResourceLeases(store, server.resources, server.hub)
	server.hub.leases = server.leases
	server.feishuGateway = newFeishuGateway(store, server.externalAccounts, options.Integrations)
	server.titles = &chatTitleService{store: store, dispatch: server.dispatchNamingJob, connected: server.hub.HasConnection, sessions: sessions, chats: chats}
	server.hub.onEvidenceConnected = server.recoverEvidenceVerifications
	server.hub.onWorkerUpdateStatus = server.recordWorkerUpdateStatus
	server.hub.onDeviceConnected = func(ctx context.Context, deviceID string, capabilities []string) {
		go server.checkWaitingRepositories(ctx, deviceID, capabilities)
		// Messages queued while the device was away go out now.
		server.kickPendingChatQueues(ctx)
		// Rescans skills until the device goes; it must not hold up the rest.
		go server.keepDeviceSkillsScanned(ctx, deviceID, capabilities)
		server.resourceLeasesDeviceConnected(ctx, deviceID, capabilities)
	}
	server.feishu = feishu.NewWSManager(store, store, server, stream)
	server.feishu.Integrations = options.Integrations
	server.wireFeishuEvents(store, options.Integrations)
	// What follows a session's changes, in this order: its Feishu card, the
	// chat's queued messages, the chat's title, the resources it leases;
	// and, once a device that reported a session ended was answered, naming
	// what it answered.
	sessions.observe(feishuReactions{server.feishu}, chatQueueReactions{server}, server.titles, resourceLeaseReactions{server})
	issues.observe(feishuReactions{server.feishu})
	return server
}

// Shutdown terminates the protocol-specific resources that net/http's own
// Shutdown cannot reach: SSE handlers block in their own loop rather than in
// a request the server tracks, and hijacked WebSockets leave http.Server's
// accounting entirely. Call it before or during http.Server.Shutdown. It is
// idempotent and safe to call concurrently.
func (s *Server) Shutdown(ctx context.Context) error {
	s.feishu.StopAll()
	s.feishuEvents.Stop()
	s.stream.Shutdown()
	return s.hub.Shutdown(ctx)
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
	return withSlowRequestLog(withCORS(s.options.AllowedOrigin, s.withAuthentication(enforceAgentRoute(mux))))
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

func (s *Server) handleDevResetDemo(w http.ResponseWriter, r *http.Request) {
	if err := s.store.ResetDemo(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.projectionsChanged("")
	writeJSON(w, http.StatusOK, map[string]string{"status": "reset"})
}
