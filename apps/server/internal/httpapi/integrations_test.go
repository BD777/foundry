package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/skillrepo"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// integrationProbe builds a server with the switch in the given position
// over a store holding what the starter acts on, with the starter's egress
// pointed at a trap. reached counts what got to the trap; check, if set,
// runs after the starter (state it must leave behind).
type integrationProbe func(t *testing.T, sw *integrations.Switch) (server *Server, reached func() int, check func(t *testing.T))

// Every integration starter, run on, reaches its trap (so the probe really
// exercises it); run off, it returns and nothing reaches the trap. A starter
// added to integrationStarters without a probe fails here.
func TestIntegrationStartersHonourTheSwitch(t *testing.T) {
	probes := map[string]integrationProbe{
		"feishu-event-connections": probeFeishuBots,
		"connectors-keep-alive":    probeConnectorsKeepAlive,
		"skill-repository-checks":  probeSkillRepositoryChecks,
	}
	listed := map[string]bool{}
	for _, starter := range (&Server{}).integrationStarters() {
		listed[starter.name] = true
		if probes[starter.name] == nil {
			t.Errorf("integration starter %q has no probe here: seed what it acts on, trap its egress, and add it to probes", starter.name)
		}
	}
	for name := range probes {
		if !listed[name] {
			t.Errorf("probe %q names no integration starter", name)
		}
	}
	for name, probe := range probes {
		if !listed[name] {
			continue
		}
		for _, on := range []bool{true, false} {
			label := name + "/off"
			if on {
				label = name + "/on"
			}
			t.Run(label, func(t *testing.T) { runIntegrationProbe(t, name, probe, integrations.New(on)) })
		}
	}
}

func runIntegrationProbe(t *testing.T, name string, probe integrationProbe, sw *integrations.Switch) {
	server, reached, check := probe(t, sw)
	var start func(context.Context)
	for _, starter := range server.integrationStarters() {
		if starter.name == name {
			start = starter.start
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		start(ctx)
	}()
	defer func() {
		cancel()
		<-done
	}()
	if sw.On() {
		deadline := time.Now().Add(10 * time.Second)
		for reached() == 0 {
			if time.Now().After(deadline) {
				t.Fatalf("%s never reached its trap with integrations on: the probe does not exercise it", name)
			}
			time.Sleep(5 * time.Millisecond)
		}
	} else {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("%s kept running with integrations off", name)
		}
		// Whatever it may have spawned has had time to dial out.
		time.Sleep(300 * time.Millisecond)
		if n := reached(); n != 0 {
			t.Fatalf("%s reached its trap %d times with integrations off", name, n)
		}
	}
	if check != nil {
		check(t)
	}
}

// egressTrap counts every request and answers 503.
func egressTrap(t *testing.T) (*httptest.Server, func() int) {
	var hits atomic.Int64
	trap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		http.Error(w, "trap", http.StatusServiceUnavailable)
	}))
	t.Cleanup(trap.Close)
	return trap, func() int { return int(hits.Load()) }
}

func probeFeishuBots(t *testing.T, sw *integrations.Switch) (*Server, func() int, func(*testing.T)) {
	f := newExternalAccountsFixture(t)
	ctx := context.Background()
	app := f.createApp(f.alice, "")
	if err := f.db.SetWorkspaceFeishuBotApp(ctx, "ws_alice", app.ID); err != nil {
		t.Fatal(err)
	}
	trap, reached := egressTrap(t)
	server := NewServerWithOptions(f.db, ServerOptions{AllowedOrigin: accountsTestOrigin, Integrations: sw})
	server.feishuEvents.Domain = trap.URL
	t.Cleanup(server.feishuEvents.Stop)
	return server, reached, func(t *testing.T) {
		if sw.On() {
			return
		}
		bot, err := server.feishu.WorkspaceBot(ctx, "ws_alice")
		if err != nil || bot.Status != store.FeishuBotStatusError || !strings.Contains(bot.StatusDetail, "integrations are off") {
			t.Fatalf("bot with integrations off: %+v, %v", bot, err)
		}
	}
}

func probeConnectorsKeepAlive(t *testing.T, sw *integrations.Switch) (*Server, func() int, func(*testing.T)) {
	f := newExternalAccountsFixture(t)
	f.connect(f.alice, f.createApp(f.alice, ""))
	// The server's own service (real Feishu adapter, the app's base URL is
	// the fake), sweeping often and treating every account as due.
	server := NewServerWithOptions(f.db, ServerOptions{AllowedOrigin: accountsTestOrigin, Integrations: sw})
	server.connectors.ServerHeld.KeepAliveInterval = 5 * time.Millisecond
	server.connectors.ServerHeld.KeepAliveLead = 365 * 24 * time.Hour
	server.connectors.ServerHeld.Logf = t.Logf
	base := f.fake.Refreshes()
	return server, func() int { return f.fake.Refreshes() - base }, nil
}

// countingSource is a skill repository host that counts every read.
type countingSource struct{ reads atomic.Int64 }

var errTrapped = errors.New("trapped")

func (c *countingSource) Resolve(context.Context, string, string) (string, error) {
	c.reads.Add(1)
	return "", errTrapped
}
func (c *countingSource) Fetch(context.Context, string, string) (*skillrepo.Checkout, error) {
	c.reads.Add(1)
	return nil, errTrapped
}
func (c *countingSource) LatestRelease(context.Context, string) (string, string, bool, error) {
	c.reads.Add(1)
	return "", "", false, errTrapped
}
func (c *countingSource) Describe(context.Context, string) (string, error) {
	c.reads.Add(1)
	return "", errTrapped
}

func probeSkillRepositoryChecks(t *testing.T, sw *integrations.Switch) (*Server, func() int, func(*testing.T)) {
	f := newExternalAccountsFixture(t)
	if _, err := f.db.CreateSkillRepository(context.Background(), store.SkillRepository{URL: "https://github.com/acme/tools", Label: "github.com/acme/tools", Subpath: "skills"}, ""); err != nil {
		t.Fatal(err)
	}
	server := NewServerWithOptions(f.db, ServerOptions{AllowedOrigin: accountsTestOrigin, Integrations: sw})
	source := &countingSource{}
	server.skillRepos = source
	server.skillRepositoryFirstCheck = 5 * time.Millisecond
	return server, func() int { return int(source.reads.Load()) }, nil
}

// With integrations off, what a person or a session asks of an integration
// answers why it cannot, instead of reaching the provider.
func TestIntegrationsOffAnswersRequests(t *testing.T) {
	f := newExternalAccountsFixture(t)
	app := f.createApp(f.alice, "")
	account := f.connect(f.alice, app)
	f.server.connectors.ServerHeld.Integrations = integrations.New(false)
	f.server.feishu.Integrations = integrations.New(false)
	refreshes := f.fake.Refreshes()

	for _, call := range []struct{ method, path, body string }{
		{http.MethodPost, "/api/external-accounts/" + account.ID + "/refresh", ""},
		{http.MethodPost, "/api/external-accounts/connect", `{"appId":"` + app.ID + `","scopes":["docx:document:readonly"]}`},
		{http.MethodPost, "/api/external-accounts/" + account.ID + "/revoke", ""},
	} {
		recorder := doAuthCall(t, f.handler, f.as(f.alice, call.method, call.path, call.body))
		expectStatus(t, recorder, http.StatusServiceUnavailable, call.path)
		if !strings.Contains(recorder.Body.String(), "integrations are off on this server") {
			t.Fatalf("%s answered %s", call.path, recorder.Body.String())
		}
	}
	// A session's mint that needs a refresh fails the same way.
	f.server.connectors.ServerHeld.RefreshLead = 365 * 24 * time.Hour
	if _, err := f.server.connectors.ServerHeld.Mint(context.Background(), account, externalaccounts.Use{By: "session"}); !errors.Is(err, integrations.ErrOff) {
		t.Fatalf("mint with integrations off: %v", err)
	}
	if f.fake.Refreshes() != refreshes || len(f.fake.Revoked()) != 0 {
		t.Fatalf("the provider was reached: %d refreshes, revoked %v", f.fake.Refreshes()-refreshes, f.fake.Revoked())
	}

	// Running a workspace bot on an app says why it is not connected.
	var bot store.WorkspaceFeishuBot
	f.call(f.alice, http.MethodPost, "/api/workspaces/ws_alice/feishu", `{"appId":"`+app.ID+`"}`, http.StatusOK, "save bot", &bot)
	if bot.Status != store.FeishuBotStatusError || !strings.Contains(bot.StatusDetail, "integrations are off") {
		t.Fatalf("saved bot with integrations off: %+v", bot)
	}
}
