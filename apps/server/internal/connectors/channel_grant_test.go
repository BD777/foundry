package connectors

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/sqlitestore"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A channel-lineage session writes without a card only inside the objects
// it was granted (DEV-265); every other write waits for the person with a
// factual refusal body.
func TestExtensionChannelGrantLimitsWrites(t *testing.T) {
	ctx := context.Background()
	st, err := sqlitestore.OpenWithOptions(filepath.Join(t.TempDir(), "db"), sqlitestore.Options{SecretKeyPath: filepath.Join(t.TempDir(), "key")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	var mu sync.Mutex
	writes := map[string]int{}
	resolverGets := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mu.Lock()
		writes[r.Method+" "+r.URL.Path]++
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/agent/v1/messages/") {
			resolverGets++
		}
		mu.Unlock()
		switch {
		case r.URL.Path == "/agent/v1/capabilities":
			_, _ = w.Write([]byte(`{"token":{"scope":"full"}}`))
		case r.URL.Path == "/agent/v1/accounts":
			_, _ = w.Write([]byte(`{"accounts":[{"id":"42","name":"Ada"}],"activeId":"42"}`))
		case r.URL.Path == "/agent/v1" || r.URL.Path == "/agent/v1/":
			_, _ = w.Write([]byte(`{"routes":[
				{"method":"POST","path":"/agent/v1/conversations/:feedId/messages","access":"write","domain":"im"},
				{"method":"POST","path":"/agent/v1/messages/:messageId/replies","access":"write","domain":"im"},
				{"method":"POST","path":"/agent/v1/image-uploads","access":"write","domain":"im"},
				{"method":"POST","path":"/agent/v1/documents/write","access":"write","domain":"doc"},
				{"method":"POST","path":"/agent/v1/documents/summarised","access":"write","domain":"doc","summary":"来自目录的操作"},
				{"method":"POST","path":"/agent/v1/documents/plain","access":"write","domain":"doc"},
				{"method":"GET","path":"/agent/v1/messages/:messageId","access":"read","domain":"im"},
				{"method":"GET","path":"/agent/v1/conversations/:feedId/messages","access":"read","domain":"im"},
				{"method":"GET","path":"/agent/v1/conversations/:feedId","access":"read","domain":"im"}
			]}`))
		case r.URL.Path == "/agent/v1/messages/om_own" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"item":{"id":"om_own","feedId":"oc_own"}}`))
		case r.URL.Path == "/agent/v1/messages/om_other" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"item":{"id":"om_other","feedId":"oc_other"}}`))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/messages"):
			_, _ = w.Write([]byte(`{"items":[]}`))
		case r.URL.Path == "/agent/v1/conversations/oc_other" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"feedId":"oc_other","name":"Gao Yibin"}`))
		case r.URL.Path == "/agent/v1/conversations/oc_own" && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"feedId":"oc_own","name":"Me"}`))
		default:
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
				Items: "/routes", Method: "/method", Path: "/path", Access: "/access", Domain: "/domain", Summary: "/summary",
			},
		},
	}
	descriptor.ServerHeld.Upstream.PathPrefix = "/agent/v1"
	descriptor.ServerHeld.Writes = []store.ConnectorServerHeldWrite{
		{
			Method: "POST", Path: "/agent/v1/conversations/:feedId/messages", CreatedMessageID: "/messageId",
			Objects: []store.ConnectorServerHeldWriteObject{{Type: "conversation", From: ":feedId"}},
		},
		{
			Method: "POST", Path: "/agent/v1/messages/:messageId/replies",
			Objects: []store.ConnectorServerHeldWriteObject{{Type: "message", From: ":messageId"}},
		},
		{Method: "POST", Path: "/agent/v1/image-uploads", Auxiliary: true},
		{Method: "POST", Path: "/agent/v1/documents/write", Summary: "新建云文档"},
	}
	descriptor.ServerHeld.Resolvers = []store.ConnectorServerHeldResolver{{
		From: "message", To: "conversation", Method: "GET",
		Path: "/agent/v1/messages/:messageId", Pointer: "/item/feedId", TTLSeconds: 600,
	}}
	descriptor.ServerHeld.Labels = []store.ConnectorServerHeldLabel{{
		Object: "conversation", Method: "GET",
		Path: "/agent/v1/conversations/:feedId", Pointer: "/name", TTLSeconds: 600,
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
	instanceB, err := service.CreateExtensionInstance(ctx, "alice", descriptor, store.ConnectorServerHeldInstanceInput{
		Label:  "OpenLark other",
		Fields: map[string]string{"baseUrl": upstream.URL, "readToken": "fixture-secret", "account": "42"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetWorkspaceExternalAccounts(ctx, "workspace-pa", "alice", []string{instance.AccountID, instanceB.AccountID}); err != nil {
		t.Fatal(err)
	}
	session := store.AgentSession{
		ID: "session-channel", DeviceID: "device-alice", WorkspaceID: "workspace-pa",
		CreatedByUserID: "alice", Status: "running", Role: store.AgentSessionRolePersonalAgent,
		Source: store.SessionSourceChat, WorkspaceAccess: store.SessionWorkspaceAccessRead,
	}
	helper := store.AgentSession{
		ID: "session-helper", DeviceID: "device-alice", WorkspaceID: "workspace-pa",
		CreatedByUserID: "alice", ParentSessionID: session.ID, Status: "running",
		Source: store.SessionSourceAgent,
	}
	fake := &cfGatewayStore{Store: st, session: session, sessions: map[string]store.AgentSession{helper.ID: helper}}
	pkg := permission.DefaultPackage("alice", "pkg-channel")
	pkg.ConnectorAccounts = []store.ConnectorAccountPermission{
		{AccountID: instance.AccountID, Level: store.ConnectorAccessLevelWrite},
		{AccountID: instanceB.AccountID, Level: store.ConnectorAccessLevelWrite},
	}
	permissionStore := &extensionPermissionStore{
		cfGatewayStore: fake, workspaceID: "workspace-pa",
		agent: store.PersonalAgent{UserID: "alice", WorkspaceID: "workspace-pa", HomeDeviceID: "device-alice", PermissionPackageID: pkg.ID},
		pkg:   pkg,
	}
	confirmer := &extensionRecordingConfirmer{decision: gateway.ConfirmationDecision{ProposalID: "proposal-1", Summary: "A write outside the grant"}}
	extensionGateway := NewExtensionGateway(permissionStore, service, func(context.Context, string, string) (store.ConnectorDescriptor, error) {
		return descriptor, nil
	})
	extensionGateway.UsePermission(permissionStore, confirmer)
	if err := st.SetSessionConnectorGrants(ctx, session.ID, instance.AccountID, []store.SessionConnectorGrant{{
		AccountID: instance.AccountID, ObjectType: "conversation", ObjectID: "oc_own", Label: "Lena",
	}}); err != nil {
		t.Fatal(err)
	}
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
	accountB, err := st.GetExternalAccount(ctx, instanceB.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	handleB, err := extensionGateway.IssueHandles(ctx, externalaccounts.HandleRequest{
		SessionID: session.ID, DeviceID: session.DeviceID, WorkspaceID: session.WorkspaceID, UserID: "alice", Account: accountB,
	})
	if err != nil {
		t.Fatal(err)
	}
	helperB, err := extensionGateway.IssueHandles(ctx, externalaccounts.HandleRequest{
		SessionID: helper.ID, DeviceID: helper.DeviceID, WorkspaceID: helper.WorkspaceID, UserID: "alice", Account: accountB,
	})
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, path string, body string) *httptest.ResponseRecorder {
		return serveExtensionGateway(t, extensionGateway, "acme-api", handle.UserHandle, method, path, []byte(body))
	}

	// Reads are never checked against grants: today's access rules only, on
	// the granted account, another account, and a helper's inherited read.
	readOwn := call(http.MethodGet, "/agent/v1/conversations/oc_own/messages", "")
	readOther := serveExtensionGateway(t, extensionGateway, "acme-api", handleB.UserHandle, http.MethodGet, "/agent/v1/conversations/oc_own/messages", nil)
	readHelper := serveExtensionGateway(t, extensionGateway, "acme-api", helperB.UserHandle, http.MethodGet, "/agent/v1/conversations/oc_own/messages", nil)
	if readOwn.Code != http.StatusOK || readOther.Code != http.StatusOK || readHelper.Code != http.StatusOK || len(confirmer.requests) != 0 {
		t.Fatalf("reads = %d/%d/%d, confirmations %+v", readOwn.Code, readOther.Code, readHelper.Code, confirmer.requests)
	}

	own := call(http.MethodPost, "/agent/v1/conversations/oc_own/messages", `{"text":"hi"}`)
	if own.Code != http.StatusOK || len(confirmer.requests) != 0 || writes["POST /agent/v1/conversations/oc_own/messages"] != 1 {
		t.Fatalf("own conversation = %d %s, confirmations %+v", own.Code, own.Body.String(), confirmer.requests)
	}
	other := call(http.MethodPost, "/agent/v1/conversations/oc_other/messages", `{"text":"hello"}`)
	if other.Code != http.StatusForbidden || !strings.Contains(other.Body.String(), "FOUNDRY_WRITE_OUTSIDE_GRANT") ||
		!strings.Contains(other.Body.String(), `"proposalId":"proposal-1"`) || strings.Contains(other.Body.String(), `"where"`) ||
		len(confirmer.requests) != 1 || writes["POST /agent/v1/conversations/oc_other/messages"] != 0 {
		t.Fatalf("other conversation = %d %s, confirmations %+v", other.Code, other.Body.String(), confirmer.requests)
	}
	request := confirmer.requests[0]
	if len(request.Objects) != 1 || request.Objects[0] != (permission.GrantObject{Type: "conversation", ID: "oc_other"}) ||
		request.BodyDigest == "" || len(request.Body) == 0 {
		t.Fatalf("the confirmation holds the request: %+v", request)
	}
	if len(request.Labels) != 1 || request.Labels[0] != (gateway.ObjectLabel{Type: "conversation", ID: "oc_other", Name: "Gao Yibin"}) {
		t.Fatalf("the confirmation names its target: %+v", request.Labels)
	}

	replyOwn := call(http.MethodPost, "/agent/v1/messages/om_own/replies", `{"text":"hi"}`)
	if replyOwn.Code != http.StatusOK || writes["POST /agent/v1/messages/om_own/replies"] != 1 || resolverGets != 1 {
		t.Fatalf("reply in the grant = %d %s, resolver gets %d", replyOwn.Code, replyOwn.Body.String(), resolverGets)
	}
	// The resolver's answer is cached per account: a second reply costs none.
	if again := call(http.MethodPost, "/agent/v1/messages/om_own/replies", `{"text":"again"}`); again.Code != http.StatusOK || resolverGets != 1 {
		t.Fatalf("cached reply = %d %s, resolver gets %d", again.Code, again.Body.String(), resolverGets)
	}
	replyOther := call(http.MethodPost, "/agent/v1/messages/om_other/replies", `{"text":"hi"}`)
	if replyOther.Code != http.StatusForbidden || len(confirmer.requests) != 2 ||
		len(confirmer.requests[1].Labels) != 1 || confirmer.requests[1].Labels[0].Name != "Gao Yibin" {
		t.Fatalf("reply elsewhere = %d %s, confirmations %+v", replyOther.Code, replyOther.Body.String(), confirmer.requests)
	}
	upload := call(http.MethodPost, "/agent/v1/image-uploads", `{"data":"x"}`)
	if upload.Code != http.StatusOK {
		t.Fatalf("auxiliary upload = %d %s", upload.Code, upload.Body.String())
	}
	undeclared := call(http.MethodPost, "/agent/v1/documents/write", `{"title":"DEV-265 授权测试（可删）","docType":"docx"}`)
	if undeclared.Code != http.StatusForbidden || len(confirmer.requests) != 3 {
		t.Fatalf("undeclared write = %d %s, confirmations %+v", undeclared.Code, undeclared.Body.String(), confirmer.requests)
	}
	// A write the descriptor names, with what it would send: top-level strings
	// as a preview, the full JSON for the disclosure.
	grantless := confirmer.requests[2]
	preview, bodyText := PreviewBody(grantless.Body)
	if grantless.Operation != "新建云文档" ||
		len(preview) != 2 || preview[0] != "docType: docx" ||
		preview[1] != "title: DEV-265 授权测试（可删）" ||
		!strings.Contains(bodyText, `"title": "DEV-265 授权测试（可删）"`) {
		t.Fatalf("the generic write = %q preview %+v body %s", grantless.Operation, preview, bodyText)
	}
	// The probed route's own summary wins; without one the route is named.
	summarised := call(http.MethodPost, "/agent/v1/documents/summarised", `{"a":"b"}`)
	if summarised.Code != http.StatusForbidden || len(confirmer.requests) != 4 ||
		confirmer.requests[3].Operation != "来自目录的操作" {
		t.Fatalf("probed summary = %d %s, confirmations %+v", summarised.Code, summarised.Body.String(), confirmer.requests)
	}
	plain := call(http.MethodPost, "/agent/v1/documents/plain", `{"a":"b"}`)
	if plain.Code != http.StatusForbidden || len(confirmer.requests) != 5 ||
		confirmer.requests[4].Operation != "POST /agent/v1/documents/plain" {
		t.Fatalf("plain write = %d %s, confirmations %+v", plain.Code, plain.Body.String(), confirmer.requests)
	}
	// An unnamed target is kept unnamed for the person's card; the id alone
	// is never presented as a name.
	unknown := call(http.MethodPost, "/agent/v1/conversations/oc_unknown/messages", `{"text":"hi"}`)
	if unknown.Code != http.StatusForbidden || len(confirmer.requests) != 6 ||
		len(confirmer.requests[5].Labels) != 1 || confirmer.requests[5].Labels[0].Name != "" {
		t.Fatalf("unknown target = %d %s, confirmations %+v", unknown.Code, unknown.Body.String(), confirmer.requests)
	}
}
