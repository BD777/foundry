package feishugateway

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestBlocklist(t *testing.T) {
	for _, tc := range []struct {
		method, path string
		blocked      bool
	}{
		{http.MethodPost, "/open-apis/im/v1/messages", false},
		{http.MethodGet, "/open-apis/authen/v1/user_info", false},
		{http.MethodPost, "/open-apis/authen/v1/access_token", true},
		{http.MethodPost, "/open-apis/auth/v3/app_ticket/resend", true},
		{http.MethodGet, "/open-apis/application/v6/applications/cli_1", false},
		{http.MethodPatch, "/open-apis/application/v6/applications/cli_1/visibility", true},
		{http.MethodPut, "/open-apis/application/v6/applications/cli_1/owner", true},
		{http.MethodGet, "/open-apis/admin/v1/admin_user_stats", true},
		{http.MethodPost, "/open-apis/passport/v1/sessions/query", true},
		{http.MethodGet, "/open-apis/tenant/v2/tenant/query", false},
		{http.MethodPost, "/open-apis/contact/v3/users/batch_get_id", false},
	} {
		if got := blocked(tc.method, tc.path) != ""; got != tc.blocked {
			t.Errorf("%s %s blocked=%v, want %v", tc.method, tc.path, got, tc.blocked)
		}
	}
}

func TestPathTemplateStripsIDs(t *testing.T) {
	for path, want := range map[string]string{
		"/open-apis/im/v1/messages/om_dc13264520392913993dd051dba21dcf/reply": "/open-apis/im/v1/messages/:id/reply",
		"/open-apis/drive/v1/files/boxcnrHpsg1QDqXAAAyachabcef/download":      "/open-apis/drive/v1/files/:id/download",
		"/open-apis/docx/v1/documents/doxcnABC123/blocks/doxcnABC123":         "/open-apis/docx/v1/documents/:id/blocks/:id",
		"/open-apis/authen/v1/user_info":                                      "/open-apis/authen/v1/user_info",
		"/open-apis/contact/v3/users/ou_7d8a6e6df7621556ce0d21922b676706":     "/open-apis/contact/v3/users/:id",
	} {
		if got := pathTemplate(path); got != want {
			t.Errorf("pathTemplate(%s) = %s, want %s", path, got, want)
		}
	}
}

func TestDerivedHandlesBelongToOneAppHandle(t *testing.T) {
	seed := strings.Repeat("A", 43)
	app := appHandlePrefix + seed
	user, ok := derivedHandle(app, userHandlePrefix)
	tenant, ok2 := derivedHandle(app, tenantHandlePrefix)
	if !ok || !ok2 || !strings.HasPrefix(user, "fsu_") || !strings.HasPrefix(tenant, "fst_") || user[4:] == tenant[4:] {
		t.Fatalf("derived: %q %q", user, tenant)
	}
	again, _ := derivedHandle(app, tenantHandlePrefix)
	if again != tenant {
		t.Fatal("derivation is not stable")
	}
	if _, ok := derivedHandle("fsu_"+seed, tenantHandlePrefix); ok {
		t.Fatal("a user handle derived a tenant handle")
	}
	if _, ok := derivedHandle(appHandlePrefix+"short", tenantHandlePrefix); ok {
		t.Fatal("a malformed app handle derived a tenant handle")
	}
}

func TestLimiterRefills(t *testing.T) {
	limit := &limiter{rate: Rate{PerSecond: 2, Burst: 2}}
	now := time.Unix(0, 0)
	for range 2 {
		if ok, _ := limit.take("s", now); !ok {
			t.Fatal("burst refused")
		}
	}
	ok, wait := limit.take("s", now)
	if ok || wait <= 0 || wait > time.Second {
		t.Fatalf("over the burst: ok=%v wait=%s", ok, wait)
	}
	if ok, _ := limit.take("other", now); !ok {
		t.Fatal("keys share a bucket")
	}
	if ok, _ := limit.take("s", now.Add(600*time.Millisecond)); !ok {
		t.Fatal("no refill")
	}
}

func TestLoopbackHost(t *testing.T) {
	for host, want := range map[string]bool{"127.0.0.1:4000": true, "[::1]:4000": true, "localhost:1": true, "10.0.0.1:80": false, "127.0.0.1": false, "example.com:80": false} {
		if loopbackHost(host) != want {
			t.Errorf("loopbackHost(%s) != %v", host, want)
		}
	}
}
