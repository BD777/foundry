package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestNormalizePersonalAgentNotifyDefaultsToEveryAnswerKind(t *testing.T) {
	settings, err := normalizePersonalAgentNotify(store.PersonalAgentNotifySettings{
		Sinks: []store.PersonalAgentNotifySink{{ConnectorInstanceID: " builtin:feishu ", Kinds: nil}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(settings.Sinks) != 1 || settings.Sinks[0].ConnectorInstanceID != "builtin:feishu" {
		t.Fatalf("sink = %+v, want the trimmed instance", settings.Sinks)
	}
	want := []string{"question", "approval", "hand_over", "ask"}
	if strings.Join(settings.Sinks[0].Kinds, ",") != strings.Join(want, ",") {
		t.Fatalf("kinds = %v, want %v", settings.Sinks[0].Kinds, want)
	}
}

func TestNormalizePersonalAgentNotifyRejectsUnknownKindsAndTwoSinks(t *testing.T) {
	if _, err := normalizePersonalAgentNotify(store.PersonalAgentNotifySettings{
		Sinks: []store.PersonalAgentNotifySink{{ConnectorInstanceID: "builtin:feishu", Kinds: []string{"question", "turn_failed"}}},
	}); err == nil {
		t.Fatal("an unknown kind was accepted")
	}
	if _, err := normalizePersonalAgentNotify(store.PersonalAgentNotifySettings{
		Sinks: []store.PersonalAgentNotifySink{{ConnectorInstanceID: "app_1"}, {ConnectorInstanceID: "app_2"}},
	}); err == nil {
		t.Fatal("two notice connectors were accepted")
	}
	if _, err := normalizePersonalAgentNotify(store.PersonalAgentNotifySettings{
		Sinks: []store.PersonalAgentNotifySink{{ConnectorInstanceID: " "}},
	}); err == nil {
		t.Fatal("a sink without an instance was accepted")
	}
}

// notifyStub is an upstream answering the read routes the notice setting
// uses. Routes are the instance's route directory.
func notifyStub(t *testing.T, handler http.HandlerFunc) notifyUpstream {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	data := bundledNotifyDescriptor(t)
	data.Descriptor.ServerHeld.Access = store.ConnectorServerHeldAccess{Allow: []store.ConnectorServerHeldAccessLevel{"read", "write"}}
	data.Routes = []store.ConnectorServerHeldRoute{
		{Method: "GET", Path: "/agent/v1/me", Access: "read"},
		{Method: "GET", Path: "/agent/v1/conversations", Access: "read"},
		{Method: "GET", Path: "/agent/v1/conversations/:feedId", Access: "read"},
		{Method: "POST", Path: "/agent/v1/conversations/:feedId/messages", Access: "write"},
	}
	request := func(ctx context.Context, method, path string, query url.Values) (*http.Response, error) {
		target := server.URL + path
		if len(query) > 0 {
			target += "?" + query.Encode()
		}
		req, err := http.NewRequestWithContext(ctx, method, target, nil)
		if err != nil {
			return nil, err
		}
		return http.DefaultClient.Do(req)
	}
	return notifyUpstream{data: data, request: request}
}

func writeNotifyJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Error(err)
	}
}

func TestSelfChatDiscoveryPagesUntilTheSignedInAccountsSelfChat(t *testing.T) {
	var listed []string
	upstream := notifyStub(t, func(w http.ResponseWriter, r *http.Request) {
		listed = append(listed, r.URL.RequestURI())
		switch {
		case r.URL.Path == "/agent/v1/me":
			writeNotifyJSON(t, w, map[string]any{"userId": "ou_me"})
		case r.URL.Path == "/agent/v1/conversations" && r.URL.Query().Get("cursor") == "":
			writeNotifyJSON(t, w, map[string]any{
				"hasMore": true, "nextCursor": "c2",
				"items": []map[string]any{
					{"feedId": "oc_group", "name": "项目群", "chatMode": "group"},
					{"feedId": "oc_peer", "name": "张三", "chatMode": "direct", "peerUserId": "ou_other"},
				},
			})
		case r.URL.Path == "/agent/v1/conversations" && r.URL.Query().Get("cursor") == "c2":
			writeNotifyJSON(t, w, map[string]any{
				"hasMore": false,
				"items":   []map[string]any{{"feedId": "oc_self", "name": "我", "chatMode": "direct", "peerUserId": "ou_me"}},
			})
		default:
			http.NotFound(w, r)
		}
	})
	meID, err := upstream.me(context.Background())
	if err != nil || meID != "ou_me" {
		t.Fatalf("me = %q, %v", meID, err)
	}
	chat, err := upstream.findSelfChat(context.Background(), meID)
	if err != nil {
		t.Fatal(err)
	}
	if chat == nil || chat.FeedID != "oc_self" || chat.Name != "我" {
		t.Fatalf("chat = %+v, want the self chat", chat)
	}
	if len(listed) != 3 || !strings.Contains(listed[1], "scope=p2p") || !strings.Contains(listed[2], "cursor=c2") {
		t.Fatalf("requests = %v, want the p2p list paged once", listed)
	}
}

func TestSelfChatDiscoveryReportsAMissWithoutAChat(t *testing.T) {
	upstream := notifyStub(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/agent/v1/conversations" {
			writeNotifyJSON(t, w, map[string]any{"hasMore": false, "items": []map[string]any{{"feedId": "oc_peer", "chatMode": "direct", "peerUserId": "ou_other"}}})
			return
		}
		http.NotFound(w, r)
	})
	chat, err := upstream.findSelfChat(context.Background(), "ou_me")
	if err != nil || chat != nil {
		t.Fatalf("chat = %+v, %v; want none and no error", chat, err)
	}
}

func TestTypedChatMustBeTheSelfChat(t *testing.T) {
	upstream := notifyStub(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/agent/v1/conversations/oc_peer":
			writeNotifyJSON(t, w, map[string]any{"feedId": "oc_peer", "name": "张三", "chatMode": "direct", "peerUserId": "ou_other"})
		case "/agent/v1/conversations/oc_self":
			writeNotifyJSON(t, w, map[string]any{"feedId": "oc_self", "name": "我", "chatMode": "direct", "peerUserId": "ou_me"})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	ctx := context.Background()
	if chat, err := upstream.readSelfChat(ctx, "ou_me", "oc_self"); err != nil || chat.FeedID != "oc_self" {
		t.Fatalf("self chat = %+v, %v", chat, err)
	}
	assertNotifyReason(t, func() error { _, err := upstream.readSelfChat(ctx, "ou_me", "oc_peer"); return err }, notifyReasonChatNotSelf)
	assertNotifyReason(t, func() error { _, err := upstream.readSelfChat(ctx, "ou_me", "oc_missing"); return err }, notifyReasonChatNotFound)
}

func TestNoticeDiscoveryOnlyReadsRoutesTheDirectoryLists(t *testing.T) {
	hit := false
	upstream := notifyStub(t, func(w http.ResponseWriter, r *http.Request) { hit = true })
	upstream.data.Routes = upstream.data.Routes[:1]
	assertNotifyReason(t, func() error { _, err := upstream.findSelfChat(context.Background(), "ou_me"); return err }, notifyReasonNotNotifiable)
	if hit {
		t.Fatal("a route the directory does not list was sent")
	}
}

func assertNotifyReason(t *testing.T, call func() error, reason string) {
	t.Helper()
	err := call()
	var failure notifyError
	if !errors.As(err, &failure) || failure.reason != reason {
		t.Fatalf("err = %v, want reason %s", err, reason)
	}
}

func TestTestNoticeReportsTheSentMessage(t *testing.T) {
	var sent []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sent = body
		writeNotifyJSON(t, w, map[string]any{"messageId": "om_test"})
	}))
	t.Cleanup(server.Close)
	data := bundledNotifyDescriptor(t)
	data.Values["notifyChat"] = "oc_self"
	notice := store.PersonNotice{ID: "pn_test", Kind: "question", Title: "[测试] Foundry 通知联调", Text: "无需处理。"}
	request, err := planNoticeRequest(data, notice, "https://foundry.example.com")
	if err != nil {
		t.Fatal(err)
	}
	result, err := sendNotice(context.Background(), request, httpRequester(server))
	if err != nil {
		t.Fatal(err)
	}
	if result.ProviderMessageID != "om_test" {
		t.Fatalf("provider message id = %q, want om_test", result.ProviderMessageID)
	}
	if !strings.Contains(string(sent), "[测试] Foundry 通知联调") || !strings.Contains(request.path, "oc_self") {
		t.Fatalf("sent body %s does not carry the test title to the self chat", sent)
	}
}
