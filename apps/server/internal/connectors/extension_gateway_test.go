package connectors

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

	// DEV-215 (the OpenLark incidents): the session's turn completes while
	// its agent goes on (a background loop, the turn it starts on the
	// loop's notification) and nothing claims that work. The handle still
	// works and renews, minutes or days later, after a failed turn too.
	for _, status := range []string{"completed", "failed", "canceled"} {
		fake.session.Status, fake.session.CompletedAt = status, time.Now().Add(-26*time.Hour).UTC().Format(time.RFC3339Nano)
		if response := serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodPost, "/api/search", []byte(`{"q":"later"}`)); response.Code != http.StatusOK {
			t.Fatalf("%s session's call: %d %s", status, response.Code, response.Body.String())
		}
		if _, err := extensionGateway.IssueHandles(ctx, externalaccounts.HandleRequest{
			SessionID: session.ID, DeviceID: session.DeviceID, WorkspaceID: session.WorkspaceID, UserID: "alice", Account: account,
		}); err != nil {
			t.Fatalf("%s session cannot renew its handle: %v", status, err)
		}
	}
	// The grant itself ends: unbound from the workspace. Refused at once,
	// and the refusal is audited for the session and account it names.
	if err := st.SetWorkspaceExternalAccounts(ctx, "workspace-a", "alice", []string{readInstance.AccountID}); err != nil {
		t.Fatal(err)
	}
	unbound := serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodPost, "/api/search", []byte(`{}`))
	if unbound.Code != http.StatusUnauthorized || !strings.Contains(unbound.Body.String(), "FOUNDRY_ACCESS_ENDED") {
		t.Fatalf("unbound: %d %s", unbound.Code, unbound.Body.String())
	}
	refusals, err := st.ListExternalAccountEvents(ctx, instance.AccountID, 1)
	if err != nil || len(refusals) != 1 || refusals[0].SessionID != session.ID ||
		!strings.Contains(refusals[0].Detail, `"outcome":"refused"`) || !strings.Contains(refusals[0].Detail, "access_ended") ||
		!strings.Contains(refusals[0].Detail, `"kind":"acme-api"`) {
		t.Fatalf("the refusal's audit: %+v %v", refusals, err)
	}
	if err := st.SetWorkspaceExternalAccounts(ctx, "workspace-a", "alice", []string{instance.AccountID, readInstance.AccountID}); err != nil {
		t.Fatal(err)
	}
	// Archived: refused, and no handle is issued any more.
	fake.session.ArchivedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if response := serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodPost, "/api/search", []byte(`{}`)); response.Code != http.StatusUnauthorized {
		t.Fatalf("archived: %d %s", response.Code, response.Body.String())
	}
	if _, err := extensionGateway.IssueHandles(ctx, externalaccounts.HandleRequest{
		SessionID: session.ID, DeviceID: session.DeviceID, WorkspaceID: session.WorkspaceID, UserID: "alice", Account: account,
	}); err == nil {
		t.Fatal("an archived session renewed its handle")
	}
	fake.session.ArchivedAt, fake.session.Status = "", "running"

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

// OpenLark's agent API catalogues its write routes under /agent/v1 and its
// replies and sends answer with the created message id at the top level (the
// bodies are the ones open-lark's own route tests record). A descriptor that
// declares those routes records the created id before the response returns,
// so a message channel can drop the echo of the assistant's own reply.
func TestExtensionGatewayRecordsOpenLarkCreatedMessages(t *testing.T) {
	ctx := context.Background()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(t.TempDir(), "db"), sqlitestore.Options{SecretKeyPath: filepath.Join(t.TempDir(), "key")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	recorded := map[string]string{
		"/agent/v1/messages/om_message/replies":    `{"feedId":"oc_chat","messageId":"om_reply","replyToMessageId":"om_message","threadRootMessageId":"om_root"}`,
		"/agent/v1/conversations/oc_chat/messages": `{"messageId":"om_sent"}`,
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/agent/v1/capabilities":
			_, _ = w.Write([]byte(`{"version":"0.3.0","token":{"scope":"full"}}`))
		case "/agent/v1/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"42","name":"Ada"}],"activeId":"42"}`))
		case "/agent/v1":
			_, _ = w.Write([]byte(`{"routes":[
				{"method":"GET","path":"/agent/v1/capabilities","access":"read","domain":"im"},
				{"method":"POST","path":"/agent/v1/messages/:messageId/replies","access":"write","domain":"im"},
				{"method":"POST","path":"/agent/v1/conversations/:feedId/messages","access":"write","domain":"im"}
			]}`))
		default:
			if body, ok := recorded[r.URL.Path]; ok && r.Method == http.MethodPost {
				w.WriteHeader(http.StatusAccepted)
				_, _ = w.Write([]byte(body))
				return
			}
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(upstream.Close)
	descriptor := acmeExtensionDescriptor()
	descriptor.ServerHeld.Probe[0].Path = "/agent/v1/capabilities"
	descriptor.ServerHeld.Probe[1].Path = "/agent/v1/accounts"
	descriptor.ServerHeld.Probe[2] = store.ConnectorServerHeldProbe{
		ID: "routes", Method: "GET", Path: "/agent/v1",
		Extract: store.ConnectorServerHeldProbeExtract{
			Routes: store.ConnectorServerHeldRoutesExtract{
				Items: "/routes", Method: "/method", Path: "/path", Access: "/access", Domain: "/domain",
			},
		},
	}
	descriptor.ServerHeld.Upstream.PathPrefix = "/agent/v1"
	descriptor.ServerHeld.Writes = []store.ConnectorServerHeldWrite{
		{Method: "POST", Path: "/agent/v1/messages/:messageId/replies", CreatedMessageID: "/messageId"},
		{Method: "POST", Path: "/agent/v1/conversations/:feedId/messages", CreatedMessageID: "/messageId"},
	}
	service := externalaccounts.NewService(st, st, externalaccounts.NewRegistry())
	service.Extensions = externalaccounts.NewExtensionTestClient(upstream.Client())
	instance, err := service.CreateExtensionInstance(ctx, "alice", descriptor, store.ConnectorServerHeldInstanceInput{
		Label:  "OpenLark production",
		Fields: map[string]string{"baseUrl": upstream.URL, "readToken": "fixture-secret", "account": "42"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetWorkspaceExternalAccounts(ctx, "workspace-a", "alice", []string{instance.AccountID}); err != nil {
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
	response := serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodPost, "/agent/v1/messages/om_message/replies", []byte(`{"text":"hi"}`))
	if response.Code != http.StatusAccepted || response.Body.String() != recorded["/agent/v1/messages/om_message/replies"] {
		t.Fatalf("reply: %d %s", response.Code, response.Body.String())
	}
	response = serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodPost, "/agent/v1/conversations/oc_chat/messages", []byte(`{"text":"hi"}`))
	if response.Code != http.StatusAccepted || response.Body.String() != recorded["/agent/v1/conversations/oc_chat/messages"] {
		t.Fatalf("send: %d %s", response.Code, response.Body.String())
	}
	events, err := st.ListExternalAccountEvents(ctx, account.ID, 20)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, event := range events {
		if event.Kind != ExtensionWriteCreatedMessage || event.SessionID != session.ID {
			continue
		}
		var detail struct {
			MessageID string `json:"messageId"`
			Route     string `json:"route"`
		}
		if err := json.Unmarshal([]byte(event.Detail), &detail); err != nil {
			t.Fatalf("event detail: %s (%v)", event.Detail, err)
		}
		got[detail.MessageID] = detail.Route
	}
	if got["om_reply"] != "/agent/v1/messages/:messageId/replies" || got["om_sent"] != "/agent/v1/conversations/:feedId/messages" {
		t.Fatalf("created messages not recorded: %+v (events %+v)", got, events)
	}
}

// A write route whose descriptor names the created message id records it
// before the response returns, so a message channel can drop its own echo.
func TestExtensionGatewayRecordsTheMessageAWriteCreates(t *testing.T) {
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
			_, _ = w.Write([]byte(`{"token":{"scope":"full"}}`))
		case "/api/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"42","name":"Ada"}]}`))
		case "/api/routes":
			_, _ = w.Write([]byte(`{"version":"1","routes":[
				{"method":"GET","path":"/api/read","access":"read","domain":"im"},
				{"method":"POST","path":"/api/send","access":"write","domain":"im"}
			]}`))
		case "/api/send":
			if r.Method != http.MethodPost {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			_, _ = w.Write([]byte(`{"messageId":"om_created","feedId":"oc_1"}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(upstream.Close)
	descriptor := acmeExtensionDescriptor()
	descriptor.ServerHeld.Writes = []store.ConnectorServerHeldWrite{
		{Method: "POST", Path: "/api/send", CreatedMessageID: "/messageId"},
	}
	service := externalaccounts.NewService(st, st, externalaccounts.NewRegistry())
	service.Extensions = externalaccounts.NewExtensionTestClient(upstream.Client())
	instance, err := service.CreateExtensionInstance(ctx, "alice", descriptor, store.ConnectorServerHeldInstanceInput{
		Label:  "Acme production",
		Fields: map[string]string{"baseUrl": upstream.URL, "readToken": "fixture-secret", "account": "42"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetWorkspaceExternalAccounts(ctx, "workspace-a", "alice", []string{instance.AccountID}); err != nil {
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
	response := serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodPost, "/api/send", []byte(`{"text":"hi"}`))
	if response.Code != http.StatusOK {
		t.Fatalf("send: %d %s", response.Code, response.Body.String())
	}
	events, err := st.ListExternalAccountEvents(ctx, account.ID, 20)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range events {
		if event.Kind != ExtensionWriteCreatedMessage || event.SessionID != session.ID {
			continue
		}
		var detail struct {
			MessageID string `json:"messageId"`
			Method    string `json:"method"`
			Route     string `json:"route"`
		}
		if err := json.Unmarshal([]byte(event.Detail), &detail); err != nil {
			t.Fatalf("event detail: %s (%v)", event.Detail, err)
		}
		if detail.MessageID == "om_created" && detail.Method == http.MethodPost && detail.Route == "/api/send" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the created message was not recorded: %+v", events)
	}
}

func TestExtensionAppendFooter(t *testing.T) {
	plain := store.ConnectorServerHeldWriteFooter{
		Text: "/text", Markdown: true,
		Format: &store.ConnectorServerHeldWriteFooterFormat{
			Field: "/editorType", Value: "markdown", Plain: []string{"simple"},
			Escape: store.ConnectorServerHeldWriteFooterFormatEscapeMarkdown,
		},
	}
	body := []byte(`{"clientId":"c1","text":"hi"}`)
	once, changed := extensionAppendFooter(body, plain, "> 来自AI")
	if !changed {
		t.Fatal("the footer is appended")
	}
	if got := footerDocument(t, once); got["editorType"] != "markdown" || got["text"] != "hi\n\n> 来自AI" {
		t.Fatalf("plain write: %+v", got)
	}
	if _, again := extensionAppendFooter(once, plain, "> 来自AI"); again {
		t.Fatal("the footer is idempotent")
	}

	// Already markdown: the body is appended to as it is.
	markdown := []byte(`{"editorType":"markdown","text":"a*b"}`)
	once, changed = extensionAppendFooter(markdown, plain, "> 来自AI")
	if !changed {
		t.Fatal("a markdown write gets the footer")
	}
	if got := footerDocument(t, once); got["editorType"] != "markdown" || got["text"] != "a*b\n\n> 来自AI" {
		t.Fatalf("markdown write: %+v", got)
	}

	// A declared plain value is literal, so it is escaped and switched.
	simple := []byte(`{"editorType":"simple","text":"a_b"}`)
	once, changed = extensionAppendFooter(simple, plain, "> 来自AI")
	if !changed {
		t.Fatal("a simple write gets the footer")
	}
	if got := footerDocument(t, once); got["editorType"] != "markdown" || got["text"] != `a\_b`+"\n\n> 来自AI" {
		t.Fatalf("simple write: %+v", got)
	}

	// A structured format the declaration does not name keeps its text.
	rich := []byte(`{"editorType":"rich","text":"a*b"}`)
	once, changed = extensionAppendFooter(rich, plain, "> 来自AI")
	if !changed {
		t.Fatal("a rich write gets the footer")
	}
	if got := footerDocument(t, once); got["editorType"] != "rich" || got["text"] != "a*b\n\n> 来自AI" {
		t.Fatalf("rich write: %+v", got)
	}

	// A declaration without a format keeps the old behaviour.
	legacy := store.ConnectorServerHeldWriteFooter{Text: "/text", Markdown: true}
	once, changed = extensionAppendFooter(body, legacy, "> 来自AI")
	if !changed {
		t.Fatal("a legacy declaration appends the footer")
	}
	got := footerDocument(t, once)
	if got["text"] != "hi\n\n> 来自AI" {
		t.Fatalf("legacy write: %+v", got)
	}
	if _, ok := got["editorType"]; ok {
		t.Fatalf("a legacy declaration switches no format: %+v", got)
	}

	nested := []byte(`{"body":{"text":"hi"}}`)
	once, changed = extensionAppendFooter(nested, store.ConnectorServerHeldWriteFooter{Text: "/body/text"}, "> 来自AI")
	if !changed || !strings.Contains(string(once), `"text":"hi\n\n> 来自AI"`) {
		t.Fatalf("nested pointer: %s", once)
	}
	if _, changed := extensionAppendFooter([]byte(`{"clientId":"c1"}`), plain, "> 来自AI"); changed {
		t.Fatal("a body without the text field is left alone")
	}
	if _, changed := extensionAppendFooter(body, store.ConnectorServerHeldWriteFooter{Text: "/body/text"}, "> 来自AI"); changed {
		t.Fatal("a pointer the body cannot reach is left alone")
	}
}

func footerDocument(t *testing.T, payload []byte) map[string]any {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		t.Fatalf("body: %s (%v)", payload, err)
	}
	return document
}

func TestExtensionEscapeMarkdown(t *testing.T) {
	cases := []struct{ in, want string }{
		{"现在是北京时间 2026-11-16（周一）11:07。", "现在是北京时间 2026-11-16（周一）11:07。"},
		{"*bold* _x_ `code` ~gone~", "\\*bold\\* \\_x\\_ \\`code\\` \\~gone\\~"},
		{"[a](b) | c |", "\\[a\\](b) \\| c \\|"},
		{"# heading", "\\# heading"},
		{"> quote", "\\> quote"},
		{"- item", "\\- item"},
		{"+ item", "\\+ item"},
		{"1. one", "1\\. one"},
		{"2) two", "2\\) two"},
		{"---", "\\---"},
		{"===", "\\==="},
		{"https://example.test/a_b", "https\\://example.test/a\\_b"},
		{"a@b.c", "a\\@b.c"},
		{"<b> &amp;", "&lt;b> &amp;amp;"},
		{"  indented", "  indented"},
		{"a\nb", "a\nb"},
		{"a\r\nb", "a\nb"},
	}
	for _, c := range cases {
		if got := extensionEscapeMarkdown(c.in); got != c.want {
			t.Errorf("%q: got %q, want %q", c.in, got, c.want)
		}
	}
}

// A write whose descriptor marks it as a message gets the channel's footer at
// its declared text field, but only for a session the channel names; another
// write route or an empty footer is forwarded unchanged.
func TestExtensionGatewayAppendsTheChannelsFooter(t *testing.T) {
	ctx := context.Background()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(t.TempDir(), "db"), sqlitestore.Options{SecretKeyPath: filepath.Join(t.TempDir(), "key")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	var sent []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/capabilities":
			_, _ = w.Write([]byte(`{"token":{"scope":"full"}}`))
		case "/api/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"42","name":"Ada"}]}`))
		case "/api/routes":
			_, _ = w.Write([]byte(`{"version":"1","routes":[
				{"method":"GET","path":"/api/read","access":"read","domain":"im"},
				{"method":"POST","path":"/api/send","access":"write","domain":"im"},
				{"method":"POST","path":"/api/publish","access":"write","domain":"docs"}
			]}`))
		default:
			raw, _ := io.ReadAll(r.Body)
			sent = append(sent, r.URL.Path+" "+string(raw))
			_, _ = fmt.Fprintf(w, `{"messageId":"om_%d"}`, len(sent))
		}
	}))
	t.Cleanup(upstream.Close)
	descriptor := acmeExtensionDescriptor()
	footer := &store.ConnectorServerHeldWriteFooter{
		Text: "/text", Markdown: true,
		Format: &store.ConnectorServerHeldWriteFooterFormat{
			Field: "/editorType", Value: "markdown", Plain: []string{"simple"},
			Escape: store.ConnectorServerHeldWriteFooterFormatEscapeMarkdown,
		},
	}
	descriptor.ServerHeld.Writes = []store.ConnectorServerHeldWrite{
		{Method: "POST", Path: "/api/send", CreatedMessageID: "/messageId", Footer: footer},
		{Method: "POST", Path: "/api/publish", CreatedMessageID: "/messageId"},
	}
	service := externalaccounts.NewService(st, st, externalaccounts.NewRegistry())
	service.Extensions = externalaccounts.NewExtensionTestClient(upstream.Client())
	instance, err := service.CreateExtensionInstance(ctx, "alice", descriptor, store.ConnectorServerHeldInstanceInput{
		Label:  "Acme production",
		Fields: map[string]string{"baseUrl": upstream.URL, "readToken": "fixture-secret", "account": "42"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetWorkspaceExternalAccounts(ctx, "workspace-a", "alice", []string{instance.AccountID}); err != nil {
		t.Fatal(err)
	}
	session := store.AgentSession{ID: "session-alice", DeviceID: "device-alice", WorkspaceID: "workspace-a", CreatedByUserID: "alice", Status: "running"}
	fake := &cfGatewayStore{Store: st, session: session}
	extensionGateway := NewExtensionGateway(fake, service, func(context.Context, string, string) (store.ConnectorDescriptor, error) {
		return descriptor, nil
	})
	extensionGateway.UseWriteFooter(func(_ context.Context, accountID, sessionID string) (string, bool) {
		if sessionID == session.ID {
			return "> 来自AI", true
		}
		return "", false
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
	response := serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodPost, "/api/send", []byte(`{"text":"hi"}`))
	if response.Code != http.StatusOK {
		t.Fatalf("send: %d %s", response.Code, response.Body.String())
	}
	if sent[0] != `/api/send {"editorType":"markdown","text":"hi\n\n> 来自AI"}` {
		t.Fatalf("the footer is appended at the declared field, as markdown: %s", sent[0])
	}
	response = serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodPost, "/api/publish", []byte(`{"text":"hi"}`))
	if response.Code != http.StatusOK || sent[1] != `/api/publish {"text":"hi"}` {
		t.Fatalf("a route that is not a message is untouched: %d %s", response.Code, sent[1])
	}
	extensionGateway.UseWriteFooter(func(context.Context, string, string) (string, bool) { return "", true })
	response = serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, http.MethodPost, "/api/send", []byte(`{"text":"hi"}`))
	if response.Code != http.StatusOK || sent[2] != `/api/send {"text":"hi"}` {
		t.Fatalf("an empty footer writes nothing: %d %s", response.Code, sent[2])
	}
}
