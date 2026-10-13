package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishugateway"
	"github.com/gorilla/websocket"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
)

// The feishu-cli contract: the installed feishu-cli (FOUNDRY_FEISHU_CLI, else
// ~/.foundry-tools/bin/feishu-cli), configured by the real worker code
// (packages/worker/dist: the session's profile and the loopback forwarder),
// reaches a fake Feishu only through the gateway, for a user call, a bot
// call, a chunked upload, a ranged download and the event connection; its
// `auth status` reads healthy and its user token refresh is answered by the
// gateway. The
// fake accepts only real tokens; feishu-cli's HOME is a scratch folder and
// any call that tried to leave for the internet hits a dead proxy. Skipped
// when feishu-cli, node or the built worker is missing. The worker's
// verifiedFeishuCliVersions names the versions this passed with.

func TestFeishuCLIContractThroughTheGateway(t *testing.T) {
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
	t.Logf("feishu-cli %s", version[1])

	f := &gatewayFixture{externalAccountsFixture: newExternalAccountsFixture(t)}
	upstream := newContractUpstream(f.externalAccountsFixture)
	f.fake.API = upstream
	events := &contractEvents{t: t}
	f.server.feishuGateway.Events = events
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
	profile := worker.Env["FEISHU_PROFILE"]
	config, err := os.ReadFile(filepath.Join(home, ".feishu-cli", "profiles", profile, "config.yaml"))
	if err != nil || strings.Contains(string(config), "secret_fake") || !strings.Contains(string(config), "base_url: \"http://127.0.0.1:") {
		t.Fatalf("profile config: %s %v", config, err)
	}

	run := func(args ...string) (string, error) {
		command := exec.Command(cli, args...)
		command.Env = []string{
			"HOME=" + home, "PATH=/usr/bin:/bin", "FEISHU_PROFILE=" + profile, "FEISHU_CLI_REMOTE_META=off",
			"HTTPS_PROXY=http://127.0.0.1:9", "HTTP_PROXY=http://127.0.0.1:9", "NO_PROXY=127.0.0.1,localhost",
		}
		command.Dir = scratch
		output, err := command.CombinedOutput()
		return string(output), err
	}
	expect := func(label, want string, args ...string) {
		t.Helper()
		output, err := run(args...)
		if err != nil || !strings.Contains(output, want) {
			t.Fatalf("%s: %v\n%s", label, err, output)
		}
	}

	expect("user call", "ou_fake", "api", "GET", "/open-apis/authen/v1/user_info", "--as", "user")

	// The profile reads as a healthy login: the refresh token is a stand-in
	// too, so feishu-cli never tells the agent to log in again.
	statusOutput, err := run("auth", "status", "-o", "json")
	var status map[string]any
	if err != nil || json.Unmarshal([]byte(statusOutput[strings.Index(statusOutput, "{"):]), &status) != nil ||
		status["health"] != "healthy" || status["refresh_token_present"] != true || status["refresh_token_valid"] != true || status["note"] != nil {
		t.Fatalf("auth status: %v\n%s", err, statusOutput)
	}
	// A refresh round-trip: forced, then implicit on an expired access
	// token. The gateway answers with the session's stand-ins.
	tokenPath := filepath.Join(home, ".feishu-cli", "profiles", profile, "token.json")
	readToken := func() map[string]any {
		data, err := os.ReadFile(tokenPath)
		var token map[string]any
		if err != nil || json.Unmarshal(data, &token) != nil {
			t.Fatalf("token.json: %v %s", err, data)
		}
		return token
	}
	expect("auth refresh", `"status": "ok"`, "auth", "refresh", "-o", "json")
	if token := readToken(); token["access_token"] != f.material.Gateway.UserHandle || token["refresh_token"] != f.material.Gateway.RefreshHandle {
		t.Fatalf("token.json after refresh: %v", token)
	}
	expired := readToken()
	expired["expires_at"] = time.Now().Add(-time.Hour).Format(time.RFC3339)
	data, _ := json.Marshal(expired)
	if err := os.WriteFile(tokenPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	expect("user call after the access token expired", "ou_fake", "api", "GET", "/open-apis/authen/v1/user_info", "--as", "user")
	if at, err := time.Parse(time.RFC3339, readToken()["expires_at"].(string)); err != nil || !at.After(time.Now()) {
		t.Fatalf("the implicit refresh did not renew token.json: %v %v", at, err)
	}
	expect("bot call", "om_contract", "msg", "send", "--receive-id-type", "chat_id", "--receive-id", "oc_contract", "--text", "hello")

	big := make([]byte, 21<<20+123)
	for index := range big {
		big[index] = byte(index % 251)
	}
	upstream.blob = big
	if err := os.WriteFile(filepath.Join(scratch, "big.bin"), big, 0o600); err != nil {
		t.Fatal(err)
	}
	expect("chunked upload", "boxCONTRACT", "drive", "upload", "--file", filepath.Join(scratch, "big.bin"))
	if parts, bytes := upstream.uploaded(); parts < 2 || bytes != int64(len(big)) {
		t.Fatalf("upload reached Feishu as %d parts, %d bytes", parts, bytes)
	}
	downloaded := filepath.Join(scratch, "down.bin")
	if output, err := run("drive", "download", "--file-token", "boxCONTRACT", "--output", downloaded); err != nil {
		t.Fatalf("ranged download: %v\n%s", err, output)
	}
	if data, _ := os.ReadFile(downloaded); !bytes.Equal(data, big) {
		t.Fatalf("downloaded %d bytes differ from the file", len(data))
	}
	expect("event connection", "ev_contract", "event", "consume", "im.message.receive_v1", "--max-events", "1", "--timeout", "30s")
	if !events.acked() {
		t.Fatal("feishu-cli never acked the event")
	}

	// Documented limitation: the bot token from Feishu's accounts host does
	// not go through base_url; with a stand-in it fails closed.
	if output, err := run("auth", "token", "--as", "bot"); err == nil {
		t.Fatalf("auth token --as bot succeeded through a stand-in: %s", output)
	}

	// Feishu only ever saw real tokens, the right one per identity.
	calls := upstream.seen()
	identities := map[string]string{}
	for _, call := range calls {
		if call.Auth != "user" && call.Auth != "bot" {
			t.Fatalf("Feishu saw a call without a real token: %+v", call)
		}
		identities[call.Method+" "+call.Path] = call.Auth
	}
	// (user_info is answered by the fake's own route, which accepts only a
	// real user token.)
	if identities["POST /open-apis/im/v1/messages"] != "bot" ||
		identities["POST /open-apis/drive/v1/files/upload_part"] != "user" {
		t.Fatalf("identities per call: %v", identities)
	}
	worker.Stop()
	if _, err := os.Stat(filepath.Join(home, ".feishu-cli", "profiles", profile)); !os.IsNotExist(err) {
		t.Fatalf("the profile outlived the session's run: %v", err)
	}
}

type contractWorker struct {
	Env     map[string]string `json:"env"`
	Note    string            `json:"note"`
	command *exec.Cmd
	stdin   io.WriteCloser
}

func (w *contractWorker) Stop() {
	if w.stdin != nil {
		_ = w.stdin.Close()
		_ = w.command.Wait()
		w.stdin = nil
	}
}

const contractWorkerScript = `
const [forwarderModule, accountsModule] = process.argv.slice(2);
const input = JSON.parse(process.env.CONTRACT_INPUT);
const { startFeishuGatewayForwarder } = await import(forwarderModule);
const accounts = await import(accountsModule);
const held = await accounts.materializeSessionAccounts(input.session, [input.material], {
  home: input.home,
  manifestPath: input.manifest,
  forwarder: (path) => startFeishuGatewayForwarder({ serverURL: input.serverURL, gatewayPath: path, credential: () => input.credential }),
  feishuCliVersion: () => input.version,
  log: (message) => console.error(message),
});
console.log(JSON.stringify({ env: accounts.sessionExternalAccountEnvironment(input.session.id), note: accounts.sessionExternalAccountNote(input.session.id) }));
process.stdin.resume();
process.stdin.on("end", () => { held.release(); process.exit(0); });
`

// startContractWorker runs the worker's own profile writer and forwarder
// for the session, with its state and tools folders in scratch.
func startContractWorker(t *testing.T, node, dist, scratch string, input map[string]any) *contractWorker {
	t.Helper()
	script := filepath.Join(scratch, "contract-worker.mjs")
	if err := os.WriteFile(script, []byte(contractWorkerScript), 0o600); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(input)
	command := exec.Command(node, script, "file://"+filepath.Join(dist, "feishu-gateway-forwarder.js"), "file://"+filepath.Join(dist, "external-accounts.js"))
	command.Env = append(os.Environ(), "CONTRACT_INPUT="+string(encoded),
		"FOUNDRY_STATE_ROOT="+filepath.Join(scratch, "state"), "FOUNDRY_TOOLS_ROOT="+filepath.Join(scratch, "tools"))
	command.Stderr = os.Stderr
	stdin, _ := command.StdinPipe()
	stdout, _ := command.StdoutPipe()
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	worker := &contractWorker{command: command, stdin: stdin}
	t.Cleanup(worker.Stop)
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || json.Unmarshal([]byte(line), worker) != nil || worker.Env["FEISHU_PROFILE"] == "" {
		t.Fatalf("worker answered %q: %v", line, err)
	}
	return worker
}

// contractUpstream is the part of Feishu's open API the contract uses.
type contractUpstream struct {
	*fakeOpenAPI
	partsMu   sync.Mutex
	parts     int
	partBytes int64
}

func newContractUpstream(f *externalAccountsFixture) *contractUpstream {
	return &contractUpstream{fakeOpenAPI: &fakeOpenAPI{f: f}}
}

func (u *contractUpstream) uploaded() (int, int64) {
	u.partsMu.Lock()
	defer u.partsMu.Unlock()
	return u.parts, u.partBytes
}

func (u *contractUpstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	auth := "unknown"
	switch {
	case u.f.fake.AccessTokenValid(token):
		auth = "user"
	case u.f.fake.TenantTokenValid(token):
		auth = "bot"
	}
	u.mu.Lock()
	u.calls = append(u.calls, upstreamCall{Method: r.Method, Path: r.URL.Path, Auth: auth, Range: r.Header.Get("Range")})
	u.mu.Unlock()
	reply := func(status int, payload any) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(payload)
	}
	if auth == "unknown" {
		reply(http.StatusUnauthorized, map[string]any{"code": 99991663, "msg": "invalid access token"})
		return
	}
	path := r.URL.Path
	switch {
	case r.Method == http.MethodPost && path == "/open-apis/im/v1/messages":
		reply(http.StatusOK, map[string]any{"code": 0, "data": map[string]any{"message_id": "om_contract", "chat_id": "oc_contract", "msg_type": "text", "create_time": "1700000000000"}})
	case path == "/open-apis/drive/v1/files/upload_prepare":
		var input struct {
			Size float64 `json:"size"`
		}
		_ = json.NewDecoder(r.Body).Decode(&input)
		block := 4 << 20
		reply(http.StatusOK, map[string]any{"code": 0, "data": map[string]any{"upload_id": "up_contract", "block_size": block, "block_num": (int(input.Size) + block - 1) / block}})
	case path == "/open-apis/drive/v1/files/upload_part":
		_, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		reader := multipart.NewReader(r.Body, params["boundary"])
		for {
			part, err := reader.NextPart()
			if err != nil {
				break
			}
			if part.FormName() == "file" {
				n, _ := io.Copy(io.Discard, part)
				u.partsMu.Lock()
				u.parts++
				u.partBytes += n
				u.partsMu.Unlock()
			}
		}
		reply(http.StatusOK, map[string]any{"code": 0, "data": map[string]any{}})
	case path == "/open-apis/drive/v1/files/upload_finish":
		reply(http.StatusOK, map[string]any{"code": 0, "data": map[string]any{"file_token": "boxCONTRACT"}})
	case strings.HasPrefix(path, "/open-apis/drive/v1/files/") && strings.HasSuffix(path, "/download"):
		requested := r.Header.Get("Range")
		if requested == "" {
			reply(http.StatusBadRequest, map[string]any{"code": 234037, "msg": "file size exceeds limit, use range"})
			return
		}
		var start, end int
		_, _ = fmt.Sscanf(strings.TrimPrefix(requested, "bytes="), "%d-%d", &start, &end)
		end = min(end, len(u.blob)-1)
		w.Header().Set("Content-Range", "bytes "+strconv.Itoa(start)+"-"+strconv.Itoa(end)+"/"+strconv.Itoa(len(u.blob)))
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(end-start+1))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(u.blob[start : end+1])
	default:
		reply(http.StatusNotFound, map[string]any{"code": 404, "msg": "not in the contract fake"})
	}
}

// contractEvents stands in for the server's event router: it answers the
// endpoint call and pushes one event frame over the socket, the way
// Feishu's long connection does.
type contractEvents struct {
	t     *testing.T
	mu    sync.Mutex
	acks  int
	calls []feishugateway.Caller
}

func (e *contractEvents) acked() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.acks > 0
}

func (e *contractEvents) ServeEndpoint(w http.ResponseWriter, _ *http.Request, caller feishugateway.Caller, connectURL string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{
		"URL":          connectURL + "&device_id=" + caller.SessionID + "&service_id=7",
		"ClientConfig": map[string]any{"PingInterval": 120, "ReconnectCount": 1, "ReconnectInterval": 5, "ReconnectNonce": 1},
	}})
}

func (e *contractEvents) ServeConnection(w http.ResponseWriter, r *http.Request, caller feishugateway.Caller) {
	e.mu.Lock()
	e.calls = append(e.calls, caller)
	e.mu.Unlock()
	conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
	if err != nil {
		e.t.Logf("event socket upgrade: %v", err)
		return
	}
	defer conn.Close()
	payload := `{"schema":"2.0","header":{"event_id":"ev_contract","event_type":"im.message.receive_v1","create_time":"1700000000000","token":"","app_id":"` + caller.ClientID + `","tenant_key":"tk"},"event":{"sender":{"sender_id":{"open_id":"ou_sender"},"sender_type":"user"},"message":{"message_id":"om_in","chat_id":"oc_contract","chat_type":"group","message_type":"text","content":"{\"text\":\"hi\"}"}}}`
	headers := larkws.Headers{}
	headers.Add(larkws.HeaderType, string(larkws.MessageTypeEvent))
	headers.Add(larkws.HeaderMessageID, "msg_contract")
	headers.Add(larkws.HeaderSum, "1")
	headers.Add(larkws.HeaderSeq, "0")
	headers.Add(larkws.HeaderTraceID, "trace_contract")
	frame := larkws.Frame{SeqID: 1, LogID: 1, Service: 7, Method: int32(larkws.FrameTypeData), Headers: headers, Payload: []byte(payload)}
	encoded, _ := frame.Marshal()
	_ = conn.WriteMessage(websocket.BinaryMessage, encoded)
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var incoming larkws.Frame
		if incoming.Unmarshal(message) != nil {
			continue
		}
		kind := larkws.Headers(incoming.Headers).GetString(larkws.HeaderType)
		if incoming.Method == int32(larkws.FrameTypeControl) && kind == string(larkws.MessageTypePing) {
			pong := larkws.Headers{}
			pong.Add(larkws.HeaderType, string(larkws.MessageTypePong))
			reply := larkws.Frame{Method: int32(larkws.FrameTypeControl), Service: incoming.Service, Headers: pong}
			data, _ := reply.Marshal()
			_ = conn.WriteMessage(websocket.BinaryMessage, data)
			continue
		}
		if strings.Contains(string(incoming.Payload), `"code":200`) {
			e.mu.Lock()
			e.acks++
			e.mu.Unlock()
		}
	}
}
