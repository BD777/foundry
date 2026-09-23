package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/httpapi"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// dependencies are the seams the entry point resolves at runtime. Tests
// override them to exercise lifecycle behavior without touching real
// environment variables, privileged ports, or on-disk databases.
type dependencies struct {
	getenv    func(key string) string
	listen    func(ctx context.Context, addr string) (net.Listener, error)
	logf      func(format string, args ...any)
	openStore func(cfg config) (store.Store, error)
}

// run resolves configuration, opens the store, and serves until ctx is
// cancelled. The store is closed exactly once, on the way out of this call.
func run(ctx context.Context, deps dependencies) error {
	cfg := loadConfig(deps.getenv)
	if err := validateSettings(cfg); err != nil {
		return err
	}

	backing, err := deps.openStore(cfg)
	if err != nil {
		return err
	}
	defer backing.Close()
	if fingerprinter, ok := backing.(interface{ SecretKEKFingerprint() string }); ok {
		if fingerprint := fingerprinter.SecretKEKFingerprint(); fingerprint != "" {
			deps.logf("secret store ready with key fingerprint sha256:%s", fingerprint)
		}
	}
	listener, err := deps.listen(ctx, cfg.Addr)
	if err != nil {
		return err
	}

	if _, ok := backing.(store.AccountStore); !ok {
		return errors.New("the configured store does not support accounts")
	}
	api := httpapi.NewServerWithOptions(backing, cfg.Options)
	httpServer := newHTTPServer(cfg, api.Routes())
	if code := api.SetupCode(); code != "" {
		deps.logf("no Foundry account exists yet; create the first owner in the web app with setup code %s (valid until an owner is created or the server restarts)", code)
	}

	deps.logf("foundry server listening on %s using sqlite %s", listener.Addr(), cfg.DBPath)
	return serve(ctx, httpServer, listener, cfg.ShutdownTimeout, api.Shutdown)
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
	served := make(chan error, 1)
	go func() {
		served <- httpServer.Serve(listener)
	}()

	select {
	case err := <-served:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	if drainProtocols != nil {
		if err := drainProtocols(shutdownCtx); err != nil {
			// Streams outlasted the budget. Shutdown below still runs so the
			// listener closes; Close() then drops whatever is left.
			log.Printf("protocol shutdown incomplete: %v", err)
		}
	}

	shutdownErr := httpServer.Shutdown(shutdownCtx)
	if shutdownErr != nil {
		// The drain budget expired; drop whatever is left so Serve returns.
		_ = httpServer.Close()
	}
	if err := <-served; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
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
		openStore: func(cfg config) (store.Store, error) {
			return sqlitestore.OpenWithOptions(cfg.DBPath, sqlitestore.Options{
				SeedDemo:      cfg.SeedDemo,
				SecretKeyPath: cfg.SecretKeyPath,
			})
		},
	}
}
