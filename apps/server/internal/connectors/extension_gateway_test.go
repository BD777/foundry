package connectors

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

type extensionUpstreamCall struct {
	Method        string
	Path          string
	Authorization string
	Account       string
	Body          string
}

type extensionPermissionStore struct {
	*cfGatewayStore
	workspaceID string
	agent       store.PersonalAgent
	pkg         store.PermissionPackage
}

func (s *extensionPermissionStore) GetWorkspace(context.Context, string) (store.WorkspaceProjection, error) {
	return store.WorkspaceProjection{ID: s.workspaceID, Kind: store.WorkspaceKindPersonalAgent}, nil
}

func (s *extensionPermissionStore) AssistantForWorkspace(context.Context, string) (store.PersonalAgent, error) {
	return s.agent, nil
}

func (s *extensionPermissionStore) AssistantForSession(context.Context, string) (store.PersonalAgent, error) {
	return s.agent, nil
}

func (s *extensionPermissionStore) GetPermissionPackage(context.Context, string, string) (store.PermissionPackage, error) {
	return s.pkg, nil
}

func (s *extensionPermissionStore) SavePermissionPackage(_ context.Context, pkg store.PermissionPackage) (store.PermissionPackage, error) {
	s.pkg = pkg
	return pkg, nil
}

type extensionRecordingConfirmer struct {
	decision gateway.ConfirmationDecision
	requests []gateway.ConfirmationRequest
}

func (c *extensionRecordingConfirmer) Review(_ context.Context, request gateway.ConfirmationRequest) (gateway.ConfirmationDecision, *gateway.Denial) {
	c.requests = append(c.requests, request)
	return c.decision, nil
}

func TestExtensionGatewayInjectsFieldsAndEnforcesRouteDirectory(t *testing.T) {
	ctx := context.Background()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(t.TempDir(), "db"), sqlitestore.Options{SecretKeyPath: filepath.Join(t.TempDir(), "key")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	var (
		mu    sync.Mutex
		calls []extensionUpstreamCall
	)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		scope := "read"
		if r.Header.Get("Authorization") == "Bearer fixture-secret" {
			scope = "full"
		}
		mu.Lock()
		calls = append(calls, extensionUpstreamCall{
			Method: r.Method, Path: r.URL.Path,
			Authorization: r.Header.Get("Authorization"), Account: r.Header.Get("X-Account"), Body: string(body),
		})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/capabilities":
			_, _ = w.Write([]byte(`{"version":"2026.1","token":{"scope":"` + scope + `"}}`))
		case "/api/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"42","name":"Ada"}]}`))
		case "/api/routes":
			_, _ = w.Write([]byte(`{"version":"2026.1","routes":[
				{"method":"POST","path":"/api/search","access":"read","domain":"search"},
				{"method":"GET","path":"/api/admin","access":"write","domain":"admin"}
			]}`))
		default:
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	t.Cleanup(upstream.Close)

	descriptor := acmeExtensionDescriptor()
	service := externalaccounts.NewService(st, st, externalaccounts.NewRegistry())
	service.Extensions = externalaccounts.NewExtensionTestClient(upstream.Client())
	instance, err := service.CreateExtensionInstance(ctx, "alice", descriptor, store.ConnectorServerHeldInstanceInput{
		Label:  "Acme production",
		Fields: map[string]string{"baseUrl": upstream.URL, "readToken": "fixture-secret", "account": "42"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if instance.RouteCount != 2 || instance.Version != "2026.1" ||
		instance.Access != store.ConnectorServerHeldInstanceAccess("write") ||
		strings.Contains(instance.Values["readToken"], "fixture-secret") {
		t.Fatalf("instance = %+v", instance)
	}
	readInstance, err := service.CreateExtensionInstance(ctx, "alice", descriptor, store.ConnectorServerHeldInstanceInput{
		Label:  "Acme read production",
		Fields: map[string]string{"baseUrl": upstream.URL, "readToken": "fixture-read-secret", "account": "42"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if readInstance.Access != store.ConnectorServerHeldInstanceAccess("read") {
		t.Fatalf("read instance = %+v", readInstance)
	}
	if err := st.SetWorkspaceExternalAccounts(ctx, "workspace-a", "alice", []string{instance.AccountID, readInstance.AccountID}); err != nil {
		t.Fatal(err)
	}
	session := store.AgentSession{ID: "session-alice", DeviceID: "device-alice", WorkspaceID: "workspace-a", CreatedByUserID: "alice", Status: "running"}
	fake := &cfGatewayStore{Store: st, session: session}
	extensionGateway := NewExtensionGateway(fake, service, func(context.Context, string, string) (store.ConnectorDescriptor, error) {
		return descriptor, nil
	})
	account, err := st.GetExternalAccount(ctx, instance.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := extensionGateway.IssueHandles(ctx, externalaccounts.HandleRequest{
		SessionID: session.ID, DeviceID: session.DeviceID, WorkspaceID: session.WorkspaceID, UserID: "alice", Account: account,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(handle.UserHandle, extensionHandlePrefix) {
		t.Fatalf("handle = %q", handle.UserHandle)
	}

	read := serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodPost, "/api/search", []byte(`{"q":"x"}`))
	if read.Code != http.StatusOK {
		t.Fatalf("read: %d %s", read.Code, read.Body.String())
	}
	mu.Lock()
	call := calls[len(calls)-1]
	mu.Unlock()
	if call.Authorization != "Bearer fixture-secret" || call.Account != "42" || call.Body != `{"q":"x"}` {
		t.Fatalf("upstream call = %+v", call)
	}

	write := serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodGet, "/api/admin", nil)
	if write.Code != http.StatusOK {
		t.Fatalf("full-token write route: %d %s", write.Code, write.Body.String())
	}
	readAccount, err := st.GetExternalAccount(ctx, readInstance.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	readHandle, err := extensionGateway.IssueHandles(ctx, externalaccounts.HandleRequest{
		SessionID: session.ID, DeviceID: session.DeviceID, WorkspaceID: session.WorkspaceID, UserID: "alice", Account: readAccount,
	})
	if err != nil {
		t.Fatal(err)
	}
	readWrite := serveExtensionGateway(t, extensionGateway, "acme-api", readHandle.UserHandle, http.MethodGet, "/api/admin", nil)
	if readWrite.Code != http.StatusForbidden || !strings.Contains(readWrite.Body.String(), "access_level") {
		t.Fatalf("read-token write route: %d %s", readWrite.Code, readWrite.Body.String())
	}
	unknown := serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodGet, "/api/not-listed", nil)
	if unknown.Code != http.StatusForbidden || !strings.Contains(unknown.Body.String(), "path_not_allowed") {
		t.Fatalf("unknown route: %d %s", unknown.Code, unknown.Body.String())
	}

	for _, accountID := range []string{instance.AccountID, readInstance.AccountID} {
		events, err := st.ListExternalAccountEvents(ctx, accountID, 20)
		if err != nil {
			t.Fatal(err)
		}
		for _, event := range events {
			if strings.Contains(event.Detail, "fixture-secret") ||
				strings.Contains(event.Detail, "fixture-read-secret") ||
				strings.Contains(event.Detail, handle.UserHandle) ||
				strings.Contains(event.Detail, readHandle.UserHandle) {
				t.Fatalf("audit leaked a credential: %s", event.Detail)
			}
			if strings.Contains(event.Detail, `"write":true`) && !strings.Contains(event.Detail, `"route":"/api/admin"`) {
				t.Fatalf("write audit did not identify its route: %s", event.Detail)
			}
		}
	}
}

func TestExtensionAssistantWritesRequireWritePermissionAndConfirmation(t *testing.T) {
	ctx := context.Background()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(t.TempDir(), "db"), sqlitestore.Options{SecretKeyPath: filepath.Join(t.TempDir(), "key")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	var writes int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/capabilities":
			_, _ = w.Write([]byte(`{"token":{"scope":"full"}}`))
		case "/api/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"42","name":"Ada"}]}`))
		case "/api/routes":
			_, _ = w.Write([]byte(`{"routes":[{"method":"POST","path":"/api/admin","access":"write"}]}`))
		case "/api/admin":
			writes++
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)

	descriptor := acmeExtensionDescriptor()
	service := externalaccounts.NewService(st, st, externalaccounts.NewRegistry())
	service.Extensions = externalaccounts.NewExtensionTestClient(upstream.Client())
	instance, err := service.CreateExtensionInstance(ctx, "alice", descriptor, store.ConnectorServerHeldInstanceInput{
		Label:  "Acme assistant",
		Fields: map[string]string{"baseUrl": upstream.URL, "readToken": "fixture-full", "account": "42"},
	})
	if err != nil {
		t.Fatal(err)
	}
	fake := &cfGatewayStore{Store: st, session: store.AgentSession{
		ID: "session-assistant", DeviceID: "device-alice", WorkspaceID: "workspace-pa",
		CreatedByUserID: "alice", Status: "running", Role: store.AgentSessionRolePersonalAgent,
		Source: store.SessionSourceChat,
	}}
	pkg := permission.DefaultPackage("alice", "pkg-assistant")
	pkg.ConnectorAccounts = []store.ConnectorAccountPermission{{AccountID: instance.AccountID, Level: store.ConnectorAccessLevelWrite}}
	permissionStore := &extensionPermissionStore{
		cfGatewayStore: fake, workspaceID: "workspace-pa",
		agent: store.PersonalAgent{UserID: "alice", WorkspaceID: "workspace-pa", HomeDeviceID: "device-alice", PermissionPackageID: pkg.ID},
		pkg:   pkg,
	}
	confirmer := &extensionRecordingConfirmer{decision: gateway.ConfirmationDecision{
		ProposalID: "proposal-1", Summary: "Write through Acme",
	}}
	extensionGateway := NewExtensionGateway(permissionStore, service, func(context.Context, string, string) (store.ConnectorDescriptor, error) {
		return descriptor, nil
	})
	extensionGateway.UsePermission(permissionStore, confirmer)
	account, err := st.GetExternalAccount(ctx, instance.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := extensionGateway.IssueHandles(ctx, externalaccounts.HandleRequest{
		SessionID: fake.session.ID, DeviceID: fake.session.DeviceID, WorkspaceID: fake.session.WorkspaceID,
		UserID: "alice", Account: account,
	})
	if err != nil {
		t.Fatal(err)
	}

	pending := serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodPost, "/api/admin", []byte(`{"change":true}`))
	if pending.Code != http.StatusForbidden || !strings.Contains(pending.Body.String(), "needs_confirmation") ||
		len(confirmer.requests) != 1 || !confirmer.requests[0].Need.Write ||
		confirmer.requests[0].Need.Risk != "extension_write" || writes != 0 {
		t.Fatalf("pending write = %d %s, confirmations %+v, upstream writes %d", pending.Code, pending.Body.String(), confirmer.requests, writes)
	}

	pkg.ConnectorAccounts[0].Level = store.ConnectorAccessLevelRead
	permissionStore.pkg = pkg
	readOnly := serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodPost, "/api/admin", []byte(`{"change":true}`))
	if readOnly.Code != http.StatusForbidden || !strings.Contains(readOnly.Body.String(), "connector_read_only") ||
		len(confirmer.requests) != 1 || writes != 0 {
		t.Fatalf("read-only write = %d %s, confirmations %+v, upstream writes %d", readOnly.Code, readOnly.Body.String(), confirmer.requests, writes)
	}

	pkg.ConnectorAccounts[0].Level = store.ConnectorAccessLevelWrite
	permissionStore.pkg = pkg
	confirmer.decision = gateway.ConfirmationDecision{Approved: true, ProposalID: "proposal-1", Summary: "Write through Acme"}
	approved := serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodPost, "/api/admin", []byte(`{"change":true}`))
	if approved.Code != http.StatusOK || len(confirmer.requests) != 2 || writes != 1 {
		t.Fatalf("approved write = %d %s, confirmations %+v, upstream writes %d", approved.Code, approved.Body.String(), confirmer.requests, writes)
	}
	events, err := st.ListExternalAccountEvents(ctx, instance.AccountID, 20)
	if err != nil {
		t.Fatal(err)
	}
	var auditedWrites int
	for _, event := range events {
		if strings.Contains(event.Detail, `"write":true`) && strings.Contains(event.Detail, `"route":"/api/admin"`) {
			auditedWrites++
		}
	}
	if auditedWrites != 3 {
		t.Fatalf("audited writes = %d, events = %+v", auditedWrites, events)
	}
}

func serveExtensionGateway(t *testing.T, extensionGateway *ExtensionGateway, kind, handle, method, path string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	return serveExtensionGatewayOn(t, extensionGateway, "device-alice", kind, handle, method, path, body)
}

func serveExtensionGatewayOn(t *testing.T, extensionGateway *ExtensionGateway, deviceID, kind, handle, method, path string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, ExtensionGatewayPath(kind)+path, bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+handle)
	recorder := httptest.NewRecorder()
	extensionGateway.Serve(recorder, request, gateway.Device{ID: deviceID, OwnerUserID: "alice"}, kind)
	return recorder
}

func TestExtensionSessionEnvironmentContainsNoRealSecret(t *testing.T) {
	ctx := context.Background()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(t.TempDir(), "db"), sqlitestore.Options{SecretKeyPath: filepath.Join(t.TempDir(), "key")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/capabilities":
			scope := "read"
			if r.Header.Get("Authorization") == "Bearer full-secret" {
				scope = "full"
			}
			_, _ = w.Write([]byte(`{"token":{"scope":"` + scope + `"}}`))
		case "/api/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"42","name":"Ada"}]}`))
		case "/api/routes":
			_, _ = w.Write([]byte(`{"version":"1","routes":[{"method":"GET","path":"/api/read","access":"read"}]}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(upstream.Close)
	service := externalaccounts.NewService(st, st, externalaccounts.NewRegistry())
	service.Extensions = externalaccounts.NewExtensionTestClient(upstream.Client())
	descriptor := acmeExtensionDescriptor()
	for _, test := range []struct {
		token       string
		readOnly    string
		accessLevel store.ConnectorServerHeldInstanceAccess
	}{
		{token: "read-secret", readOnly: "1", accessLevel: "read"},
		{token: "full-secret", readOnly: "0", accessLevel: "write"},
	} {
		instance, err := service.CreateExtensionInstance(ctx, "alice", descriptor, store.ConnectorServerHeldInstanceInput{
			Label: "Acme " + test.readOnly, Fields: map[string]string{"baseUrl": upstream.URL, "readToken": test.token, "account": "42"},
		})
		if err != nil {
			t.Fatal(err)
		}
		if instance.Access != test.accessLevel {
			t.Fatalf("instance access = %q, want %q", instance.Access, test.accessLevel)
		}
		app, err := st.GetExternalProviderApp(ctx, instance.ID)
		if err != nil {
			t.Fatal(err)
		}
		data, err := service.ExtensionData(ctx, app)
		if err != nil {
			t.Fatal(err)
		}
		env, err := service.ExtensionSessionEnvironment(ctx, app, data)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(env)
		if strings.Contains(string(raw), test.token) {
			t.Fatalf("session environment leaked the sealed field: %s", raw)
		}
		if env["ACME_BASE"] != "{gatewayBase}" || env["ACME_TOKEN"] != "{standIn}" ||
			env["ACME_ACCOUNT"] != "42" || env["ACME_READ_ONLY"] != test.readOnly {
			t.Fatalf("environment = %#v", env)
		}
	}
}

func TestDeviceNetworkGatewayForwardsThroughTheSessionDeviceWithoutAuditSecrets(t *testing.T) {
	ctx := context.Background()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(t.TempDir(), "db"), sqlitestore.Options{SecretKeyPath: filepath.Join(t.TempDir(), "key")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"42","name":"Ada"}]}`))
		case "/api/routes":
			_, _ = w.Write([]byte(`{"routes":[{"method":"GET","path":"/api/read","access":"read"}]}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(upstream.Close)
	service := externalaccounts.NewService(st, st, externalaccounts.NewRegistry())
	service.Extensions = externalaccounts.NewExtensionTestClient(upstream.Client())
	descriptor := acmeExtensionDescriptor()
	instance, err := service.CreateExtensionInstance(ctx, "alice", descriptor, store.ConnectorServerHeldInstanceInput{
		Label: "Acme intranet", Fields: map[string]string{
			"baseUrl": upstream.URL, "readToken": "device-only-secret", "account": "42",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	app, err := st.GetExternalProviderApp(ctx, instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	data, err := service.ExtensionData(ctx, app)
	if err != nil {
		t.Fatal(err)
	}
	data.Network = externalaccounts.ExtensionNetworkDevice
	data.ProbeDeviceID = "device-alice"
	checkedAt := time.Now().UTC().Format(time.RFC3339)
	data.AvailableDevices = []store.ConnectorServerHeldDeviceCheck{
		{DeviceID: "device-alice", Name: "alice-mac", Status: "ok", CheckedAt: checkedAt},
		{DeviceID: "device-bob", Name: "alice-linux", Status: "ok", CheckedAt: checkedAt},
		{DeviceID: "device-other", Name: "alice-nas", Status: "unreachable", CheckedAt: checkedAt, Detail: "no answer within 10 seconds"},
	}
	raw, _ := json.Marshal(data)
	if _, err := st.SaveExternalProviderAppExtensionData(ctx, app.ID, string(raw)); err != nil {
		t.Fatal(err)
	}
	var forwarded externalaccounts.ExtensionDeviceHTTPRequest
	var forwardedVia string
	service.ExtensionDeviceRequest = func(_ context.Context, deviceID string, request externalaccounts.ExtensionDeviceHTTPRequest) (externalaccounts.ExtensionDeviceHTTPResponse, error) {
		forwardedVia = deviceID
		forwarded = request
		return externalaccounts.ExtensionDeviceHTTPResponse{
			Status: http.StatusOK, Headers: http.Header{"Content-Type": {"application/json"}},
			Body: []byte(`{"ok":true}`),
		}, nil
	}
	if err := st.SetWorkspaceExternalAccounts(ctx, "workspace-a", "alice", []string{instance.AccountID}); err != nil {
		t.Fatal(err)
	}
	session := store.AgentSession{ID: "session-alice", DeviceID: "device-alice", WorkspaceID: "workspace-a", CreatedByUserID: "alice", Status: "running"}
	fake := &cfGatewayStore{Store: st, session: session, aliceDevices: map[string]bool{"device-bob": true, "device-other": true, "device-new": true}}
	extensionGateway := NewExtensionGateway(fake, service, func(context.Context, string, string) (store.ConnectorDescriptor, error) {
		return descriptor, nil
	})
	account, err := st.GetExternalAccount(ctx, instance.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := extensionGateway.IssueHandles(ctx, externalaccounts.HandleRequest{
		SessionID: session.ID, DeviceID: session.DeviceID, WorkspaceID: session.WorkspaceID, UserID: "alice", Account: account,
	})
	if err != nil {
		t.Fatal(err)
	}
	response := serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodGet, "/api/read", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("gateway: %d %s", response.Code, response.Body.String())
	}
	if forwardedVia != "device-alice" {
		t.Fatalf("request left through %q, want the session's device", forwardedVia)
	}
	if forwarded.Headers["Authorization"] != "Bearer device-only-secret" {
		t.Fatalf("forwarded headers = %#v", forwarded.Headers)
	}
	events, err := st.ListExternalAccountEvents(ctx, instance.AccountID, 20)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if strings.Contains(event.Detail, "device-only-secret") || strings.Contains(event.Detail, handle.UserHandle) {
			t.Fatalf("audit leaked a credential: %s", event.Detail)
		}
	}

	otherSession := session
	otherSession.ID = "session-other-device"
	otherSession.DeviceID = "device-other"
	fake.session = otherSession
	if _, err := extensionGateway.IssueHandles(ctx, externalaccounts.HandleRequest{
		SessionID: otherSession.ID, DeviceID: otherSession.DeviceID, WorkspaceID: otherSession.WorkspaceID,
		UserID: "alice", Account: account,
	}); !errors.Is(err, ErrExtensionAccess) {
		t.Fatalf("unreachable device error = %v", err)
	}

	bobSession := session
	bobSession.ID = "session-bob-device"
	bobSession.DeviceID = "device-bob"
	fake.session = bobSession
	bobHandle, err := extensionGateway.IssueHandles(ctx, externalaccounts.HandleRequest{
		SessionID: bobSession.ID, DeviceID: bobSession.DeviceID, WorkspaceID: bobSession.WorkspaceID,
		UserID: "alice", Account: account,
	})
	if err != nil {
		t.Fatalf("another reachable device: %v", err)
	}
	forwardedVia = ""
	if response := serveExtensionGatewayOn(t, extensionGateway, "device-bob", "acme-api", bobHandle.UserHandle, http.MethodGet, "/api/read", nil); response.Code != http.StatusOK {
		t.Fatalf("gateway on bob: %d %s", response.Code, response.Body.String())
	}
	if forwardedVia != "device-bob" {
		t.Fatalf("request left through %q, want the session's device-bob", forwardedVia)
	}

	service.ExtensionDevices = func(context.Context, string, string) ([]externalaccounts.ExtensionDeviceCandidate, error) {
		return []externalaccounts.ExtensionDeviceCandidate{
			{ID: "device-alice", Name: "alice-mac", Online: true, Installed: true},
			{ID: "device-new", Name: "alice-new", Online: true, Installed: true},
		}, nil
	}
	if err := service.ProbeExtensionOnNewDevice(ctx, "alice", "device-new"); err != nil {
		t.Fatal(err)
	}
	app, err = st.GetExternalProviderApp(ctx, instance.ID)
	if err != nil {
		t.Fatal(err)
	}
	if data, err = service.ExtensionData(ctx, app); err != nil {
		t.Fatal(err)
	}
	recorded := map[string]string{}
	for _, check := range data.AvailableDevices {
		recorded[check.DeviceID] = check.Status
	}
	if len(recorded) != 4 || recorded["device-new"] != externalaccounts.ExtensionDeviceNotApplicable || recorded["device-bob"] != "ok" {
		t.Fatalf("devices after the new one came online = %v", recorded)
	}

	unknownSession := session
	unknownSession.ID = "session-unprobed-device"
	unknownSession.DeviceID = "device-new"
	fake.session = unknownSession
	if _, err := extensionGateway.IssueHandles(ctx, externalaccounts.HandleRequest{
		SessionID: unknownSession.ID, DeviceID: unknownSession.DeviceID, WorkspaceID: unknownSession.WorkspaceID,
		UserID: "alice", Account: account,
	}); !errors.Is(err, ErrExtensionAccess) {
		t.Fatalf("device never probed error = %v", err)
	}
}
