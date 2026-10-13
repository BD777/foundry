package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishugateway"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// gatewayFixture: alice's account bound to her workspace, a session of hers
// on her device with its gateway material, the server on a real listener,
// and a fake Feishu open API behind the gateway that records what reached it.
type gatewayFixture struct {
	*externalAccountsFixture
	listener *httptest.Server
	app      store.ExternalProviderApp
	account  store.ExternalAccount
	session  store.AgentSession
	material store.ExternalAccountMaterial
	upstream *fakeOpenAPI
}

type upstreamCall struct {
	Method, Path, Auth, Range string
	Bytes                     int64
}

// fakeOpenAPI serves the open-API calls the tests send: it accepts only
// tokens the fake Feishu issued and records which kind each call carried.
type fakeOpenAPI struct {
	f     *externalAccountsFixture
	blob  []byte
	mu    sync.Mutex
	calls []upstreamCall
}

func (u *fakeOpenAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	auth := "unknown:" + token
	switch {
	case u.f.fake.AccessTokenValid(token):
		auth = "user"
	case u.f.fake.TenantTokenValid(token):
		auth = "bot"
	}
	call := upstreamCall{Method: r.Method, Path: r.URL.Path, Auth: auth, Range: r.Header.Get("Range")}
	defer func() {
		u.mu.Lock()
		u.calls = append(u.calls, call)
		u.mu.Unlock()
	}()
	if strings.HasPrefix(auth, "unknown") {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"code":99991663,"msg":"invalid token"}`)
		return
	}
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/open-apis/im/v1/messages":
		_, _ = io.WriteString(w, `{"code":0,"data":{"message_id":"om_1"}}`)
	case r.Method == http.MethodPost && r.URL.Path == "/open-apis/drive/v1/files/upload_part":
		reader, err := r.MultipartReader()
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		for {
			part, err := reader.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			n, _ := io.Copy(io.Discard, part)
			if part.FormName() == "file" {
				call.Bytes = n
			}
		}
		fmt.Fprintf(w, `{"code":0,"data":{"size":%d}}`, call.Bytes)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/open-apis/drive/v1/files/") && strings.HasSuffix(r.URL.Path, "/download"):
		http.ServeContent(w, r, "blob.bin", time.Time{}, bytes.NewReader(u.blob))
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"code":404,"msg":"no such fake api"}`)
	}
}

func (u *fakeOpenAPI) seen() []upstreamCall {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]upstreamCall(nil), u.calls...)
}

func newGatewayFixture(t *testing.T) *gatewayFixture {
	t.Helper()
	f := &gatewayFixture{externalAccountsFixture: newExternalAccountsFixture(t)}
	blob := make([]byte, 5<<20+77)
	for index := range blob {
		blob[index] = byte(index % 251)
	}
	f.upstream = &fakeOpenAPI{f: f.externalAccountsFixture, blob: blob}
	f.fake.API = f.upstream
	f.listener = httptest.NewServer(f.handler)
	t.Cleanup(f.listener.Close)
	f.app = f.createApp(f.alice, "")
	f.account = f.connect(f.alice, f.app)
	if err := f.db.SetWorkspaceExternalAccounts(context.Background(), "ws_alice", f.aliceID, []string{f.account.ID}); err != nil {
		t.Fatal(err)
	}
	f.session, f.material = f.startSession()
	return f
}

// startSession creates a session of alice's on her device and dispatches it.
func (f *gatewayFixture) startSession() (store.AgentSession, store.ExternalAccountMaterial) {
	f.t.Helper()
	ctx := context.Background()
	session, err := f.db.CreateAgentSession(ctx, store.CreateAgentSessionInput{
		CreatedByUserID: f.aliceID, WorkspaceID: "ws_alice", AgentID: "agent_alice", Provider: "claude", Prompt: "use feishu", Source: "chat",
	})
	if err != nil {
		f.t.Fatal(err)
	}
	alice, _ := f.server.store.GetUser(ctx, f.aliceID)
	materials := f.server.hub.sessionExternalAccounts(ctx, session, Actor{Kind: ActorDaemon, DeviceID: "dev_alice", Account: &alice}, true)
	if len(materials) != 1 || materials[0].Gateway == nil {
		f.t.Fatalf("no gateway material: %+v", materials)
	}
	return session, materials[0]
}

// gw sends a request to the gateway as the device holding credential.
func (f *gatewayFixture) gw(method, path, credential string, body io.Reader, headers map[string]string) (*http.Response, []byte) {
	f.t.Helper()
	request, err := http.NewRequest(method, f.listener.URL+feishugateway.PathPrefix+path, body)
	if err != nil {
		f.t.Fatal(err)
	}
	if credential != "" {
		request.Header.Set(deviceCredentialHeader, credential)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		f.t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return response, data
}

func (f *gatewayFixture) asUser(handle string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + handle}
}

// tenantHandle asks the gateway for the session's bot stand-in.
func (f *gatewayFixture) tenantHandle(material store.ExternalAccountMaterial) string {
	f.t.Helper()
	body := fmt.Sprintf(`{"app_id":%q,"app_secret":%q}`, material.ClientID, material.Gateway.AppHandle)
	response, data := f.gw(http.MethodPost, "/open-apis/auth/v3/tenant_access_token/internal", f.aliceDevice, strings.NewReader(body), map[string]string{"Content-Type": "application/json"})
	var answer struct {
		Code  int    `json:"code"`
		Token string `json:"tenant_access_token"`
	}
	_ = json.Unmarshal(data, &answer)
	if response.StatusCode != http.StatusOK || answer.Code != 0 || !strings.HasPrefix(answer.Token, "fst_") {
		f.t.Fatalf("tenant token: %d %s", response.StatusCode, data)
	}
	return answer.Token
}

func (f *gatewayFixture) audit(session string, query string) []store.FeishuGatewayRequest {
	f.t.Helper()
	var answer struct {
		Requests []store.FeishuGatewayRequest `json:"requests"`
	}
	f.call(session, http.MethodGet, "/api/feishu-gateway/requests"+query, "", http.StatusOK, "read audit", &answer)
	return answer.Requests
}

func TestFeishuGatewaySwapsHandlesForRealTokens(t *testing.T) {
	f := newGatewayFixture(t)
	user := f.material.Gateway.UserHandle

	// As the user: the real user token reaches Feishu.
	response, data := f.gw(http.MethodGet, "/open-apis/authen/v1/user_info", f.aliceDevice, nil, f.asUser(user))
	if response.StatusCode != http.StatusOK || !strings.Contains(string(data), "ou_fake") {
		t.Fatalf("user_info: %d %s", response.StatusCode, data)
	}

	// As the bot: the gateway answers the token call with a stand-in and
	// swaps it for the app's real tenant token, fetched once.
	tenant := f.tenantHandle(f.material)
	// Signing in read the app's names with a token of its own.
	issued := f.fake.TenantTokensIssued()
	for range 2 {
		response, data = f.gw(http.MethodPost, "/open-apis/im/v1/messages?receive_id_type=chat_id", f.aliceDevice, strings.NewReader(`{"receive_id":"oc_1","msg_type":"text","content":"{}"}`), f.asUser(tenant))
		if response.StatusCode != http.StatusOK || !strings.Contains(string(data), "om_1") {
			t.Fatalf("send as bot: %d %s", response.StatusCode, data)
		}
	}
	if fetched := f.fake.TenantTokensIssued() - issued; fetched != 1 {
		t.Fatalf("tenant tokens fetched: %d, want 1 (cached)", fetched)
	}
	for _, call := range f.upstream.seen() {
		if call.Auth != "user" && call.Auth != "bot" {
			t.Fatalf("Feishu saw something other than a real token: %+v", call)
		}
	}

	// A wrong app id, an unknown handle, the handle from another device or
	// without any device credential: refused.
	body := fmt.Sprintf(`{"app_id":"cli_other","app_secret":%q}`, f.material.Gateway.AppHandle)
	if _, data = f.gw(http.MethodPost, "/open-apis/auth/v3/tenant_access_token/internal", f.aliceDevice, strings.NewReader(body), nil); !strings.Contains(string(data), `"code":10003`) {
		t.Fatalf("tenant token for another app id: %s", data)
	}
	if response, _ = f.gw(http.MethodGet, "/open-apis/authen/v1/user_info", f.aliceDevice, nil, f.asUser("fsu_forged")); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("forged handle: %d", response.StatusCode)
	}
	if response, _ = f.gw(http.MethodGet, "/open-apis/authen/v1/user_info", f.bobDevice, nil, f.asUser(user)); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("alice's handle from bob's device: %d", response.StatusCode)
	}
	if response, _ = f.gw(http.MethodGet, "/open-apis/authen/v1/user_info", "", nil, f.asUser(user)); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("handle without a device credential: %d", response.StatusCode)
	}
	if response, _ = f.gw(http.MethodGet, "/open-apis/authen/v1/user_info", f.aliceDevice, nil, nil); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no handle: %d", response.StatusCode)
	}

	// The audit: one line per call, ids stripped, no bodies or queries;
	// alice reads her own, bob reads none of hers.
	lines := f.audit(f.alice, "?sessionId="+f.session.ID)
	byPath := map[string]store.FeishuGatewayRequest{}
	for _, line := range lines {
		byPath[line.Method+" "+line.Path+" "+line.Outcome] = line
		encoded, _ := json.Marshal(line)
		if strings.Contains(string(encoded), "oc_1") || strings.Contains(string(encoded), "receive_id") || strings.Contains(string(encoded), "fsu_") {
			t.Fatalf("audit line holds request content: %s", encoded)
		}
	}
	sent, ok := byPath["POST /open-apis/im/v1/messages forwarded"]
	if !ok || sent.Identity != "bot" || sent.Status != http.StatusOK || sent.BytesIn == 0 || sent.BytesOut == 0 || sent.AccountID != f.account.ID ||
		sent.UserID != f.aliceID || sent.DeviceID != "dev_alice" || sent.WorkspaceID != "ws_alice" || sent.AppID != f.app.ID {
		t.Fatalf("audit of the bot call: %+v (all: %+v)", sent, lines)
	}
	if line, ok := byPath["POST /open-apis/auth/v3/tenant_access_token/internal local"]; !ok || line.Status != http.StatusOK {
		t.Fatalf("audit of the tenant token call: %+v", lines)
	}
	if line, ok := byPath["GET /open-apis/authen/v1/user_info forwarded"]; !ok || line.Identity != "user" {
		t.Fatalf("audit of the user call: %+v", lines)
	}
	// Bob sees only what his own device tried, not alice's session.
	for _, line := range f.audit(f.bob, "") {
		if line.SessionID != "" || line.DeviceID != "dev_bob" || line.Outcome != "refused" {
			t.Fatalf("bob reads alice's audit: %+v", line)
		}
	}
	f.call(f.bob, http.MethodGet, "/api/feishu-gateway/requests?all=1", "", http.StatusForbidden, "a member reads everyone's audit", nil)
	if all := f.audit(f.alice, "?all=1"); len(all) < len(lines) {
		t.Fatalf("the admin's full audit: %d lines", len(all))
	}
}

func TestFeishuGatewayStreamsUploadsAndRangedDownloads(t *testing.T) {
	f := newGatewayFixture(t)
	user := f.material.Gateway.UserHandle

	// A multipart upload part passes through unbuffered and intact.
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("upload_id", "up_1")
	_ = writer.WriteField("seq", "0")
	part, _ := writer.CreateFormFile("file", "part.bin")
	_, _ = part.Write(f.upstream.blob[:4<<20])
	_ = writer.Close()
	size := int64(body.Len())
	headers := f.asUser(user)
	headers["Content-Type"] = writer.FormDataContentType()
	response, data := f.gw(http.MethodPost, "/open-apis/drive/v1/files/upload_part", f.aliceDevice, &body, headers)
	if response.StatusCode != http.StatusOK || !strings.Contains(string(data), fmt.Sprintf(`"size":%d`, 4<<20)) {
		t.Fatalf("upload part: %d %s", response.StatusCode, data)
	}

	// A ranged download: each range comes back as Feishu sent it.
	var assembled []byte
	total := len(f.upstream.blob)
	for start := 0; start < total; start += 2 << 20 {
		end := min(start+2<<20, total) - 1
		headers := f.asUser(user)
		headers["Range"] = fmt.Sprintf("bytes=%d-%d", start, end)
		response, data = f.gw(http.MethodGet, "/open-apis/drive/v1/files/boxcnFILE123/download", f.aliceDevice, nil, headers)
		if response.StatusCode != http.StatusPartialContent || len(data) != end-start+1 {
			t.Fatalf("range %d-%d: %d, %d bytes", start, end, response.StatusCode, len(data))
		}
		assembled = append(assembled, data...)
	}
	if !bytes.Equal(assembled, f.upstream.blob) {
		t.Fatal("the downloaded ranges differ from the file")
	}
	var ranged int
	for _, call := range f.upstream.seen() {
		if call.Range != "" && call.Auth == "user" {
			ranged++
		}
	}
	if ranged != 3 {
		t.Fatalf("Feishu saw %d ranged calls, want 3", ranged)
	}
	lines := f.audit(f.alice, "?sessionId="+f.session.ID)
	var upload, download *store.FeishuGatewayRequest
	for index := range lines {
		switch lines[index].Path {
		case "/open-apis/drive/v1/files/upload_part":
			upload = &lines[index]
		case "/open-apis/drive/v1/files/:id/download":
			download = &lines[index]
		}
	}
	if upload == nil || upload.BytesIn != size || download == nil || download.Status != http.StatusPartialContent || download.BytesOut == 0 {
		t.Fatalf("audit of transfers: upload %+v download %+v", upload, download)
	}
}

func TestFeishuGatewayAccessEndsImmediately(t *testing.T) {
	f := newGatewayFixture(t)
	ctx := context.Background()
	userInfo := func(material store.ExternalAccountMaterial) int {
		response, _ := f.gw(http.MethodGet, "/open-apis/authen/v1/user_info", f.aliceDevice, nil, f.asUser(material.Gateway.UserHandle))
		return response.StatusCode
	}
	if status := userInfo(f.material); status != http.StatusOK {
		t.Fatalf("live session: %d", status)
	}
	// The session ends: its handles stop at once.
	if _, err := f.db.CompleteAgentSession(ctx, f.session.ID, "done", "native_1"); err != nil {
		t.Fatal(err)
	}
	if status := userInfo(f.material); status != http.StatusUnauthorized {
		t.Fatalf("after the session ended: %d", status)
	}
	if response, _ := f.gw(http.MethodPost, "/open-apis/auth/v3/tenant_access_token/internal", f.aliceDevice,
		strings.NewReader(fmt.Sprintf(`{"app_id":"cli_fake","app_secret":%q}`, f.material.Gateway.AppHandle)), nil); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("tenant token after the session ended: %d", response.StatusCode)
	}

	// Unbinding the account from the workspace stops a running session;
	// binding it again restores it.
	_, material := f.startSession()
	if status := userInfo(material); status != http.StatusOK {
		t.Fatalf("second session: %d", status)
	}
	if err := f.db.SetWorkspaceExternalAccounts(ctx, "ws_alice", f.aliceID, nil); err != nil {
		t.Fatal(err)
	}
	if status := userInfo(material); status != http.StatusUnauthorized {
		t.Fatalf("after unbinding: %d", status)
	}
	if err := f.db.SetWorkspaceExternalAccounts(ctx, "ws_alice", f.aliceID, []string{f.account.ID}); err != nil {
		t.Fatal(err)
	}
	tenant := f.tenantHandle(material)
	// Stop using now: user and bot calls stop at once.
	f.call(f.alice, http.MethodPost, "/api/external-accounts/"+f.account.ID+"/revoke", "{}", http.StatusOK, "revoke", nil)
	if status := userInfo(material); status != http.StatusUnauthorized {
		t.Fatalf("after stop using now: %d", status)
	}
	if response, _ := f.gw(http.MethodPost, "/open-apis/im/v1/messages", f.aliceDevice, strings.NewReader(`{}`), f.asUser(tenant)); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bot call after stop using now: %d", response.StatusCode)
	}
	// Removing the account keeps them refused.
	f.call(f.alice, http.MethodDelete, "/api/external-accounts/"+f.account.ID, "", http.StatusOK, "disconnect", nil)
	if status := userInfo(material); status != http.StatusUnauthorized {
		t.Fatalf("after removing the account: %d", status)
	}
}

func TestFeishuGatewayRefusesBlockedAndLocalOnlyCalls(t *testing.T) {
	f := newGatewayFixture(t)
	user := f.material.Gateway.UserHandle
	before := len(f.upstream.seen())
	for _, blocked := range []struct{ method, path string }{
		{http.MethodPatch, "/open-apis/application/v6/applications/cli_fake/management"},
		{http.MethodPost, "/open-apis/application/v6/scopes/apply"},
		{http.MethodPost, "/open-apis/admin/v1/password/reset"},
		{http.MethodPost, "/open-apis/passport/v1/sessions/logout"},
		{http.MethodGet, "/open-apis/security_and_compliance/v1/openapi_logs/list_data"},
		{http.MethodPost, "/open-apis/auth/v3/app_access_token/internal"},
		{http.MethodPost, "/open-apis/authen/v1/oidc/refresh_access_token"},
	} {
		response, data := f.gw(blocked.method, blocked.path, f.aliceDevice, strings.NewReader(`{}`), f.asUser(user))
		if response.StatusCode != http.StatusForbidden || !strings.Contains(string(data), "not available to sessions") {
			t.Fatalf("%s %s: %d %s", blocked.method, blocked.path, response.StatusCode, data)
		}
	}
	if seen := f.upstream.seen(); len(seen) != before {
		t.Fatalf("blocked calls reached Feishu: %+v", seen[before:])
	}
	// Reading the app's own information is not blocked.
	if response, _ := f.gw(http.MethodGet, "/open-apis/application/v6/applications/cli_fake", f.aliceDevice, nil, f.asUser(user)); response.StatusCode == http.StatusForbidden {
		t.Fatal("reading the app was blocked")
	}
	// The device cannot log in through the token endpoint, register or revoke.
	response, data := f.gw(http.MethodPost, "/open-apis/authen/v2/oauth/token", f.aliceDevice, strings.NewReader("grant_type=authorization_code&code=c"), map[string]string{"Content-Type": "application/x-www-form-urlencoded"})
	if response.StatusCode != http.StatusBadRequest || !strings.Contains(string(data), "invalid_grant") {
		t.Fatalf("a login through the gateway: %d %s", response.StatusCode, data)
	}
	for _, path := range []string{"/oauth/v1/device_authorization", "/oauth/v1/app/registration", "/oauth/v3/token"} {
		if response, _ := f.gw(http.MethodPost, path, f.aliceDevice, strings.NewReader(""), nil); response.StatusCode != http.StatusNotFound {
			t.Fatalf("%s: %d", path, response.StatusCode)
		}
	}
	lines := f.audit(f.alice, "")
	blocked := 0
	for _, line := range lines {
		if line.Outcome == "blocked" {
			blocked++
		}
	}
	if blocked != 7 {
		t.Fatalf("audited blocked calls: %d (%+v)", blocked, lines)
	}
}

func TestFeishuGatewayHonoursIntegrationsSwitchAndRateLimits(t *testing.T) {
	f := newGatewayFixture(t)
	user := f.material.Gateway.UserHandle
	f.server.feishuGateway.Integrations = integrations.New(false)
	response, data := f.gw(http.MethodGet, "/open-apis/authen/v1/user_info", f.aliceDevice, nil, f.asUser(user))
	if response.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(data), integrations.Env) {
		t.Fatalf("integrations off: %d %s", response.StatusCode, data)
	}
	if len(f.upstream.seen()) != 0 {
		t.Fatal("a call reached Feishu with integrations off")
	}
	f.server.feishuGateway.Integrations = nil
	f.server.feishuGateway.SetRates(feishugateway.Rate{PerSecond: 0.01, Burst: 2}, feishugateway.Rate{PerSecond: 100, Burst: 100})
	statuses := []int{}
	for range 3 {
		response, _ = f.gw(http.MethodGet, "/open-apis/authen/v1/user_info", f.aliceDevice, nil, f.asUser(user))
		statuses = append(statuses, response.StatusCode)
	}
	if statuses[0] != 200 || statuses[1] != 200 || statuses[2] != http.StatusTooManyRequests || response.Header.Get("x-ogw-ratelimit-reset") == "" {
		t.Fatalf("rate limit: %v %v", statuses, response.Header)
	}
}

type stubEvents struct {
	mu        sync.Mutex
	endpoints []string
	callers   []feishugateway.Caller
}

func (s *stubEvents) ServeEndpoint(w http.ResponseWriter, _ *http.Request, caller feishugateway.Caller, connectURL string) {
	s.mu.Lock()
	s.endpoints = append(s.endpoints, connectURL)
	s.mu.Unlock()
	_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"URL": connectURL + "&device_id=" + caller.SessionID + "&service_id=1"}})
}

func (s *stubEvents) ServeConnection(w http.ResponseWriter, _ *http.Request, caller feishugateway.Caller) {
	s.mu.Lock()
	s.callers = append(s.callers, caller)
	s.mu.Unlock()
	_, _ = io.WriteString(w, "socket for "+caller.SessionID)
}

func TestFeishuGatewayDelegatesEventConnections(t *testing.T) {
	f := newGatewayFixture(t)
	endpoint := func(headers map[string]string) (*http.Response, []byte) {
		body := fmt.Sprintf(`{"AppID":"cli_fake","AppSecret":%q}`, f.material.Gateway.AppHandle)
		return f.gw(http.MethodPost, "/callback/ws/endpoint", f.aliceDevice, strings.NewReader(body), headers)
	}
	forwarder := map[string]string{feishugateway.ForwarderHostHeader: "127.0.0.1:43210"}
	f.server.feishuGateway.Events = nil
	if response, data := endpoint(forwarder); response.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(data), "not available") {
		t.Fatalf("events without subscriptions: %d %s", response.StatusCode, data)
	}
	events := &stubEvents{}
	f.server.feishuGateway.Events = events
	if response, _ := endpoint(map[string]string{feishugateway.ForwarderHostHeader: "evil.example:80"}); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("a non-loopback forwarder host: %d", response.StatusCode)
	}
	response, data := endpoint(forwarder)
	var answer struct {
		Data struct {
			URL string `json:"URL"`
		} `json:"data"`
	}
	_ = json.Unmarshal(data, &answer)
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(answer.Data.URL, "ws://127.0.0.1:43210/foundry/event-socket?foundry_ticket=") {
		t.Fatalf("endpoint: %d %s", response.StatusCode, data)
	}
	socketPath := strings.TrimPrefix(answer.Data.URL, "ws://127.0.0.1:43210")
	response, data = f.gw(http.MethodGet, socketPath, f.aliceDevice, nil, nil)
	if response.StatusCode != http.StatusOK || string(data) != "socket for "+f.session.ID {
		t.Fatalf("socket: %d %s", response.StatusCode, data)
	}
	if len(events.callers) != 1 || events.callers[0].AccountID != f.account.ID || events.callers[0].ClientID != "cli_fake" || events.callers[0].UserID != f.aliceID {
		t.Fatalf("callers: %+v", events.callers)
	}
	if err := f.server.feishuGateway.Authorized(context.Background(), events.callers[0]); err != nil {
		t.Fatalf("live caller: %v", err)
	}
	// A ticket is spent once.
	if response, _ = f.gw(http.MethodGet, socketPath, f.aliceDevice, nil, nil); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("ticket reused: %d", response.StatusCode)
	}
	// From another device, or after the session ended: refused.
	_, data = endpoint(forwarder)
	_ = json.Unmarshal(data, &answer)
	socketPath = strings.TrimPrefix(answer.Data.URL, "ws://127.0.0.1:43210")
	if response, _ = f.gw(http.MethodGet, socketPath, f.bobDevice, nil, nil); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("socket from bob's device: %d", response.StatusCode)
	}
	if _, err := f.db.CompleteAgentSession(context.Background(), f.session.ID, "done", "native_1"); err != nil {
		t.Fatal(err)
	}
	if err := f.server.feishuGateway.Authorized(context.Background(), events.callers[0]); err == nil {
		t.Fatal("a caller whose session ended is still authorized")
	}
}

func TestExternalAppSecretReplacement(t *testing.T) {
	f := newExternalAccountsFixture(t)
	app := f.createApp(f.alice, "")
	if app.RotateSecret {
		t.Fatal("an app created after the gateway is asked to rotate")
	}
	f.call(f.bob, http.MethodPut, "/api/external-apps/"+app.ID+"/secret", `{"clientSecret":"secret_fake"}`, http.StatusNotFound, "bob replaces alice's secret", nil)
	f.call(f.alice, http.MethodPut, "/api/external-apps/"+app.ID+"/secret", `{"clientSecret":"wrong"}`, http.StatusBadRequest, "a secret Feishu refuses", nil)
	var saved store.ExternalProviderApp
	f.call(f.alice, http.MethodPut, "/api/external-apps/"+app.ID+"/secret", `{"clientSecret":"secret_fake"}`, http.StatusOK, "replace the secret", &saved)
	if !saved.HasSecret || saved.RotateSecret {
		t.Fatalf("replaced app: %+v", saved)
	}
}

// feishu-cli refreshes its user token (POST /open-apis/authen/v2/oauth/token,
// a form with grant_type, refresh_token, client_id, client_secret) when
// token.json says it expired: the gateway answers with the session's
// stand-ins, never a real token, and refuses once the session ends.
func TestFeishuGatewayAnswersUserRefreshWithStandIns(t *testing.T) {
	f := newGatewayFixture(t)
	gateway := f.material.Gateway
	if !strings.HasPrefix(gateway.RefreshHandle, "fsr_") {
		t.Fatalf("no refresh stand-in: %+v", gateway)
	}
	refresh := func(refreshToken, clientID string) (*http.Response, map[string]any) {
		form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refreshToken}, "client_id": {clientID}, "client_secret": {gateway.AppHandle}}
		response, data := f.gw(http.MethodPost, "/open-apis/authen/v2/oauth/token", f.aliceDevice, strings.NewReader(form.Encode()), map[string]string{"Content-Type": "application/x-www-form-urlencoded"})
		var answer map[string]any
		_ = json.Unmarshal(data, &answer)
		return response, answer
	}
	before := len(f.upstream.seen())
	response, answer := refresh(gateway.RefreshHandle, f.material.ClientID)
	if response.StatusCode != http.StatusOK || answer["access_token"] != gateway.UserHandle || answer["refresh_token"] != gateway.RefreshHandle ||
		answer["token_type"] != "Bearer" || answer["expires_in"].(float64) <= 0 {
		t.Fatalf("refresh: %d %v", response.StatusCode, answer)
	}
	if len(f.upstream.seen()) != before {
		t.Fatal("the refresh reached Feishu")
	}
	// The refreshed stand-in still works.
	if response, _ := f.gw(http.MethodGet, "/open-apis/authen/v1/user_info", f.aliceDevice, nil, f.asUser(answer["access_token"].(string))); response.StatusCode != http.StatusOK {
		t.Fatalf("call with the refreshed stand-in: %d", response.StatusCode)
	}
	// A refresh stand-in is not a bearer token.
	if response, _ := f.gw(http.MethodGet, "/open-apis/authen/v1/user_info", f.aliceDevice, nil, f.asUser(gateway.RefreshHandle)); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("refresh handle as bearer: %d", response.StatusCode)
	}
	for _, wrong := range []struct{ token, client string }{{gateway.UserHandle, f.material.ClientID}, {gateway.RefreshHandle, "cli_other"}} {
		if response, answer := refresh(wrong.token, wrong.client); response.StatusCode != http.StatusBadRequest || answer["error"] != "invalid_grant" {
			t.Fatalf("wrong refresh %v: %d %v", wrong, response.StatusCode, answer)
		}
	}
	// Another device cannot refresh the session's login.
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {gateway.RefreshHandle}, "client_id": {f.material.ClientID}, "client_secret": {gateway.AppHandle}}
	if response, _ := f.gw(http.MethodPost, "/open-apis/authen/v2/oauth/token", f.bobDevice, strings.NewReader(form.Encode()), map[string]string{"Content-Type": "application/x-www-form-urlencoded"}); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("refresh from another device: %d", response.StatusCode)
	}
	if _, err := f.db.CompleteAgentSession(context.Background(), f.session.ID, "done", "native_1"); err != nil {
		t.Fatal(err)
	}
	if response, answer := refresh(gateway.RefreshHandle, f.material.ClientID); response.StatusCode != http.StatusBadRequest || answer["error"] != "invalid_grant" ||
		!strings.Contains(answer["error_description"].(string), "has ended") {
		t.Fatalf("refresh after the session ended: %d %v", response.StatusCode, answer)
	}
}
