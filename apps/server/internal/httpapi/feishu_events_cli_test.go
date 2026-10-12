package httpapi

import (
	"context"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents"
)

// The whole path, as wired: the real feishu-cli, configured by the real
// worker (its profile and loopback forwarder), runs `event consume` through
// the server's gateway, which hands the event socket to the server's one
// connection per app; that connection is the only one Feishu (a fake) ever
// sees, and the event Feishu pushes reaches feishu-cli. Skipped when
// feishu-cli, node or the built worker is missing.
func TestFeishuCLIEventConsumeThroughTheServer(t *testing.T) {
	cli := os.Getenv("FOUNDRY_FEISHU_CLI")
	if cli == "" {
		home, _ := os.UserHomeDir()
		cli = filepath.Join(home, ".foundry-tools", "bin", "feishu-cli")
	}
	if _, err := os.Stat(cli); err != nil {
		t.Skipf("no feishu-cli at %s", cli)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("no node to run the worker's forwarder")
	}
	workerDist, _ := filepath.Abs("../../../../packages/worker/dist")
	if _, err := os.Stat(filepath.Join(workerDist, "feishu-gateway-forwarder.js")); err != nil {
		t.Skip("the worker is not built (packages/worker/dist)")
	}
	versionOutput, _ := exec.Command(cli, "--version").CombinedOutput()
	version := regexp.MustCompile(`v?(\d+\.\d+\.\d+)`).FindStringSubmatch(string(versionOutput))
	if version == nil {
		t.Fatalf("feishu-cli --version: %s", versionOutput)
	}

	f := &gatewayFixture{externalAccountsFixture: newExternalAccountsFixture(t)}
	// The fixture rebuilt the gateway around its own Connectors service.
	f.server.serveGatewayEvents()
	source := feishuevents.NewFakeSource("cli_fake", "secret_fake")
	t.Cleanup(source.Close)
	f.server.feishuEvents.Domain = source.URL()
	t.Cleanup(f.server.feishuEvents.Stop)
	f.listener = httptest.NewServer(f.handler)
	t.Cleanup(f.listener.Close)
	f.app = f.createApp(f.alice, "")
	f.account = f.connect(f.alice, f.app)
	if err := f.db.SetWorkspaceExternalAccounts(context.Background(), "ws_alice", f.aliceID, []string{f.account.ID}); err != nil {
		t.Fatal(err)
	}
	f.session, f.material = f.startSession()
	scratch := t.TempDir()
	home := filepath.Join(scratch, "home")
	worker := startContractWorker(t, node, workerDist, scratch, map[string]any{
		"serverURL": f.listener.URL, "credential": f.aliceDevice, "home": home,
		"manifest": filepath.Join(scratch, "manifest.json"), "version": version[1],
		"session":  map[string]any{"id": f.session.ID, "workspaceId": "ws_alice", "provider": "claude", "source": "chat"},
		"material": f.material,
	})

	go func() {
		// Feishu pushes once the server's connection is up, which the
		// socket feishu-cli opened asked for.
		if source.WaitOpen(1, 30*time.Second) {
			time.Sleep(200 * time.Millisecond)
			_, _ = source.Push(feishuevents.MessagePayload("cli_fake", "ev_through_server", "oc_1", "om_1", "", "hello agent", true), 1)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, cli, "event", "consume", "im.message.receive_v1", "--max-events", "1", "--timeout", "45s")
	command.Env = []string{
		"HOME=" + home, "PATH=/usr/bin:/bin", "FEISHU_PROFILE=" + worker.Env["FEISHU_PROFILE"], "FEISHU_CLI_REMOTE_META=off",
		"HTTPS_PROXY=http://127.0.0.1:9", "HTTP_PROXY=http://127.0.0.1:9", "NO_PROXY=127.0.0.1,localhost",
	}
	command.Dir = scratch
	// stdin EOF makes feishu-cli exit: keep it open.
	stdin, _ := command.StdinPipe()
	defer stdin.Close()
	output, err := command.CombinedOutput()
	if err != nil || !strings.Contains(string(output), `"event_id":"ev_through_server"`) {
		t.Fatalf("event consume: %v\n%s", err, output)
	}
	if source.EndpointRequests() != 1 || source.Accepted() != 1 {
		t.Fatalf("feishu saw %d endpoint requests and %d connections, want only the server's one", source.EndpointRequests(), source.Accepted())
	}
	if acks := source.WaitAcks(1, 5*time.Second); len(acks) != 1 || acks[0].Code != 200 {
		t.Fatalf("the server's acks = %+v", acks)
	}
}
