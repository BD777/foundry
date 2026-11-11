package gateway

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/jsonempty"
	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// fixture is a one-session world the pipeline can be pointed at: a grant
// for the handle "tk_good", a session and an account that Permitted allows.
type fixture struct {
	grant     store.FeishuGatewayGrant
	session   store.AgentSession
	account   store.ExternalAccount
	deleted   []string
	steps     []string
	records   []Record
	need      Need
	deny      *Denial
	upstrm    *Denial
	held      *Holdings
	pipe      *Pipeline
	assistant *store.PersonalAgent
	pkg       *store.PermissionPackage
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
		Sessions: f, Grants: f, Accounts: f, Access: f, Permission: f, Audit: f,
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
func (f *fixture) GetWorkspace(_ context.Context, workspaceID string) (store.WorkspaceProjection, error) {
	if f.assistant != nil && workspaceID == f.assistant.WorkspaceID {
		return store.WorkspaceProjection{ID: workspaceID, Kind: store.WorkspaceKindPersonalAgent}, nil
	}
	return store.WorkspaceProjection{ID: workspaceID, Kind: store.WorkspaceKindProject}, nil
}
func (f *fixture) PersonalAgentForWorkspace(_ context.Context, workspaceID string) (store.PersonalAgent, error) {
	if f.assistant != nil && workspaceID == f.assistant.WorkspaceID {
		return *f.assistant, nil
	}
	return store.PersonalAgent{}, store.ErrNotFound
}
func (f *fixture) GetPermissionPackage(_ context.Context, owner, id string) (store.PermissionPackage, error) {
	if f.pkg != nil && f.pkg.Owner == owner && f.pkg.ID == id {
		return *f.pkg, nil
	}
	return store.PermissionPackage{}, store.ErrNotFound
}
func (f *fixture) SavePermissionPackage(_ context.Context, pkg store.PermissionPackage) (store.PermissionPackage, error) {
	f.pkg = &pkg
	return pkg, nil
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

func (f *fixture) serveRequest(request *http.Request) *httptest.ResponseRecorder {
	request.Header.Set("Authorization", "Bearer tk_good")
	recorder := httptest.NewRecorder()
	f.steps, f.records = nil, nil
	f.pipe.Serve(recorder, request, Device{ID: "d1", OwnerUserID: "alice"})
	return recorder
}

func (f *fixture) enableAssistant(level string) {
	f.pipe.Scheme.Provider = "feishu"
	f.account.Provider = "feishu"
	f.account.WorkspaceIDs = nil
	f.session.WorkspaceID = "w_pa"
	f.session.Role = store.AgentSessionRolePersonalAgent
	f.session.Source = store.SessionSourceChat
	f.grant.WorkspaceID = "w_pa"
	pkg := permission.DefaultPackage("alice", "pp_alice")
	pkg.ConnectorAccounts = jsonempty.List[store.ConnectorAccountPermission]{
		{AccountID: f.account.ID, Level: level},
	}
	f.pkg = &pkg
	f.assistant = &store.PersonalAgent{
		UserID: "alice", WorkspaceID: "w_pa", HomeDeviceID: "d1", PermissionPackageID: pkg.ID,
	}
}

type fakeConfirmer struct {
	decision ConfirmationDecision
	denial   *Denial
	requests []ConfirmationRequest
}

func (c *fakeConfirmer) Review(_ context.Context, request ConfirmationRequest) (ConfirmationDecision, *Denial) {
	c.requests = append(c.requests, request)
	return c.decision, c.denial
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
	for _, status := range []string{"failed", "canceled"} {
		f := newFixture()
		f.session.Status = status
		f.serve("tk_good")
		if len(f.deleted) != 1 || f.deleted[0] != "g1" {
			t.Fatalf("%s: grants dropped: %v", status, f.deleted)
		}
	}
	f := newFixture()
	f.session.Status, f.session.CompletedAt = "completed", time.Now().UTC().Format(time.RFC3339Nano)
	f.session.ArchivedAt = f.session.CompletedAt
	f.serve("tk_good")
	if len(f.deleted) != 1 {
		t.Fatalf("an archived session kept its grant: %v", f.deleted)
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
	if _, err := f.pipe.Live(context.Background(), subject, "alice"); !errors.Is(err, ErrSessionIdle) {
		t.Fatalf("finished session: %v", err)
	}
	f = newFixture()
	f.account.WorkspaceIDs = nil
	if _, err := f.pipe.Live(context.Background(), subject, "alice"); !errors.Is(err, ErrAccessEnded) {
		t.Fatalf("unbound account: %v", err)
	}
}

func TestPersonalAgentLiveAllowsOwnedUnboundFeishuAccountUntilSwitchedOff(t *testing.T) {
	f := newFixture()
	f.pipe.Scheme.Provider = "feishu"
	f.account.Provider = "feishu"
	f.account.WorkspaceIDs = nil
	f.session.WorkspaceID = "w_pa"
	f.grant.WorkspaceID = "w_pa"
	pkg := permission.DefaultPackage("alice", "pp_alice")
	f.pkg = &pkg
	f.assistant = &store.PersonalAgent{UserID: "alice", WorkspaceID: "w_pa", HomeDeviceID: "d1", PermissionPackageID: pkg.ID}
	subject := Subject{SessionID: "s1", WorkspaceID: "w_pa", DeviceID: "d1", UserID: "alice", AccountID: "a1", AppID: "app1"}
	if _, err := f.pipe.Live(context.Background(), subject, "alice"); err != nil {
		t.Fatalf("unbound Personal Agent account: %v", err)
	}
	pkg.ConnectorAccounts = jsonempty.List[store.ConnectorAccountPermission]{{AccountID: f.account.ID, Level: store.ConnectorAccessLevelOff}}
	f.pkg = &pkg
	if _, err := f.pipe.Live(context.Background(), subject, "alice"); !errors.Is(err, ErrAccessEnded) {
		t.Fatalf("opted-out Personal Agent account: %v", err)
	}
}

func TestAssistantConnectorReadOnlyRefusesWrites(t *testing.T) {
	f := newFixture()
	f.enableAssistant(store.ConnectorAccessLevelRead)
	f.need = Need{Level: "write", Write: true}
	response := f.serve("tk_good")
	if response.Body.String() != "refused "+ReasonConnectorRead || f.outcome(t) != OutcomeRefused {
		t.Fatalf("read-only write = %q, %+v", response.Body.String(), f.records)
	}
	if strings.Contains(strings.Join(f.steps, ","), "upstream") {
		t.Fatal("a read-only connector write reached upstream")
	}
}

func TestAssistantConnectorOrdinaryWriteRunsWithoutConfirmation(t *testing.T) {
	f := newFixture()
	f.enableAssistant(store.ConnectorAccessLevelWrite)
	confirmer := &fakeConfirmer{}
	f.pipe.Confirm = confirmer
	f.need = Need{Level: "write", Write: true}
	if response := f.serve("tk_good"); response.Body.String() != "sent" {
		t.Fatalf("ordinary write = %q", response.Body.String())
	}
	if len(confirmer.requests) != 0 {
		t.Fatalf("ordinary write asked for confirmation: %+v", confirmer.requests)
	}
}

func TestAssistantRiskWriteWaitsForConfirmationThenRuns(t *testing.T) {
	f := newFixture()
	f.enableAssistant(store.ConnectorAccessLevelWrite)
	confirmer := &fakeConfirmer{decision: ConfirmationDecision{ProposalID: "proposal_1", Summary: "Change DNS"}}
	f.pipe.Confirm = confirmer
	f.need = Need{Level: "write", Write: true, Risk: "dns_change", RiskSummary: "Change DNS"}
	request := httptest.NewRequest(http.MethodDelete, "/x?zone=1", strings.NewReader(`{"name":"old"}`))
	response := f.serveRequest(request)
	if response.Body.String() != "refused "+ReasonNeedsConfirmation || f.outcome(t) != OutcomeRefused {
		t.Fatalf("pending confirmation = %q, %+v", response.Body.String(), f.records)
	}
	if strings.Contains(strings.Join(f.steps, ","), "upstream") || len(confirmer.requests) != 1 ||
		confirmer.requests[0].Fingerprint == "" || confirmer.requests[0].BodyDigest == "" {
		t.Fatalf("confirmation request = %+v, steps %v", confirmer.requests, f.steps)
	}

	f.steps = nil
	confirmer.decision = ConfirmationDecision{Approved: true, ProposalID: "proposal_1", Summary: "Change DNS"}
	request = httptest.NewRequest(http.MethodDelete, "/x?zone=1", strings.NewReader(`{"name":"old"}`))
	response = f.serveRequest(request)
	if response.Body.String() != "sent" || f.outcome(t) != OutcomeForwarded {
		t.Fatalf("accepted risk write = %q, %+v", response.Body.String(), f.records)
	}
}

func TestNonAssistantConnectorWriteIgnoresAssistantConfirmations(t *testing.T) {
	f := newFixture()
	confirmer := &fakeConfirmer{}
	f.pipe.Confirm = confirmer
	f.need = Need{Level: "write", Write: true, Risk: "delete", RiskSummary: "Delete"}
	if response := f.serve("tk_good"); response.Body.String() != "sent" {
		t.Fatalf("ordinary session write = %q", response.Body.String())
	}
	if len(confirmer.requests) != 0 {
		t.Fatalf("ordinary session asked for assistant confirmation: %+v", confirmer.requests)
	}
}

// claims is a NativeWork whose claims a test sets.
type claims map[string]time.Time

func (c claims) NativeWorkClaimedAt(deviceID, sessionID string) time.Time {
	return c[deviceID+"/"+sessionID]
}

// DEV-155: a completed session's grant lives while its device claims that
// the session's agent still works on its own (a background command, a
// timer, a turn it continues by itself), not just during a Foundry turn.
func TestACompletedSessionActsWhileItsDeviceClaimsItsNativeWork(t *testing.T) {
	now := time.Now()
	f := newFixture()
	work := claims{}
	f.pipe.Work, f.pipe.Now = work, func() time.Time { return now }
	f.session.Status, f.session.CompletedAt = "completed", now.Add(-time.Hour).UTC().Format(time.RFC3339Nano)

	// No claim: refused, but the grant stays for a claim to come back.
	if response := f.serve("tk_good"); response.Body.String() != "refused "+ReasonAccessEnded || len(f.deleted) != 0 {
		t.Fatalf("unclaimed: %q, deleted %v", response.Body.String(), f.deleted)
	}
	work["d1/s1"] = now.Add(-30 * time.Second)
	if response := f.serve("tk_good"); response.Body.String() != "sent" {
		t.Fatalf("claimed 30 s ago: %q", response.Body.String())
	}
	// Another device's claim, or the session's on another device, is not it.
	if response := f.serveAs("tk_good", Device{ID: "d2", OwnerUserID: "alice"}); response.Body.String() != "refused "+ReasonAccessEnded {
		t.Fatalf("other device: %q", response.Body.String())
	}
	delete(work, "d1/s1")
	work["d2/s1"] = now
	if response := f.serve("tk_good"); response.Body.String() != "refused "+ReasonAccessEnded {
		t.Fatalf("a claim from another device: %q", response.Body.String())
	}
	// The claim window passes.
	work["d1/s1"] = now.Add(-NativeWorkClaimWindow - time.Second)
	if response := f.serve("tk_good"); response.Body.String() != "refused "+ReasonAccessEnded || len(f.deleted) != 0 {
		t.Fatalf("stale claim: %q, deleted %v", response.Body.String(), f.deleted)
	}
	work["d1/s1"] = now
	if response := f.serve("tk_good"); response.Body.String() != "sent" {
		t.Fatalf("claimed again: %q", response.Body.String())
	}
	// Ends at once, and for good: archived, failed, canceled, gone, or
	// its turn ended longer ago than HeldSessionMaxIdle.
	for name, change := range map[string]func(*store.AgentSession){
		"archived": func(s *store.AgentSession) { s.ArchivedAt = now.UTC().Format(time.RFC3339Nano) },
		"failed":   func(s *store.AgentSession) { s.Status = "failed" },
		"canceled": func(s *store.AgentSession) { s.Status = "canceled" },
		"gone":     func(s *store.AgentSession) { s.ID = "s_other" },
		"max idle": func(s *store.AgentSession) {
			s.CompletedAt = now.Add(-HeldSessionMaxIdle - time.Minute).UTC().Format(time.RFC3339Nano)
		},
	} {
		saved := f.session
		change(&f.session)
		f.deleted = nil
		if response := f.serve("tk_good"); response.Body.String() != "refused "+ReasonAccessEnded || len(f.deleted) != 1 {
			t.Fatalf("%s: %q, deleted %v", name, response.Body.String(), f.deleted)
		}
		f.session = saved
	}
	// The account stopped or unbound, or the session moved: refused while
	// it is claimed.
	f.deleted = nil
	f.account.Status = store.ExternalAccountRevoked
	if response := f.serve("tk_good"); response.Body.String() != "refused "+ReasonAccessEnded {
		t.Fatalf("revoked account: %q", response.Body.String())
	}
	f.account.Status = store.ExternalAccountReady
	f.account.WorkspaceIDs = nil
	if response := f.serve("tk_good"); response.Body.String() != "refused "+ReasonAccessEnded {
		t.Fatalf("unbound account: %q", response.Body.String())
	}
	f.account.WorkspaceIDs = []string{"w1"}
	f.session.WorkspaceID = "w2"
	if response := f.serve("tk_good"); response.Body.String() != "refused "+ReasonAccessEnded {
		t.Fatalf("moved session: %q", response.Body.String())
	}
}

// DEV-154: a bundle rollout's check acts with the device owner's own
// account through a grant that names the check, not a session: live only
// while the check runs, on its device, for its owner and account, and the
// account still the owner's usable, server-held one. No workspace binding
// is needed, since no session uses the account.
func TestACheckGrantLivesOnlyWhileItsCheckRunsOnItsOwnersDevice(t *testing.T) {
	now := time.Now()
	setup := func() (*fixture, *Checks, Check) {
		f := newFixture()
		checks := NewChecks()
		checks.Now = func() time.Time { return now }
		f.pipe.Checks = checks
		check := checks.Begin("d1", "alice", "a1", 5*time.Minute)
		f.grant.SessionID, f.grant.WorkspaceID = check.ID, ""
		f.account.WorkspaceIDs = nil
		return f, checks, check
	}
	f, checks, check := setup()
	if !IsCheck(check.ID) || IsCheck("s1") {
		t.Fatalf("check id %q", check.ID)
	}
	if response := f.serve("tk_good"); response.Body.String() != "sent" {
		t.Fatalf("a running check: %q", response.Body.String())
	}
	if response := f.serveAs("tk_good", Device{ID: "d1", OwnerUserID: "bob"}); response.Body.String() == "sent" {
		t.Fatal("a check acted on a device another person owns")
	}
	checks.End(check.ID)
	if response := f.serve("tk_good"); response.Body.String() == "sent" {
		t.Fatal("an ended check still acts")
	}

	f, _, _ = setup()
	now = now.Add(6 * time.Minute)
	if response := f.serve("tk_good"); response.Body.String() == "sent" {
		t.Fatal("an expired check still acts")
	}
	now = time.Now()

	for name, change := range map[string]func(f *fixture){
		"another person's account":   func(f *fixture) { f.account.OwnerUserID = "bob" },
		"an account that needs auth": func(f *fixture) { f.account.Status = store.ExternalAccountNeedsReauth },
		"another account":            func(f *fixture) { f.grant.AccountID = "a2" },
		"no checks configured":       func(f *fixture) { f.pipe.Checks = nil },
	} {
		f, _, _ := setup()
		change(f)
		if response := f.serve("tk_good"); response.Body.String() == "sent" {
			t.Errorf("%s: the check acted", name)
		}
	}
}
