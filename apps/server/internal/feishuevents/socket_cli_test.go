package feishuevents

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishugateway"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/gorilla/websocket"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
)

// feishuCLI is the real feishu-cli binary Foundry installs on devices;
// FOUNDRY_TEST_FEISHU_CLI names another.
func feishuCLI(t *testing.T) string {
	t.Helper()
	path := os.Getenv("FOUNDRY_TEST_FEISHU_CLI")
	if path == "" {
		home, _ := os.UserHomeDir()
		path = filepath.Join(home, ".foundry-tools", "bin", "feishu-cli")
	}
	if _, err := os.Stat(path); err != nil {
		t.Skipf("no feishu-cli binary at %s (set FOUNDRY_TEST_FEISHU_CLI)", path)
	}
	return path
}

// testGateway stands in for the Feishu gateway's two event routes the way
// feishugateway.Gateway drives EventSubscriptions: it resolves the handle
// feishu-cli sends as its app secret to a caller, issues a one-use ticket
// in the connect URL, and hands the socket over for the ticket's caller.
func testGateway(t *testing.T, events feishugateway.EventSubscriptions, handles map[string]feishugateway.Caller) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	tickets := map[string]feishugateway.Caller{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /gw"+larkws.GenEndpointUri, func(w http.ResponseWriter, r *http.Request) {
		var request larkws.BootstrapRequest
		_ = json.NewDecoder(r.Body).Decode(&request)
		caller, ok := handles[request.AppSecret]
		if !ok || request.AppID != caller.ClientID {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(larkws.EndpointResp{Code: 514, Msg: "unknown session credential"})
			return
		}
		ticket := newID("ticket_")
		mu.Lock()
		tickets[ticket] = caller
		mu.Unlock()
		events.ServeEndpoint(w, r, caller, "ws://"+r.Host+"/gw/foundry/event-socket?foundry_ticket="+ticket)
	})
	mux.HandleFunc("GET /gw/foundry/event-socket", func(w http.ResponseWriter, r *http.Request) {
		ticket := r.URL.Query().Get("foundry_ticket")
		mu.Lock()
		caller, ok := tickets[ticket]
		delete(tickets, ticket)
		mu.Unlock()
		if !ok {
			http.Error(w, "unknown ticket", http.StatusUnauthorized)
			return
		}
		events.ServeConnection(w, r, caller)
	})
	gateway := httptest.NewServer(mux)
	t.Cleanup(gateway.Close)
	return gateway
}

var aliceCaller = feishugateway.Caller{SessionID: "sess_alice", WorkspaceID: "ws_alice", UserID: "u_alice", AppID: "xapp_shared", ClientID: testApp}

// feishuCLIEnv isolates feishu-cli from the person's config and makes any
// attempt to reach the real Feishu fail (proxies point at a closed port).
func feishuCLIEnv(t *testing.T, baseURL, secret string) []string {
	t.Helper()
	dir := t.TempDir()
	return []string{
		"HOME=" + filepath.Join(dir, "home"), "FEISHU_CLI_CONFIG_DIR=" + filepath.Join(dir, "config"),
		"PATH=/usr/bin:/bin", "FEISHU_CLI_REMOTE_META=off",
		"HTTPS_PROXY=http://127.0.0.1:9", "HTTP_PROXY=http://127.0.0.1:9", "NO_PROXY=127.0.0.1,localhost",
		"FEISHU_APP_ID=" + testApp, "FEISHU_APP_SECRET=" + secret, "FEISHU_BASE_URL=" + baseURL,
	}
}

// lockedBuffer is a buffer two goroutines may use.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// The unchanged `feishu-cli event consume` receives the server's events
// through the emulated socket, holding only the gateway's handle: it sees
// the type it asked for, and the real Feishu is never dialled.
func TestFeishuCLIConsumesEventsThroughTheServer(t *testing.T) {
	binary := feishuCLI(t)
	fake := newFake(t)
	hub := newTestHub(t, fake, testSecret)
	gateway := testGateway(t, GatewayEvents{Hub: hub}, map[string]feishugateway.Caller{"fsg_alice": aliceCaller})

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binary, "event", "consume", "im.message.receive_v1", "--max-events", "2", "--timeout", "45s")
	command.Env = feishuCLIEnv(t, gateway.URL+"/gw", "fsg_alice")
	var stdout bytes.Buffer
	command.Stdout = &stdout
	stderr := &lockedBuffer{}
	readyRead, readyWrite := io.Pipe()
	command.Stderr = io.MultiWriter(stderr, readyWrite)
	// stdin EOF makes feishu-cli exit: keep it open.
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	ready := make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(readyRead)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), "[event] ready") {
				close(ready)
				break
			}
		}
		_, _ = io.Copy(io.Discard, readyRead)
	}()
	select {
	case <-ready:
	case <-time.After(30 * time.Second):
		t.Fatalf("feishu-cli never got ready: %s", stderr.String())
	}
	if !fake.WaitOpen(1, 5*time.Second) || fake.Accepted() != 1 {
		t.Fatalf("the server's connection: %d accepted, %d open", fake.Accepted(), fake.Open())
	}
	for _, payload := range [][]byte{
		MessagePayload(testApp, "ev_cli_1", "oc_1", "om_1", "", "first", true),
		EventPayload(testApp, "ev_cli_other", "im.chat.updated_v1", map[string]any{"chat_id": "oc_1"}),
		MessagePayload(testApp, "ev_cli_2", "oc_1", "om_2", "om_1", "second", false),
	} {
		if _, err := fake.Push(payload, 1); err != nil {
			t.Fatal(err)
		}
	}
	if err := command.Wait(); err != nil {
		t.Fatalf("feishu-cli: %v\nstderr: %s", err, stderr.String())
	}
	_ = readyWrite.Close()
	var got []string
	for _, line := range strings.Split(strings.TrimSpace(stdout.String()), "\n") {
		var event struct {
			Header struct {
				EventID string `json:"event_id"`
			} `json:"header"`
		}
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("not an NDJSON event line: %q", line)
		}
		got = append(got, event.Header.EventID)
	}
	// The SDK in feishu-cli handles each frame in its own goroutine, so
	// it may print them in either order.
	slices.Sort(got)
	if strings.Join(got, ",") != "ev_cli_1,ev_cli_2" {
		t.Fatalf("feishu-cli printed %v, want the two messages\nstderr: %s", got, stderr.String())
	}
	// Only the server ever asked Feishu for an endpoint.
	if fake.EndpointRequests() != 1 {
		t.Fatalf("feishu was asked for %d endpoints, want only the server's one", fake.EndpointRequests())
	}
	// Its socket subscription ended with it.
	deadline := time.Now().Add(5 * time.Second)
	for hub.subscriptionCount(alice) != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := hub.subscriptionCount(alice); n != 0 {
		t.Fatalf("%d subscriptions left after feishu-cli exited", n)
	}
}

// A handle the gateway does not know is refused, and with integrations
// off the endpoint says why; feishu-cli reports either and stops.
func TestFeishuCLIIsRefusedWithoutAccess(t *testing.T) {
	binary := feishuCLI(t)
	fake := newFake(t)
	hub := newTestHub(t, fake, testSecret)
	hub.Integrations = integrations.New(false)
	gateway := testGateway(t, GatewayEvents{Hub: hub}, map[string]feishugateway.Caller{"fsg_alice": aliceCaller})
	for secret, want := range map[string]string{
		"fsg_unknown": "unknown session credential",
		"fsg_alice":   "integrations are off",
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		command := exec.CommandContext(ctx, binary, "event", "consume", "im.message.receive_v1", "--max-events", "1", "--timeout", "20s")
		command.Env = feishuCLIEnv(t, gateway.URL+"/gw", secret)
		stdin, _ := command.StdinPipe()
		output, err := command.CombinedOutput()
		_ = stdin.Close()
		cancel()
		if err == nil || !strings.Contains(string(output), want) {
			t.Fatalf("%s: exit %v, output %s; want a refusal saying %q", secret, err, output, want)
		}
	}
	if fake.EndpointRequests() != 0 {
		t.Fatal("a refused client made the server connect to feishu")
	}
}

// A socket whose caller lost access (session ended, account stopped)
// closes at the next recheck, and its subscription ends with it.
func TestAnEventSocketClosesWhenAccessEnds(t *testing.T) {
	fake := newFake(t)
	hub := newTestHub(t, fake, testSecret)
	var allowed sync.Mutex
	ended := false
	events := GatewayEvents{Hub: hub, RecheckEvery: 20 * time.Millisecond, Recheck: func(context.Context, feishugateway.Caller) error {
		allowed.Lock()
		defer allowed.Unlock()
		if ended {
			return errors.New("the session ended")
		}
		return nil
	}}
	gateway := testGateway(t, events, map[string]feishugateway.Caller{"fsg_alice": aliceCaller})
	body, _ := json.Marshal(larkws.BootstrapRequest{AppID: testApp, AppSecret: "fsg_alice"})
	response, err := http.Post(gateway.URL+"/gw"+larkws.GenEndpointUri, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var answer larkws.EndpointResp
	_ = json.NewDecoder(response.Body).Decode(&answer)
	_ = response.Body.Close()
	if answer.Code != 0 || answer.Data == nil || !strings.Contains(answer.Data.Url, "&device_id=sess_alice&service_id=1") {
		t.Fatalf("endpoint = %+v", answer)
	}
	socket, _, err := websocket.DefaultDialer.Dial(answer.Data.Url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	if !fake.WaitOpen(1, 5*time.Second) {
		t.Fatal("the socket did not open the app's connection")
	}
	if _, err := fake.Push(MessagePayload(testApp, "ev_s1", "oc_1", "om_1", "", "hi", false), 1); err != nil {
		t.Fatal(err)
	}
	_ = socket.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, raw, err := socket.ReadMessage()
	var frame larkws.Frame
	if err != nil || frame.Unmarshal(raw) != nil || !strings.Contains(string(frame.Payload), "ev_s1") {
		t.Fatalf("socket read %v: %s", err, frame.Payload)
	}
	allowed.Lock()
	ended = true
	allowed.Unlock()
	for {
		if _, _, err := socket.ReadMessage(); err != nil {
			break
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for hub.subscriptionCount(alice) != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if hub.subscriptionCount(alice) != 0 || !fake.WaitOpen(0, 5*time.Second) {
		t.Fatal("the socket's subscription and the app's connection outlived the caller's access")
	}
}
