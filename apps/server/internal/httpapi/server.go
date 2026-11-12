package httpapi

import (
	"context"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/eventstream"
	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents"
	"github.com/foundry-dev/foundry/apps/server/internal/feishugateway"
	"github.com/foundry-dev/foundry/apps/server/internal/issues"
	"github.com/foundry-dev/foundry/apps/server/internal/keylock"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/knowledge"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/run"
	"github.com/foundry-dev/foundry/apps/server/internal/resources"
	"github.com/foundry-dev/foundry/apps/server/internal/sessionalerts"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/skillrepo"
	"github.com/foundry-dev/foundry/apps/server/internal/skilltools"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/usagestats"
	"github.com/foundry-dev/foundry/apps/server/internal/wirerecord"
)

// Backend is everything the server keeps in its database: store.Store and
// the module interfaces its features use. The SQLite store implements it;
// composing it here keeps store.Store itself from growing.
type Backend interface {
	store.Store
	store.AccountStore
	store.OwnershipStore
	store.DeviceCredentialStore
	store.DeviceRemovalStore
	store.DeviceSharingStore
	store.RequestLedger
	store.DaemonChangeStore
	store.WorkspaceDeletionStore
	store.WorkspaceAvailabilityStore
	store.WorkspaceLifecycleStore
	store.WorkspaceMigrationStore
	store.DeviceSessionStore
	store.ActiveAgentSessionStore
	store.QueuedAgentSessionStore
	store.SessionEventRecorder
	store.SessionInputSenderStore
	store.SessionInputCompletionStore
	store.SessionEventWindowStore
	store.SessionEventCatchUpStore
	store.NativeHistoryStore
	store.SessionStateStore
	store.SessionEventCompactionStore
	store.SessionInspectionStore
	store.SessionTimerStore
	store.ChatQueueStore
	store.ChatDigestStore
	store.ProfilePromotionStore
	store.CodexTransportStore
	store.ProfileCheckStore
	store.IssueExecutionStore
	store.EvidenceStore
	store.ResourceStore
	store.ResourceLeaseStore
	store.LeaseCommandTokenStore
	store.AppStoreConnectStore
	store.ExtensionServerHeldStore
	store.FeishuGatewayStore
	store.DeviceConnectorStore
	store.ConnectorPackageStore
	store.PersonalAgentStore
	store.PermissionPackageStore
	store.PersonalAgentListStore
	store.WorkspaceDigestStore
	store.DevicePlacementStore
	store.DeviceFileStore
	store.ChildReportStore
	store.WorkStore
	store.WorkChangeStore
	store.SessionInboxStore
	store.SessionAlertStore
	store.PendingItemStore
	store.AgentDefaultStore
	store.ChatArchiveStore
	store.NativeAccountHoldStore
	store.ServiceTunnelStore
	store.WorkspaceDraftStore
	store.PersonalAgentInboxStore
	store.PersonalAgentRuntimeStore
	store.PersonalAgentRunControlStore
	store.PersonalAgentOperationStore
	store.PersonalAgentMaintenanceStore
	store.PersonalAgentContextPatchStore
	store.KnowledgeVaultStore
	store.KnowledgeEntryStore
	store.KnowledgeMigrationStore
	store.KnowledgeLegacyTransferStore
	store.KnowledgeReplicaCleanupStore
	store.KnowledgePublicationStore
	store.FeishuIssueThreads
	store.SessionRecordStore
	store.SessionAdoptionStore
	store.SessionDelegationStore
	feishuAppStore
	secretKeeper
	deviceNamer
	chatsByIDStore
	sessionConversationStore
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
	attachmentImages attachmentImageCache
	nativeSignIns    nativeSignInRequests
	tunnels          serviceTunnelRuntime
	previewProbe     previewRoute
	projections      projectionCache
	idempotencyLocks keylock.Locks
	titles           *chatTitleService
	hub              *DaemonHub
	// deviceRemovals wakes the purge of removed devices (device_removal.go).
	deviceRemovals deviceRemovals
	// externalSetups: the last setup state devices answered (external_connection_setup.go).
	externalSetups externalSetupMemo
	feishu         *feishu.WSManager
	feishuEvents   *feishuevents.Hub
	options        ServerOptions
	// usagePriceSource is LiteLLM's raw catalog URL; tests point it at a trap.
	usagePriceSource string
	startedAt        time.Time
	store            Backend
	// modelCatalogs keeps the catalogs devices answered (agent_model_catalog.go).
	modelCatalogs modelCatalogCache
	// connectors is the Connectors module: people's third-party logins
	// held here, device-held connectors' metadata, the catalog
	// (connectors.go, external_accounts.go).
	connectors *connectors.Module
	// connectorRefreshes are the Connectors page's background reads.
	connectorRefreshes connectorReads
	// connectorVisibility refreshes gated connector checks without blocking
	// the page on a slow network or provider.
	connectorVisibility connectorReads
	// drain is whether the server is shutting down and which requests are
	// open (drain.go).
	drain drainState
	// resources is the inventory devices report (resources.go).
	resources *resources.Service
	// leases decide who holds which instance (resource_leases.go).
	leases *resources.Leases
	// feishuGateway is how sessions reach Feishu with those logins
	// (external_accounts_gateway.go).
	feishuGateway *feishugateway.Gateway
	loginLimiter  *loginLimiter
	setupMu       sync.Mutex
	// Work dispatch and control serialize so a completed stop cannot race a new fire.
	workMu        sync.Mutex
	workerUpdates workerUpdates
	deviceRunners deviceRunners
	setupCode     string
	// stream is GET /api/events; the notifiers tell browsers on it, by
	// domain, what the server's handlers change.
	stream      *eventstream.Hub
	sessions    sessions.Notifier
	issues      *issues.Events
	chats       chatListNotifier
	devices     deviceNotifier
	dataChanges dataChangeNotifier
	// sessionService is the session lifecycle: start, dispatch, messages,
	// stop and inboxes, over the ports in session_ports.go.
	sessionService *sessions.Service
	// sessionAlerts reports system incidents of turns another session
	// started, separately from their result reports.
	sessionAlerts *sessionalerts.Service
	// sessionRetries keeps model rate-limit retries durable across restarts.
	sessionRetries *sessionRetryService
	// issueService is an Issue's lifecycle, whichever entry asks, over the
	// port in issue_ports.go.
	issueService *issues.Service
	// runs resolves and pins how the person's assistant runs
	// (personalagent/run), over the ports in personal_agent_ports.go.
	runs *run.Resolver
	// knowledge is the person's knowledge sources (personalagent/knowledge).
	knowledge *knowledge.Service
	// wire samples device traffic when the options name a directory
	// (wire_record.go); nil records nothing.
	wire *wirerecord.Recorder
	// assistant is the person's assistant at work
	// (personalagent/assistant), over the ports in personal_agent_ports.go.
	assistant *assistant.Service
	// skillRepos reads git repositories for the skill library; repoMu runs
	// one repository operation at a time.
	skillRepos skillrepo.Source
	repoMu     sync.Mutex
	// rollouts serializes each bundle rollout (skill_rollouts.go).
	rollouts rollouts
	// packageApplies serializes the background apply of each connector
	// package; packageRecordMu guards the read-modify-write of their records
	// (connector_package_apply.go).
	packageApplies  rollouts
	packageRecordMu sync.Mutex
	// skillRepositoryFirstCheck is how long after start the followed
	// repositories are first checked; tests shorten it.
	skillRepositoryFirstCheck time.Duration
	// toolArchives holds repository tool folders read for other devices.
	toolArchives toolArchives
	// repoUploads holds the files devices upload for repositories they read.
	repoUploads deviceUploads
	// toolResolver finds the tools bundles need; tests point its GitHub and
	// PyPI bases at local servers.
	toolResolver skilltools.Resolver
	// chatQueueLocks runs one chat queue dispatch per workspace at a time;
	// chatQueueKicks runs the dispatches, as part of the hub's work.
	chatQueueLocks keylock.Locks
	chatQueueKicks *workGroup
	// chatSteers follows the tools sessions run, for chat messages that
	// enter a running turn at its next step (DEV-082).
	chatSteers chatSteerWatch
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
	chatListNotifier interface {
		sessionCreated(session store.AgentSession, adoptedChatID string)
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
	sessionEvents := sessions.NewEvents(stream)
	issueEvents := issues.NewEvents(stream)
	chats := newChatListEvents(stream, store, data)
	server := &Server{
		stream:                    stream,
		sessions:                  sessionEvents,
		issues:                    issueEvents,
		chats:                     chats,
		dataChanges:               data,
		options:                   options,
		usagePriceSource:          usagestats.DefaultPriceSourceURL,
		startedAt:                 time.Now().UTC(),
		store:                     store,
		loginLimiter:              newLoginLimiter(),
		skillRepos:                skillrepo.DefaultSources(),
		skillRepositoryFirstCheck: time.Minute,
		toolResolver:              skilltools.Resolver{ReleaseAPI: "https://api.github.com", PyPIAPI: "https://pypi.org"},
	}
	server.sessionService = newSessionService(server, sessionEvents)
	server.sessionRetries = newSessionRetryService(server)
	server.sessionAlerts = newSessionAlerts(server)
	server.issueService = newIssueService(server, issueEvents)
	server.runs = run.New(store, runAccounts{server})
	server.knowledge = knowledge.New(store, knowledgeDevices{server}, paWorkspaces{server}, server.runs, runAccounts{server})
	server.assistant = newAssistant(server, sessionEvents)
	devices := newDeviceEvents(stream, store, data, server)
	devices.workspaceContentChanged = server.refreshWorkspaceDigests
	devices.reauthorizeOwner = server.reauthorizeDeviceOwner
	server.devices = devices
	server.hub = NewDaemonHub(store, daemonNotifiers{sessions: sessionEvents, issues: issueEvents, devices: devices, chats: chats, dataChanges: data}, options.AllowedOrigin)
	server.hub.usageStats = newUsageRecorder(store, server.assistant.SessionRole)
	server.wire = openWireRecording(options.WireRecordDir)
	server.hub.wire = server.wire
	server.chatQueueKicks = newWorkGroup(server.hub.work)
	server.initAccounts()
	server.connectors = connectors.New(store, store, options.Integrations, personalagent.ProposalTTL)
	server.connectors.ServerHeld.ExtensionDeviceRequest = server.extensionDeviceRequest
	server.connectors.ServerHeld.ExtensionDevices = server.extensionDevices
	if server.connectors.Confirmations != nil {
		server.connectors.Confirmations.OnCreated = server.assistant.ProposalCreated
		server.connectors.Confirmations.OnChanged = server.assistant.ProposalChanged
	}
	server.hub.connectors = server.connectors
	server.resources = newResourceService(store, server.hub, stream)
	server.hub.resources = server.resources
	server.leases = newResourceLeases(store, server.resources, server.hub)
	server.hub.leases = server.leases
	server.feishuGateway = newFeishuGateway(store, server.connectors.ServerHeld, options.Integrations, server.hub)
	server.feishuGateway.UsePermission(store, server.connectors.Confirmations)
	server.feishuGateway.UseChecks(server.connectors.ToolChecks)
	server.connectors.Cloudflare.UseNativeWork(server.hub)
	server.connectors.AppStoreConnect.UseNativeWork(server.hub)
	server.connectors.Extensions.UseNativeWork(server.hub)
	server.syncConnectorToolVersions(context.Background())
	server.connectors.SetGatewayIssuer(server.feishuGateway)
	server.titles = &chatTitleService{store: store, dispatch: server.dispatchNamingJob, connected: server.hub.HasConnection, sessions: sessionEvents, chats: chats, work: server.hub.work}
	server.hub.onEvidenceConnected = server.recoverEvidenceVerifications
	server.hub.assistantRun = server.assistant.RunFor
	server.hub.settleIssueSession = server.issueService.Settle
	server.hub.awaitSessionStart = server.sessionService.AwaitStart
	server.hub.inboxConsumed = server.sessionService.ObserveInboxConsumed
	server.hub.questionSettled = server.observeQuestionSettled
	server.hub.retrySessionFailure = server.sessionRetries.Failed
	server.hub.sessionRetryStarted = server.sessionRetries.Started
	server.hub.sessionRetryDone = server.sessionRetries.Completed
	sessionEvents.Presented = server.presentSession
	sessionEvents.Panel = server.sessionPanelOf
	server.hub.onWorkerUpdateStatus = server.recordWorkerUpdateStatus
	server.hub.onDeviceRunner = server.recordDeviceRunner
	server.hub.onDeviceConnected = func(ctx context.Context, deviceID string) {
		server.hub.work.Go(func() { server.checkWaitingRepositories(ctx, deviceID) })
		// A bundle rollout waiting for this device goes on.
		server.hub.work.Go(func() { server.bundleRolloutsOnConnect(ctx, deviceID) })
		// Device-network connector instances are probed from the new device.
		server.hub.work.Go(func() { server.probeExtensionsOnDevice(ctx, deviceID) })
		// Messages queued while the device was away go out now.
		server.kickPendingChatQueues(ctx)
		// Rescans skills until the device goes; it must not hold up the rest.
		server.hub.work.Go(func() { server.keepDeviceSkillsScanned(ctx, deviceID) })
		server.hub.queueSkillPreparation()
		server.resourceLeasesDeviceConnected(ctx, deviceID)
		// The assistant hears what waited for the computer.
		server.assistant.DeviceBack(ctx, deviceID)
		// A workspace move waiting for this device goes on.
		server.hub.migrations.kick()
	}
	server.feishu = feishu.NewWSManager(store, store, server, stream)
	feishu.SetWebOrigin(options.AllowedOrigin)
	server.feishu.Integrations = options.Integrations
	server.feishu.PersonalAgents = personalAgentDesk{server}
	server.feishu.Issues = issueDesk{server}
	server.wireFeishuEvents(store, options.Integrations)
	// Everything on the server that reacts to sessions, in this order.
	// What a device reports is recorded and its viewers told first; the
	// reactions that must run before the store takes an event or that may
	// fail the device's message stay in daemon_session_inbound.go.
	inbox := server.sessionService.InboxObserver()
	server.sessionService.OnInboxMessageFailed(server.childMessageFailed)
	sessionEvents.Observe(sessions.Observers{
		// A change of a session's state: a scheduled run's outcome, its
		// Feishu card, the chat's queued messages, the chat's title, the
		// resources it leases, the assistant's tasks, inbox results and run
		// controls, its inbox, its report to its parent, pending items,
		// workspace digests, waiting child projections, and last an Issue's
		// run starting.
		Changes: slices.Concat([]sessions.ChangeObserver{
			workRunReactions{server}, feishuReactions{server.feishu}, chatQueueReactions{server}, server.titles,
			resourceLeaseReactions{server},
		}, server.assistant.Observers(), []sessions.ChangeObserver{
			sessionAlertReactions{server}, inbox, childReportReactions{server},
			pendingReactions{server}, workspaceDigestReactions{server}, waitingChildReactions{server}, server.issueService.Observer(),
		}),
		// An event added to its transcript: its Feishu card, the chat's
		// queued messages, its inbox, pending items, a child's question to
		// its parent.
		Events: []sessions.EventObserver{feishuReactions{server.feishu}, chatQueueReactions{server}, sessionAlertReactions{server}, inbox, pendingReactions{server}, childQuestionReactions{server}},
		// A device's report that it ended, once the device was answered:
		// naming what it answered.
		Ends: []sessions.EndObserver{server.titles},
	})
	issueEvents.Observe(feishuReactions{server.feishu}, pendingReactions{server}, workspaceDigestReactions{server})
	server.observeWorkspaceDigests()
	server.trackDevicePresence()
	return server
}

// ResumeDeviceReconnects starts the reconnect grace for devices the previous
// process recorded as connected. The entry point calls it before opening the
// readiness gate.
func (s *Server) ResumeDeviceReconnects(ctx context.Context) {
	s.hub.resumeDeviceReconnects(ctx)
}

// Shutdown terminates the protocol-specific resources that net/http's own
// Shutdown cannot reach: SSE handlers block in their own loop rather than in
// a request the server tracks, and hijacked WebSockets leave http.Server's
// accounting entirely. Call it before or during http.Server.Shutdown. It is
// idempotent and safe to call concurrently.
func (s *Server) Shutdown(ctx context.Context) error {
	// Requests that wait for something else end first (drain.go).
	s.drain.begin()
	s.tunnels.closeAll()
	s.feishu.StopAll()
	s.feishuEvents.Stop()
	s.stream.Shutdown()
	err := s.hub.Shutdown(ctx)
	_ = s.wire.Close()
	return err
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("OPTIONS /", s.handleOptions)
	mux.HandleFunc("GET /healthz", s.handleHealth)
	agentRoutes := map[string]bool{}
	for _, route := range s.routeTable() {
		mux.Handle(route.pattern, s.guard(route.rule, s.recordDeviceREST(route)))
		if route.agent {
			agentRoutes[route.pattern] = true
		}
	}
	if s.options.WebDistDir != "" {
		mux.Handle("GET /{path...}", s.serveWeb(s.options.WebDistDir))
	}
	return s.drain.track(s.withServicePreview(withSlowRequestLog(withCORS(s.options.AllowedOrigin, s.withAuthentication(onlyAgentRoutes(mux, agentRoutes))))))
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
