package gateway

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// fixture is a one-session world the pipeline can be pointed at: a grant
// for the handle "tk_good", a session and an account that Permitted allows.
type fixture struct {
	grant   store.FeishuGatewayGrant
	session store.AgentSession
	account store.ExternalAccount
	deleted []string
	steps   []string
	records []Record
	need    Need
	deny    *Denial
	upstrm  *Denial
	held    *Holdings
	pipe    *Pipeline
}

func newFixture() *fixture {
	f := &fixture{
		grant:   store.FeishuGatewayGrant{ID: "g1", SessionID: "s1", AccountID: "a1", AppID: "app1", DeviceID: "d1", WorkspaceID: "w1", UserID: "alice", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)},
		session: store.AgentSession{ID: "s1", DeviceID: "d1", WorkspaceID: "w1", CreatedByUserID: "alice", Status: "running"},
		account: store.ExternalAccount{ID: "a1", AppID: "app1", Provider: "demo", OwnerUserID: "alice", Mode: store.ExternalCredentialServerHeld, Status: store.ExternalAccountReady, WorkspaceIDs: []string{"w1"}, GrantedScopes: []string{"write"}},
		need:    Need{Level: "read"},
	}
	f.pipe = &Pipeline{
		Scheme:   Scheme{Provider: "demo", Kind: func(h string) string { return map[bool]string{true: "user"}[strings.HasPrefix(h, "tk_")] }, Hash: func(h string) string { return h }, Bearer: []string{"user"}},
		Provider: &demoProvider{f},
		Sessions: f, Grants: f, Accounts: f, Audit: f,
		Levels: []store.ExternalAccessLevel{{Name: "read"}, {Name: "write", Scopes: []string{"write"}}},
	}
	return f
}

func (f *fixture) GetAgentSessionSummary(_ context.Context, id string) (store.AgentSession, error) {
	if id != f.session.ID {
		return store.AgentSession{}, store.ErrNotFound
	}
	return f.session, nil
}
func (f *fixture) FindFeishuGatewayGrant(_ context.Context, kind, hash string) (store.FeishuGatewayGrant, error) {
	if kind != "user" || hash != "tk_good" {
		return store.FeishuGatewayGrant{}, store.ErrNotFound
	}
	return f.grant, nil
}
func (f *fixture) DeleteFeishuGatewayGrant(_ context.Context, id string) error {
	f.deleted = append(f.deleted, id)
	return nil
}
func (f *fixture) GetExternalAccount(context.Context, string) (store.ExternalAccount, error) {
	return f.account, nil
}
func (f *fixture) GetExternalProviderApp(context.Context, string) (store.ExternalProviderApp, error) {
	return store.ExternalProviderApp{ID: "app1", ClientID: "client"}, nil
}
func (f *fixture) Record(_ context.Context, record Record) { f.records = append(f.records, record) }

type demoProvider struct{ f *fixture }

func (p *demoProvider) Classify(*http.Request, *Lease) (Need, *Denial) {
	p.f.steps = append(p.f.steps, "classify")
	return p.f.need, p.f.deny
}
func (p *demoProvider) Refuse(w http.ResponseWriter, _ *http.Request, d *Denial) Refused {
	p.f.steps = append(p.f.steps, "refuse:"+d.Reason)
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write([]byte("refused " + d.Reason))
	return Refused{Status: http.StatusForbidden, Message: d.Reason}
}
func (p *demoProvider) Upstream(w http.ResponseWriter, _ *http.Request, _ *Exchange) *Denial {
	p.f.steps = append(p.f.steps, "upstream")
	if p.f.upstrm == nil {
		_, _ = w.Write([]byte("sent"))
	}
	return p.f.upstrm
}
func (p *demoProvider) Holdings(context.Context, *Lease) (Holdings, *Denial) {
	p.f.steps = append(p.f.steps, "holdings")
	if p.f.held != nil {
		return *p.f.held, nil
	}
	return Holdings{Level: "write", Resources: []string{"zone1"}, GrantedScopes: p.f.account.GrantedScopes}, nil
}

func (f *fixture) serve(handle string) *httptest.ResponseRecorder {
	return f.serveAs(handle, Device{ID: "d1", OwnerUserID: "alice"})
}

func (f *fixture) serveAs(handle string, device Device) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, "/x", nil)
	if handle != "" {
		request.Header.Set("Authorization", "Bearer "+handle)
	}
	recorder := httptest.NewRecorder()
	f.steps, f.records = nil, nil
	f.pipe.Serve(recorder, request, device)
	return recorder
}

func (f *fixture) outcome(t *testing.T) string {
	t.Helper()
	if len(f.records) != 1 {
		t.Fatalf("want one audit line, got %d", len(f.records))
	}
	return f.records[0].Outcome
}

func TestRequestRunsEveryStepInOrderAndIsAudited(t *testing.T) {
	f := newFixture()
	response := f.serve("tk_good")
	if response.Code != http.StatusOK || response.Body.String() != "sent" {
		t.Fatalf("answer: %d %q", response.Code, response.Body.String())
	}
	if got := strings.Join(f.steps, ","); got != "holdings,classify,upstream" {
		t.Fatalf("steps %s", got)
	}
	if f.outcome(t) != OutcomeForwarded || f.records[0].Lease == nil || f.records[0].Status != http.StatusOK || f.records[0].BytesOut != 4 {
		t.Fatalf("audit %+v", f.records[0])
	}
}

func TestNothingReachesTheConnectorBeforeTheSessionIsAuthenticatedAndRechecked(t *testing.T) {
	for name, tc := range map[string]struct {
		prepare func(f *fixture)
		handle  string
		device  Device
		reason  string
	}{
		"no stand-in":                {handle: "", reason: ReasonNoCredential},
		"not this connector":         {handle: "other", reason: ReasonNoCredential},
		"unknown stand-in":           {handle: "tk_unknown", reason: ReasonAccessEnded},
		"another device":             {handle: "tk_good", device: Device{ID: "d2", OwnerUserID: "alice"}, reason: ReasonAccessEnded},
		"another device owner":       {handle: "tk_good", device: Device{ID: "d1", OwnerUserID: "bob"}, reason: ReasonAccessEnded},
		"session finished":           {prepare: func(f *fixture) { f.session.Status = "completed" }, handle: "tk_good", reason: ReasonAccessEnded},
		"session on another device":  {prepare: func(f *fixture) { f.session.DeviceID = "d9" }, handle: "tk_good", reason: ReasonAccessEnded},
		"session moved workspace":    {prepare: func(f *fixture) { f.session.WorkspaceID = "w2" }, handle: "tk_good", reason: ReasonAccessEnded},
		"account unbound":            {prepare: func(f *fixture) { f.account.WorkspaceIDs = nil }, handle: "tk_good", reason: ReasonAccessEnded},
		"account needs re-auth":      {prepare: func(f *fixture) { f.account.Status = store.ExternalAccountNeedsReauth }, handle: "tk_good", reason: ReasonAccessEnded},
		"account of another owner":   {prepare: func(f *fixture) { f.account.OwnerUserID = "bob" }, handle: "tk_good", reason: ReasonAccessEnded},
		"another provider's account": {prepare: func(f *fixture) { f.account.Provider = "other" }, handle: "tk_good", reason: ReasonAccessEnded},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture()
			if tc.prepare != nil {
				tc.prepare(f)
			}
			device := tc.device
			if device.ID == "" {
				device = Device{ID: "d1", OwnerUserID: "alice"}
			}
			response := f.serveAs(tc.handle, device)
			if response.Code != http.StatusForbidden || response.Body.String() != "refused "+tc.reason {
				t.Fatalf("answer %d %q, want a refusal for %s", response.Code, response.Body.String(), tc.reason)
			}
			if got := strings.Join(f.steps, ","); got != "refuse:"+tc.reason {
				t.Fatalf("the connector was reached: %s", got)
			}
			if f.outcome(t) != OutcomeRefused {
				t.Fatalf("audit %+v", f.records[0])
			}
		})
	}
}

func TestAnEndedSessionSpendsItsGrant(t *testing.T) {
	f := newFixture()
	f.session.Status = "completed"
	f.serve("tk_good")
	if len(f.deleted) != 1 || f.deleted[0] != "g1" {
		t.Fatalf("grants dropped: %v", f.deleted)
	}
	f = newFixture()
	f.session.WorkspaceID = "w2"
	f.serve("tk_good")
	if len(f.deleted) != 0 {
		t.Fatalf("a grant was spent by a session that only moved: %v", f.deleted)
	}
}

func TestStandInsExpireWithTheSchemeLifetime(t *testing.T) {
	f := newFixture()
	f.pipe.Scheme.Lifetime = time.Minute
	f.pipe.Now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	if response := f.serve("tk_good"); response.Body.String() != "refused "+ReasonHandleExpired {
		t.Fatalf("expired stand-in: %q", response.Body.String())
	}
	f.pipe.Now = time.Now
	if response := f.serve("tk_good"); response.Body.String() != "sent" {
		t.Fatalf("live stand-in: %q", response.Body.String())
	}
}

func TestComparisonChecksResourceThenLevelThenScopes(t *testing.T) {
	for name, tc := range map[string]struct {
		need   Need
		held   *Holdings
		reason string
		denial Denial
	}{
		"a held resource at a held level":         {need: Need{Resource: "zone1", Level: "write"}},
		"a lower level is enough":                 {need: Need{Resource: "zone1", Level: "read"}},
		"a resource not held":                     {need: Need{Resource: "zone2", Level: "read"}, reason: ReasonNotBound},
		"a level above the held one":              {need: Need{Level: "write"}, held: &Holdings{Level: "read"}, reason: ReasonAccessLevel, denial: Denial{Needed: "write", Current: "read"}},
		"a level the connector never named":       {need: Need{Level: "admin"}, reason: ReasonAccessLevel},
		"a level whose scopes were lost":          {need: Need{Level: "write"}, held: &Holdings{Level: "write"}, reason: ReasonScopeMissing, denial: Denial{Needed: "write", Current: "write"}},
		"no level needed":                         {need: Need{}, held: &Holdings{Level: "read"}},
		"resource checked before the path stands": {need: Need{Resource: "zone2", Otherwise: &Denial{Reason: ReasonPathNotAllowed}}, reason: ReasonNotBound},
		"a path no level allows":                  {need: Need{Resource: "zone1", Otherwise: &Denial{Reason: ReasonPathNotAllowed}}, reason: ReasonPathNotAllowed},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture()
			f.need, f.held = tc.need, tc.held
			if tc.held != nil && tc.held.Level == "write" && tc.reason == ReasonScopeMissing {
				f.account.GrantedScopes = nil
			}
			response := f.serve("tk_good")
			want := "sent"
			if tc.reason != "" {
				want = "refused " + tc.reason
			}
			if response.Body.String() != want {
				t.Fatalf("answer %q, want %q", response.Body.String(), want)
			}
			if tc.reason != "" {
				if strings.Contains(strings.Join(f.steps, ","), "upstream") {
					t.Fatal("a denied request went upstream")
				}
				d := f.records[0].Denial
				if d == nil || d.Reason != tc.reason || (tc.denial.Needed != "" && (d.Needed != tc.denial.Needed || d.Current != tc.denial.Current)) {
					t.Fatalf("denial %+v", d)
				}
			}
		})
	}
}

func TestAConnectorDenialFromClassifyIsRefusedAndAudited(t *testing.T) {
	f := newFixture()
	f.deny = &Denial{Reason: ReasonBlocked, Message: "never"}
	f.need = Need{Detail: "kept for the audit"}
	response := f.serve("tk_good")
	if response.Body.String() != "refused "+ReasonBlocked || strings.Contains(strings.Join(f.steps, ","), "upstream") {
		t.Fatalf("answer %q steps %v", response.Body.String(), f.steps)
	}
	if f.outcome(t) != OutcomeBlocked || f.records[0].Detail != "kept for the audit" {
		t.Fatalf("audit %+v", f.records[0])
	}
}

func TestUpstreamMayDeclineBeforeSendingAndIsRefusedLikeAnyDenial(t *testing.T) {
	f := newFixture()
	f.upstrm = &Denial{Reason: ReasonBadRequest, Message: "no body"}
	response := f.serve("tk_good")
	if response.Body.String() != "refused "+ReasonBadRequest || f.outcome(t) != OutcomeRefused {
		t.Fatalf("answer %q audit %+v", response.Body.String(), f.records)
	}
}

func TestLimitsAndTheUnavailableSwitchComeBeforeUpstream(t *testing.T) {
	f := newFixture()
	f.pipe.Limits = []Limit{Rate{PerSecond: 0.001, Burst: 2}.PerKey(func(l *Lease) string { return l.Grant.SessionID })}
	for i := range 2 {
		if response := f.serve("tk_good"); response.Body.String() != "sent" {
			t.Fatalf("call %d inside the burst: %q", i, response.Body.String())
		}
	}
	if response := f.serve("tk_good"); response.Body.String() != "refused "+ReasonRateLimited || f.outcome(t) != OutcomeRateLimited || f.records[0].Denial.Wait <= 0 {
		t.Fatalf("over the burst: %q %+v", response.Body.String(), f.records)
	}
	if strings.Contains(strings.Join(f.steps, ","), "upstream") {
		t.Fatal("a limited call went upstream")
	}
	f = newFixture()
	f.pipe.Unavailable = func() error { return errors.New("off") }
	if response := f.serve("tk_good"); response.Body.String() != "refused "+ReasonUnavailable || f.outcome(t) != OutcomeUnavailable {
		t.Fatalf("unavailable: %q", response.Body.String())
	}
}

func TestLiveAnswersTheSameRecheckForAConnectionTheConnectorHolds(t *testing.T) {
	f := newFixture()
	subject := Subject{SessionID: "s1", WorkspaceID: "w1", DeviceID: "d1", UserID: "alice", AccountID: "a1", AppID: "app1"}
	if _, err := f.pipe.Live(context.Background(), subject, "alice"); err != nil {
		t.Fatal(err)
	}
	f.session.Status = "completed"
	if _, err := f.pipe.Live(context.Background(), subject, "alice"); !errors.Is(err, ErrSessionEnded) {
		t.Fatalf("finished session: %v", err)
	}
	f = newFixture()
	f.account.WorkspaceIDs = nil
	if _, err := f.pipe.Live(context.Background(), subject, "alice"); !errors.Is(err, ErrAccessEnded) {
		t.Fatalf("unbound account: %v", err)
	}
}
