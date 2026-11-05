package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/connectors"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The official cf CLI contract (DEV-126): the installed `cf` (FOUNDRY_CF_CLI,
// else ~/.foundry-tools/cloudflare-cf-0.14.0/node_modules/.bin/cf), given only
// the environment the worker's own code prepares for a session
// (packages/worker/dist: the stand-in token and the loopback forwarder),
// reaches a fake Cloudflare only through the real forwarder and gateway.
// The fake is the official MCP's `execute` tool over an in-memory zone: it
// accepts only the account's real token, and cf's HOME is a scratch folder
// behind a dead proxy. Skipped when cf, node or the built worker is missing.
func TestCloudflareCLIContractThroughTheGateway(t *testing.T) {
	workerDist := requireWorkerBuild(t, filepath.Join("connectors", "cloudflare.js"))
	cli := os.Getenv("FOUNDRY_CF_CLI")
	if cli == "" {
		home, _ := os.UserHomeDir()
		cli = filepath.Join(home, ".foundry-tools", "cloudflare-cf-0.14.0", "node_modules", ".bin", "cf")
	}
	if _, err := os.Stat(cli); err != nil {
		t.Skipf("no cf at %s", cli)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("no node to run the worker's forwarder")
	}
	versionOutput, _ := exec.Command(cli, "--version").CombinedOutput()
	version := regexp.MustCompile(`v?(\d+\.\d+\.\d+)`).FindStringSubmatch(string(versionOutput))
	if version == nil {
		t.Fatalf("cf --version: %s", versionOutput)
	}
	t.Logf("cf %s", version[1])

	f := newExternalAccountsFixture(t)
	zone, otherZone := strings.Repeat("a", 32), strings.Repeat("b", 32)
	upstream := newFakeCloudflare(t, map[string]string{zone: "fixture.invalid", otherZone: "unbound.invalid"})
	adapter := externalaccounts.NewCloudflare()
	adapter.BaseURL = upstream.URL
	adapter.Client = upstream.Client()
	service := externalaccounts.NewService(f.db, f.db, externalaccounts.NewRegistry(adapter))
	f.server.connectors.ServerHeld = service
	f.server.connectors.Cloudflare = connectors.NewCloudflareGateway(f.db, service)
	f.server.connectors.SetGatewayIssuer(f.server.feishuGateway)
	ctx := context.Background()
	app, err := f.db.CreateExternalProviderApp(ctx, store.ExternalProviderApp{ID: "cf-app", Provider: "cloudflare", OwnerUserID: f.aliceID, ClientID: "fixture-public", CreatedVia: "dynamic_registration"})
	if err != nil {
		t.Fatal(err)
	}
	account, err := f.db.SaveExternalAccount(ctx, store.ExternalAccount{ID: "cf-account", AppID: app.ID, Provider: "cloudflare", OwnerUserID: f.aliceID, Label: "Fixture", DisplayName: "Fixture user", Subject: "user:fixture", Mode: store.ExternalCredentialServerHeld, Status: store.ExternalAccountReady, GrantedScopes: []string{"zone.read", "dns.read", "dns.write"}})
	if err != nil {
		t.Fatal(err)
	}
	grant, _ := json.Marshal(externalaccounts.Grant{AccessToken: fakeCloudflareToken, RefreshToken: "fixture-refresh", AccessExpiresAt: time.Now().Add(12 * time.Hour), RefreshExpiresAt: time.Now().Add(48 * time.Hour)})
	if err := f.db.PutSecret(ctx, externalaccounts.GrantSecretID(account.ID), grant, externalaccounts.GrantSecretID(account.ID)); err != nil {
		t.Fatal(err)
	}
	if err := f.db.SetWorkspaceExternalAccounts(ctx, "ws_alice", f.aliceID, []string{account.ID}, map[string][]string{account.ID: {zone}}); err != nil {
		t.Fatal(err)
	}
	session, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Title: "Edit DNS", Prompt: "Edit DNS", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	// What session dispatch sends the worker: the stand-in, and the account
	// every bound zone is in, which cf is told natively.
	dispatched := f.server.connectors.SessionConnectors(ctx, connectors.SessionRequest{Session: session, DeviceOwner: f.aliceID})
	materials := dispatched.ExternalAccounts
	if len(materials) != 1 || materials[0].Tool != "cf" || materials[0].ProviderAccountID != fakeCloudflareAccount {
		t.Fatalf("session materials: %+v", materials)
	}

	renewals := &countingHandler{next: f.handler, path: "/api/connectors/cloudflare/session-handle"}
	listener := httptest.NewServer(renewals)
	t.Cleanup(listener.Close)
	scratch := t.TempDir()
	worker := startCloudflareContractWorker(t, node, workerDist, scratch, map[string]any{
		"serverURL": listener.URL, "credential": f.aliceDevice,
		"session": map[string]any{"id": session.ID, "workspaceId": "ws_alice", "provider": "claude", "source": "chat"}, "material": materials[0],
	})
	token, base := worker.Env["CLOUDFLARE_API_TOKEN"], worker.Env["CLOUDFLARE_API_BASE_URL"]
	if worker.Env["CLOUDFLARE_ACCOUNT_ID"] != fakeCloudflareAccount {
		t.Fatalf("cf was not told the account the zones are in: %v", worker.Env)
	}
	if !strings.HasPrefix(token, "fdycf_user_") || !strings.HasPrefix(base, "http://127.0.0.1:") || token == fakeCloudflareToken {
		t.Fatalf("cf environment: %v", worker.Env)
	}

	home := filepath.Join(scratch, "home")
	run := func(args ...string) (string, error) {
		command := exec.Command(cli, args...)
		command.Env = []string{
			"HOME=" + home, "XDG_CONFIG_HOME=" + filepath.Join(home, ".config"), "PATH=" + filepath.Dir(node) + ":/usr/bin:/bin",
			"CLOUDFLARE_API_TOKEN=" + token, "CLOUDFLARE_API_BASE_URL=" + base, "CLOUDFLARE_ACCOUNT_ID=" + worker.Env["CLOUDFLARE_ACCOUNT_ID"], "CI=1", "NO_COLOR=1",
			"HTTPS_PROXY=http://127.0.0.1:9", "HTTP_PROXY=http://127.0.0.1:9", "NO_PROXY=127.0.0.1,localhost",
		}
		command.Dir = scratch
		output, err := command.CombinedOutput()
		return string(output), err
	}
	expect := func(label, want string, args ...string) string {
		t.Helper()
		output, err := run(args...)
		if err != nil || !strings.Contains(output, want) {
			t.Fatalf("%s: %v\n%s", label, err, output)
		}
		return output
	}
	refuse := func(label string, wants []string, args ...string) {
		t.Helper()
		output, err := run(args...)
		if err == nil {
			t.Fatalf("%s: cf succeeded\n%s", label, output)
		}
		for _, want := range wants {
			if !strings.Contains(output, want) {
				t.Fatalf("%s: the refusal does not say %q\n%s", label, want, output)
			}
		}
	}

	// Reads: the bound zone, and the lookup of a zone by name cf makes.
	listed := expect("zones list", "fixture.invalid", "zones", "list")
	if strings.Contains(listed, "unbound.invalid") {
		t.Fatalf("cf listed a zone the workspace did not bind:\n%s", listed)
	}
	expect("zones list --name", "fixture.invalid", "zones", "list", "--name", "fixture.invalid")
	if output := expect("zones list --name of an unbound zone", "", "zones", "list", "--name", "unbound.invalid"); strings.Contains(output, "unbound.invalid") {
		t.Fatalf("a name filter reached outside the bound zones:\n%s", output)
	}
	// Told its account, cf finds a zone by domain itself (it lists the zones
	// of that account, which the gateway answers from the bound ones), without
	// reading /accounts or /memberships; a zone that is not bound is not found.
	expect("dns records list by domain name", "[", "dns", "records", "list", "--zone", "fixture.invalid")
	if output, err := run("dns", "records", "list", "--zone", "unbound.invalid"); err == nil {
		t.Fatalf("a zone that is not bound was found by its domain:\n%s", output)
	}
	expect("dns records list by zone ID", "[", "dns", "records", "list", "--zone", zone)

	// Read level: a change is refused by the server, with a readable reason.
	create := []string{"dns", "records", "create", "--zone", zone, "--body", `{"type":"A","name":"lan.fixture.invalid","content":"192.0.2.10","ttl":60}`}
	refuse("create at read level", []string{"dns_edit", "read"}, create...)
	if changes := upstream.changes(); len(changes) != 0 {
		t.Fatalf("a refused change reached Cloudflare: %v", changes)
	}

	// The owner raises the level; the same session, with no restart, writes.
	accessPath := "/api/workspaces/ws_alice/external-accounts/" + account.ID + "/access"
	expectStatus(t, doAuthCall(t, f.handler, f.as(f.alice, "PUT", accessPath, `{"access":"dns_edit"}`)), 200, "set dns_edit")
	created := expect("create at dns_edit", "lan.fixture.invalid", create...)
	recordID := regexp.MustCompile(`[a-f0-9]{32}`).FindString(created)
	if recordID == "" {
		t.Fatalf("cf printed no record id:\n%s", created)
	}
	expect("edit", "192.0.2.11", "dns", "records", "edit", recordID, "--zone", zone, "--body", `{"content":"192.0.2.11"}`)
	expect("delete", recordID, "dns", "records", "delete", recordID, "--zone", zone, "--force")
	refuse("a change outside DNS records", []string{"outside what a workspace's Cloudflare access allows", "dns_records"}, "cache", "purge", "--zone", zone, "--force", "--body", `{"purge_everything":true}`)
	// Cloudflare's own error comes back as it was, with its code and status.
	refuse("a record that does not exist", []string{"7003", "No route for that URI", "404"}, "dns", "records", "delete", strings.Repeat("9", 32), "--zone", zone, "--force")
	changes := upstream.changes()[:3]
	if len(changes) != 3 || changes[0] != "POST /zones/"+zone+"/dns_records" || !strings.HasPrefix(changes[1], "PATCH ") && !strings.HasPrefix(changes[1], "PUT ") || changes[2] != "DELETE /zones/"+zone+"/dns_records/"+recordID {
		t.Fatalf("changes that reached Cloudflare: %v", changes)
	}
	if upstream.tokenMisuse() {
		t.Fatal("a call reached Cloudflare with something other than the account's token")
	}

	// Every attempt is a line of the account's activity, in order.
	activity := doAuthCall(t, f.handler, f.as(f.alice, "GET", "/api/connectors/cloudflare/accounts/"+account.ID+"/activity", ""))
	expectStatus(t, activity, 200, "activity")
	var log struct {
		Entries []store.CloudflareActivityEntry `json:"entries"`
	}
	if err := json.Unmarshal(activity.Body.Bytes(), &log); err != nil {
		t.Fatal(err)
	}
	summary := []string{}
	for _, e := range log.Entries {
		if e.Kind == connectors.CloudflareWriteEvent {
			summary = append(summary, e.Method+":"+e.Result)
		}
	}
	// Newest first.
	if got := strings.Join(summary, ","); !regexp.MustCompile(`^DELETE:failed,POST:refused,DELETE:succeeded,(PATCH|PUT):succeeded,POST:succeeded,POST:refused$`).MatchString(got) {
		// Newest first: the failed delete, the purge refused by path, then the
		// first POST refused by level.
		t.Fatalf("activity: %s", got)
	}

	// The stand-in is renewed before it expires, by the real endpoint.
	if renewals.count() != 0 {
		t.Fatalf("renewed %d times before the stand-in neared its expiry", renewals.count())
	}
	worker.Send("skew")
	expect("zones list with an old stand-in", "fixture.invalid", "zones", "list")
	if renewals.count() == 0 {
		t.Fatal("the near-expired stand-in was not renewed")
	}
	worker.Send("unskew")
	expect("zones list after renewal", "fixture.invalid", "zones", "list")
	worker.Stop()
	if output, err := run("zones", "list"); err == nil {
		t.Fatalf("the stand-in outlived the session's run:\n%s", output)
	}
}

const fakeCloudflareToken = "fixture-cf-access-token"

// fakeCloudflareAccount is the Cloudflare account both fake zones are in.
var fakeCloudflareAccount = strings.Repeat("e", 32)

// fakeCloudflare is the official MCP's `execute` tool over one account's
// zones, keeping DNS records in memory.
type fakeCloudflare struct {
	*httptest.Server
	mu      sync.Mutex
	zones   map[string]string
	records map[string]map[string]any
	log     []string
	misuse  bool
	next    int
}

func newFakeCloudflare(t *testing.T, zones map[string]string) *fakeCloudflare {
	t.Helper()
	u := &fakeCloudflare{zones: zones, records: map[string]map[string]any{}}
	u.Server = httptest.NewServer(http.HandlerFunc(u.serve))
	t.Cleanup(u.Close)
	return u
}

func (u *fakeCloudflare) changes() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.log...)
}

func (u *fakeCloudflare) tokenMisuse() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.misuse
}

func (u *fakeCloudflare) serve(w http.ResponseWriter, r *http.Request) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+fakeCloudflareToken {
		u.misuse = true
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	var input struct {
		Params struct {
			Arguments struct {
				Code string `json:"code"`
			} `json:"arguments"`
		} `json:"params"`
	}
	_ = json.NewDecoder(r.Body).Decode(&input)
	var call struct {
		Method string         `json:"method"`
		Path   string         `json:"path"`
		Body   map[string]any `json:"body"`
	}
	code := strings.TrimSuffix(strings.TrimPrefix(input.Params.Arguments.Code, "async () => { return await cloudflare.request("), "); }")
	if err := json.Unmarshal([]byte(code), &call); err != nil {
		u.misuse = true
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	reply := func(result any) {
		body, _ := json.Marshal(map[string]any{"success": true, "errors": []any{}, "messages": []any{}, "result": result})
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"content": []any{map[string]any{"type": "text", "text": string(body)}}}})
	}
	parts := strings.Split(strings.TrimPrefix(call.Path, "/"), "/")
	if call.Method != http.MethodGet {
		u.log = append(u.log, call.Method+" "+call.Path)
	}
	switch {
	case len(parts) == 2 && parts[0] == "zones":
		reply(map[string]any{"id": parts[1], "name": u.zones[parts[1]], "status": "active", "type": "full", "account": map[string]any{"id": fakeCloudflareAccount, "name": "Fixture account"}})
	case len(parts) == 3 && parts[2] == "dns_records" && call.Method == http.MethodGet:
		out := []any{}
		for _, record := range u.records {
			out = append(out, record)
		}
		reply(out)
	case len(parts) == 3 && parts[2] == "dns_records" && call.Method == http.MethodPost:
		u.next++
		id := fmt.Sprintf("%032x", u.next)
		record := map[string]any{"id": id}
		for k, v := range call.Body {
			record[k] = v
		}
		u.records[id] = record
		reply(record)
	case len(parts) == 4 && parts[2] == "dns_records" && u.records[parts[3]] != nil:
		record := u.records[parts[3]]
		switch call.Method {
		case http.MethodPatch, http.MethodPut:
			for k, v := range call.Body {
				record[k] = v
			}
		case http.MethodDelete:
			delete(u.records, parts[3])
			record = map[string]any{"id": parts[3]}
		}
		reply(record)
	default:
		w.Header().Set("Content-Type", "application/json")
		text := `Cloudflare API error 404: {"success":false,"errors":[{"code":7003,"message":"No route for that URI"}]}`
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"isError": true, "content": []any{map[string]any{"type": "text", "text": text}}}})
	}
}

type countingHandler struct {
	next http.Handler
	path string
	mu   sync.Mutex
	n    int
}

func (c *countingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == c.path {
		c.mu.Lock()
		c.n++
		c.mu.Unlock()
	}
	c.next.ServeHTTP(w, r)
}

func (c *countingHandler) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

type cloudflareContractWorker struct {
	Env     map[string]string `json:"env"`
	command *exec.Cmd
	stdin   io.WriteCloser
	stdout  *bufio.Reader
}

// Send gives the worker a command and waits for it to be done.
func (w *cloudflareContractWorker) Send(command string) {
	_, _ = fmt.Fprintln(w.stdin, command)
	_, _ = w.stdout.ReadString('\n')
}

func (w *cloudflareContractWorker) Stop() {
	if w.stdin != nil {
		_ = w.stdin.Close()
		_ = w.command.Wait()
		w.stdin = nil
	}
}

const cloudflareContractWorkerScript = `
import { createInterface } from "node:readline";
const [cloudflareModule] = process.argv.slice(2);
const input = JSON.parse(process.env.CONTRACT_INPUT);
const { prepareCloudflareSession } = await import(cloudflareModule);
let skew = 0;
const held = await prepareCloudflareSession(input.session, [input.material], {
  serverURL: input.serverURL,
  credential: () => input.credential,
  now: () => Date.now() + skew,
});
console.log(JSON.stringify({ env: held.environment }));
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line === "skew") skew = (29 * 60 + 45) * 1000;
  if (line === "unskew") skew = 0;
  console.log("done");
});
lines.on("close", () => { held.release(); process.exit(0); });
`

// startCloudflareContractWorker runs the worker's own Cloudflare session
// preparation: the stand-in the CLI is given and the forwarder it calls.
func startCloudflareContractWorker(t *testing.T, node, dist, scratch string, input map[string]any) *cloudflareContractWorker {
	t.Helper()
	script := filepath.Join(scratch, "contract-worker.mjs")
	if err := os.WriteFile(script, []byte(cloudflareContractWorkerScript), 0o600); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(input)
	command := exec.Command(node, script, "file://"+filepath.Join(dist, "connectors", "cloudflare.js"))
	command.Env = append(os.Environ(), "CONTRACT_INPUT="+string(encoded), "FOUNDRY_STATE_ROOT="+filepath.Join(scratch, "state"))
	command.Stderr = os.Stderr
	stdin, _ := command.StdinPipe()
	stdout, _ := command.StdoutPipe()
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	worker := &cloudflareContractWorker{command: command, stdin: stdin, stdout: bufio.NewReader(stdout)}
	t.Cleanup(worker.Stop)
	line, err := worker.stdout.ReadString('\n')
	if err != nil || json.Unmarshal([]byte(line), worker) != nil || worker.Env["CLOUDFLARE_API_TOKEN"] == "" {
		t.Fatalf("worker answered %q: %v", line, err)
	}
	return worker
}
