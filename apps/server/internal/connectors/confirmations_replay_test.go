package connectors

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Accepting a proposal makes Foundry replay the recorded request itself
// (DEV-265): the body goes out once, its created message is recorded, and a
// proposal that expired sends nothing.
func TestReplayConfirmedWriteSendsTheRecordedRequest(t *testing.T) {
	ctx := context.Background()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(t.TempDir(), "db"), sqlitestore.Options{SecretKeyPath: filepath.Join(t.TempDir(), "key")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	var mu sync.Mutex
	var sent []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/agent/v1/capabilities":
			_, _ = w.Write([]byte(`{"token":{"scope":"full"}}`))
		case "/agent/v1/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"42","name":"Ada"}],"activeId":"42"}`))
		case "/agent/v1":
			_, _ = w.Write([]byte(`{"routes":[{"method":"POST","path":"/agent/v1/conversations/:feedId/messages","access":"write","domain":"im"}]}`))
		default:
			body := ""
			if r.Body != nil {
				raw := make([]byte, 4096)
				n, _ := r.Body.Read(raw)
				body = string(raw[:n])
			}
			mu.Lock()
			sent = append(sent, r.URL.Path+" "+body)
			mu.Unlock()
			_, _ = w.Write([]byte(`{"messageId":"om_created"}`))
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
	descriptor.ServerHeld.Writes = []store.ConnectorServerHeldWrite{{
		Method: "POST", Path: "/agent/v1/conversations/:feedId/messages", CreatedMessageID: "/messageId",
		Objects: []store.ConnectorServerHeldWriteObject{{Type: "conversation", From: ":feedId"}},
	}}
	service := externalaccounts.NewService(st, st, externalaccounts.NewRegistry())
	service.Extensions = externalaccounts.NewExtensionTestClient(upstream.Client())
	instance, err := service.CreateExtensionInstance(ctx, "alice", descriptor, store.ConnectorServerHeldInstanceInput{
		Label:  "OpenLark channel",
		Fields: map[string]string{"baseUrl": upstream.URL, "readToken": "fixture-secret", "account": "42"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetWorkspaceExternalAccounts(ctx, "workspace-pa", "alice", []string{instance.AccountID}); err != nil {
		t.Fatal(err)
	}
	session := store.AgentSession{
		ID: "session-channel", DeviceID: "device-alice", WorkspaceID: "workspace-pa",
		CreatedByUserID: "alice", Status: "running", Role: store.AgentSessionRolePersonalAgent,
		Source: store.SessionSourceChat, WorkspaceAccess: store.SessionWorkspaceAccessRead,
	}
	fake := &cfGatewayStore{Store: st, session: session}
	pkg := permission.DefaultPackage("alice", "pkg-channel")
	pkg.ConnectorAccounts = []store.ConnectorAccountPermission{{AccountID: instance.AccountID, Level: store.ConnectorAccessLevelWrite}}
	permissionStore := &extensionPermissionStore{
		cfGatewayStore: fake, workspaceID: "workspace-pa",
		agent: store.PersonalAgent{UserID: "alice", WorkspaceID: "workspace-pa", HomeDeviceID: "device-alice", PermissionPackageID: pkg.ID},
		pkg:   pkg,
	}
	extensionGateway := NewExtensionGateway(permissionStore, service, func(context.Context, string, string) (store.ConnectorDescriptor, error) {
		return descriptor, nil
	})
	spec, err := json.Marshal(ConnectorConfirmationSpec{
		AccountID: instance.AccountID, AccountName: "OpenLark channel", Connector: "openlark",
		DeviceID: "device-alice", Method: http.MethodPost,
		Path: "/agent/v1/conversations/oc_own/messages", Body: []byte(`{"text":"hello"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	proposal := store.PersonalAgentProposal{
		ID: "proposal-1", UserID: "alice", SessionID: session.ID, Spec: spec,
		ExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano),
	}
	detail, err := extensionGateway.ReplayConfirmedWrite(ctx, proposal)
	if err != nil || detail != "message id om_created" {
		t.Fatalf("replay = %q (%v)", detail, err)
	}
	mu.Lock()
	if len(sent) != 1 || sent[0] != `/agent/v1/conversations/oc_own/messages {"text":"hello"}` {
		t.Fatalf("sent = %+v", sent)
	}
	mu.Unlock()
	// The message it created is recorded for the session, so the channel
	// drops the echo as it does for a write the session forwarded itself.
	account, err := st.GetExternalAccount(ctx, instance.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	events, err := st.ListExternalAccountEventsByKind(ctx, account.ID, ExtensionWriteCreatedMessage, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range events {
		if event.SessionID == session.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("the replayed message was not recorded: %+v", events)
	}

	proposal.ExpiresAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	if _, err := extensionGateway.ReplayConfirmedWrite(ctx, proposal); err == nil {
		t.Fatal("an expired proposal replayed")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(sent) != 1 {
		t.Fatalf("the expired proposal sent: %+v", sent)
	}
}
