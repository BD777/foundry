package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/httpapi"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
)

// dependencies are the seams the entry point resolves at runtime. Tests
// override them to exercise lifecycle behavior without touching real
// environment variables, privileged ports, or on-disk databases.
type dependencies struct {
	getenv    func(key string) string
	listen    func(ctx context.Context, addr string) (net.Listener, error)
	logf      func(format string, args ...any)
	openStore func(cfg config) (serverStore, error)
}

// serverStore is what the server runs on: the API's backend and the
// presence chores done before it serves.
type serverStore interface {
	httpapi.Backend
	MarkAllDevicesOffline(ctx context.Context) error
	PurgeRemovedDevicesState(ctx context.Context) error
	// RunMaintenance is the recurring cleanup that runs beside requests.
	RunMaintenance(ctx context.Context) error
}

// run resolves configuration, opens the store, and serves until ctx is
// cancelled. The store is closed exactly once, on the way out of this call.
//
// The port is bound before the store opens, and requests that arrive
// meanwhile wait at a readiness gate (readyGate) instead of being refused.
// With FOUNDRY_RESTART_HANDOFF=1 this process instead supervises the server
// as a child it can replace without closing the port (handoff.go).
func run(ctx context.Context, deps dependencies) error {
	started := time.Now()
	cfg := loadConfig(deps.getenv)
	if err := validateSettings(cfg); err != nil {
		return err
	}
	handoff, err := inheritedHandoff(deps.getenv)
	if err != nil {
		return err
	}
	if handoff == nil && deps.getenv(handoffEnv) == "1" {
		return supervise(ctx, cfg, deps)
	}

	var listener net.Listener
	if handoff != nil {
		listener = handoff.listener
		ctx = stopWhenOrphaned(ctx)
	} else if listener, err = listenRetrying(ctx, deps, cfg.Addr); err != nil {
		return err
	}
	defer listener.Close()
	gate := newReadyGate()
	httpServer := newHTTPServer(cfg, gate)
	defer httpServer.Close()
	// A server started directly answers at once, holding requests at the
	// gate. A supervised one leaves them to the server it replaces, which
	// keeps accepting until this one is ready.
	var running *serving
	if handoff == nil {
		running = startServing(httpServer, listener)
	}

	backing, err := deps.openStore(cfg)
	if err != nil {
		return err
	}
	defer backing.Close()
	if fingerprint := backing.SecretKEKFingerprint(); fingerprint != "" {
		deps.logf("secret store ready with key fingerprint sha256:%s", fingerprint)
	}

	// A starting server holds no connections: presence recorded before a
	// crash or restart is stale until each worker reconnects.
	if err := backing.MarkAllDevicesOffline(ctx); err != nil {
		return err
	}
	// Devices removed before removal cascaded still hold live state.
	if err := backing.PurgeRemovedDevicesState(ctx); err != nil {
		return err
	}
	api := httpapi.NewServerWithOptions(backing, cfg.Options)
	gate.open(api.Routes())
	if handoff != nil {
		running = startServing(httpServer, listener)
		handoff.reportReady()
	}
	if code := api.SetupCode(); code != "" {
		deps.logf("no Foundry account exists yet; create the first owner in the web app with setup code %s (valid until an owner is created or the server restarts)", code)
	}
	deps.logf("foundry server listening on %s using sqlite %s, ready %s after start",
		listener.Addr(), cfg.DBPath, time.Since(started).Round(time.Millisecond))

	// Background work runs in one process at a time: a supervised server
	// starts it once the server it replaces has exited.
	if handoff != nil {
		if err := handoff.waitForPrevious(ctx); err != nil {
			return running.stop(cfg.ShutdownTimeout, api.Shutdown)
		}
	}
	api.RecoverChatQueues(ctx)
	go api.ReconcileStaleSessions(ctx)
	go api.RunFeishuGatewayMaintenance(ctx)
	go api.RunResourceLeases(ctx)
	go api.RunPersonalAgentSupervision(ctx)
	go api.RunPersonalAgentReminders(ctx)
	go api.RunPersonalAgentInbox(ctx)
	go api.RunPersonalAgentOperations(ctx)
	go api.RunSessionInbox(ctx)
	go api.RunChatQueueSteers(ctx)
	go api.RunKnowledgeOperations(ctx)
	go api.RunPersonalAgentRunControls(ctx)
	go api.RunPersonalAgentMaintenance(ctx)
	go api.RunPreviewRouteCheck(ctx)
	if !cfg.Options.Integrations.On() {
		deps.logf("integrations are off (%s=off): no Feishu bot connections, Connectors logins, refreshes or keep-alive, or skill repository checks", integrations.Env)
	}
	api.StartIntegrations(ctx)
	// Started with the server, not before it: on a large database it takes
	// seconds that every start would otherwise answer nothing for.
	go func() {
		if err := backing.RunMaintenance(ctx); err != nil && ctx.Err() == nil {
			deps.logf("startup maintenance: %v", err)
		}
	}()

	select {
	case err := <-running.served:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	return running.stop(cfg.ShutdownTimeout, api.Shutdown)
}

// readyGate is the server's handler while it starts: requests wait, up to
// startupWait, for the API to be ready, and are then answered by it. One
// still waiting after that is answered 503 with Retry-After. /healthz
// reports ready only once it is.
type readyGate struct {
	ready   chan struct{}
	handler http.Handler
}

// startupWait bounds how long a request waits for a starting server.
const startupWait = 30 * time.Second

func newReadyGate() *readyGate { return &readyGate{ready: make(chan struct{})} }

// open serves every request, waiting or new, with handler.
func (g *readyGate) open(handler http.Handler) {
	g.handler = handler
	close(g.ready)
}

func (g *readyGate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	select {
	case <-g.ready:
		g.handler.ServeHTTP(w, r)
		return
	default:
	}
	if r.URL.Path == "/healthz" {
		notReady(w)
		return
	}
	timer := time.NewTimer(startupWait)
	defer timer.Stop()
	select {
	case <-g.ready:
		g.handler.ServeHTTP(w, r)
	case <-timer.C:
		notReady(w)
	case <-r.Context().Done():
	}
}

// serverStartingHeader marks the 503 of a starting server, which the Web
// retries quietly (apps/web/src/api/http.ts); other 503s are the API's own.
const serverStartingHeader = "X-Foundry-Starting"

func notReady(w http.ResponseWriter) {
	w.Header().Set(serverStartingHeader, "1")
	w.Header().Set("Retry-After", "2")
	http.Error(w, "the Foundry server is starting", http.StatusServiceUnavailable)
}

// stopWhenOrphaned cancels a supervised server's context when its
// supervisor is gone (the server is reparented), so it drains and exits
// instead of holding the port its successor needs.
func stopWhenOrphaned(ctx context.Context) context.Context {
	ctx, cancel := context.WithCancel(ctx)
	parent := os.Getppid()
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if os.Getppid() != parent {
					log.Printf("restart handoff: supervisor %d is gone; shutting down", parent)
					cancel()
					return
				}
			}
		}
	}()
	return ctx
}

// serve runs httpServer on listener until it fails or ctx is cancelled, then
// drains in-flight requests within timeout.
//
// drainProtocols releases the resources http.Server.Shutdown cannot reach:
// SSE handlers and hijacked WebSockets. It runs synchronously before
// Shutdown, not via RegisterOnShutdown, because those callbacks are fired
// without ever being waited on. May be nil.
func serve(
	ctx context.Context,
	httpServer *http.Server,
	listener net.Listener,
	timeout time.Duration,
	drainProtocols func(context.Context) error,
) error {
	serving := startServing(httpServer, listener)
	select {
	case err := <-serving.served:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	return serving.stop(timeout, drainProtocols)
}

// serving is an http.Server running on a listener.
type serving struct {
	server   *http.Server
	listener net.Listener
	// served receives Serve's result.
	served <-chan error

	mu sync.Mutex
	// fresh are the accepted connections that have not sent a request yet.
	fresh map[net.Conn]struct{}
}

// freshConnGrace bounds how long a stopping server waits for the requests
// of connections it accepted just before it stopped accepting.
const freshConnGrace = time.Second

func startServing(httpServer *http.Server, listener net.Listener) *serving {
	s := &serving{server: httpServer, listener: listener, fresh: map[net.Conn]struct{}{}}
	observe := httpServer.ConnState
	httpServer.ConnState = func(conn net.Conn, state http.ConnState) {
		s.mu.Lock()
		if state == http.StateNew {
			s.fresh[conn] = struct{}{}
		} else {
			delete(s.fresh, conn)
		}
		s.mu.Unlock()
		if observe != nil {
			observe(conn, state)
		}
	}
	served := make(chan error, 1)
	s.served = served
	go func() {
		served <- httpServer.Serve(listener)
	}()
	return s
}

func (s *serving) freshConns() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.fresh)
}

// stop stops accepting, then drains in-flight requests within timeout (see
// serve for drainProtocols).
//
// Accepting stops before Shutdown: http.Server drops, unanswered, a request
// it reads once Shutdown has begun. A connection accepted just before the
// listener closed, whose request is still on its way, would see the
// connection close: the proxy answers 502 even though, on the restart
// handoff's shared socket, the next server was already accepting. Such
// requests are waited for (freshConnGrace) and answered.
func (s *serving) stop(timeout time.Duration, drainProtocols func(context.Context) error) error {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	_ = s.listener.Close()
	servedErr := <-s.served
	for deadline := time.Now().Add(freshConnGrace); s.freshConns() > 0 && time.Now().Before(deadline); {
		time.Sleep(10 * time.Millisecond)
	}

	if drainProtocols != nil {
		if err := drainProtocols(shutdownCtx); err != nil {
			// Streams outlasted the budget. Shutdown below still runs;
			// Close() then drops whatever is left.
			log.Printf("protocol shutdown incomplete: %v", err)
		}
	}

	shutdownErr := s.server.Shutdown(shutdownCtx)
	if shutdownErr != nil {
		// The drain budget expired; drop whatever is left.
		_ = s.server.Close()
	}
	if servedErr != nil && !errors.Is(servedErr, net.ErrClosed) && !errors.Is(servedErr, http.ErrServerClosed) {
		return servedErr
	}
	return shutdownErr
}

func defaultDependencies() dependencies {
	var listenConfig net.ListenConfig
	return dependencies{
		getenv: os.Getenv,
		listen: func(ctx context.Context, addr string) (net.Listener, error) {
			return listenConfig.Listen(ctx, "tcp", addr)
		},
		logf: log.Printf,
		openStore: func(cfg config) (serverStore, error) {
			return sqlitestore.OpenWithOptions(cfg.DBPath, sqlitestore.Options{
				SeedDemo:      cfg.SeedDemo,
				SecretKeyPath: cfg.SecretKeyPath,
			})
		},
	}
}
