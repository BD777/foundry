// Package gateway is the one pipeline every server-held connector's requests
// go through: a session's tool talks to the connector's gateway with a
// stand-in credential, and the gateway decides, in a fixed order that a
// connector cannot reorder or skip, whether the request goes upstream:
//
//  1. authenticate  the stand-in's hash and the device credential give the
//     session's grant (common)
//  2. recheck       the session is still live on that device (SessionLive)
//     and its account still Permitted, and usable, for it (common)
//  3. Classify      which resource the request touches and which access level
//     it needs (connector)
//  4. decide        that against what the session holds: resource, level, the
//     level's scopes in the grant (common)
//  5. limit         the server's integrations switch and the token buckets
//     (common)
//  6. Upstream      the transport, streaming (connector)
//
// Whatever denies a request in 1 to 5 is worded by Refuse, in the vendor's
// error format with the structured foundry{…} part (connector). The audit
// line is written once for every request, however it ended (common).
//
// The connector supplies Classify, Refuse and Upstream (Provider); optional
// capabilities are found by type assertion, as in internal/externalaccounts:
// Entitlements (what the session holds, when more than "everything"),
// Entries (how a request enters) and LocalEndpoints (stand-in credential
// exchanges the connector answers itself, such as Feishu's tenant token
// call). Only the security skeleton is common: authentication, eligibility,
// the comparison, the refusal shell, the limits and the audit. Transport
// stays with each connector.
package gateway

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Device is the authenticated device a request came from.
type Device struct {
	ID          string
	OwnerUserID string
}

// Sessions reads the session a grant belongs to.
type Sessions interface {
	GetAgentSessionSummary(ctx context.Context, id string) (store.AgentSession, error)
}

// Grants keeps the session grants whose hashed stand-ins authenticate.
type Grants interface {
	FindFeishuGatewayGrant(ctx context.Context, kind, hash string) (store.FeishuGatewayGrant, error)
	DeleteFeishuGatewayGrant(ctx context.Context, id string) error
}

// Accounts reads the account and app a grant is for.
type Accounts interface {
	GetExternalAccount(ctx context.Context, id string) (store.ExternalAccount, error)
	GetExternalProviderApp(ctx context.Context, id string) (store.ExternalProviderApp, error)
}

// Scheme is how a connector's stand-in credentials look and last.
type Scheme struct {
	// Provider is the kind of account the grants are for ("feishu").
	Provider string
	// Kind names the kind of stand-in a handle is (store.FeishuHandle…),
	// or "" when it is none of this connector's.
	Kind func(handle string) string
	// Hash is what the grant stores for a handle.
	Hash func(handle string) string
	// Bearer are the kinds a forwarded call may carry in its Authorization.
	Bearer []string
	// Lifetime is how long after its issue a grant's stand-in works; zero
	// is as long as the session.
	Lifetime time.Duration
}

// Provider is what a connector supplies for each request.
type Provider interface {
	// Classify says which resource r touches and which access level it
	// needs. The returned Need is audited even when the request is denied;
	// a request the connector will never forward at all is a Denial.
	Classify(r *http.Request, lease *Lease) (Need, *Denial)
	// Refuse answers a denied request in the vendor's error format and
	// says what it told the caller, for the audit line.
	Refuse(w http.ResponseWriter, r *http.Request, denial *Denial) Refused
	// Upstream carries the request to the vendor with the account's real
	// credential. It may decline before sending anything by returning a
	// Denial; whatever it writes is the whole answer otherwise.
	Upstream(w http.ResponseWriter, r *http.Request, x *Exchange) *Denial
}

// Entitlements is an optional Provider capability: what the session holds
// of the account (zones and an access level), beyond the common checks.
type Entitlements interface {
	Holdings(ctx context.Context, lease *Lease) (Holdings, *Denial)
}

// Entry says how a request enters the pipeline; the default is a forwarded
// call whose stand-in is the Authorization bearer.
type Entry struct {
	// Handle is the stand-in the call presents, of one of Kinds.
	Handle string
	Kinds  []string
	// Grant is a grant already identified some other way (a single-use
	// ticket); Handle is then unused.
	Grant *store.FeishuGatewayGrant
	// Local: the connector answers this call itself (Answer), not Upstream.
	Local bool
	// Raw: the answer takes over the connection, so the response is not
	// wrapped and Exchange.Status says how it ended.
	Raw  bool
	Data any
	// Denial refuses the call before any credential is looked at.
	Denial *Denial
}

// Entries is an optional Provider capability: how each request enters the
// pipeline, where the default (a forwarded call whose stand-in is the
// Authorization bearer) does not fit. It may refuse a request before any
// credential is looked at, and may read the body if it puts it back.
type Entries interface {
	Enter(r *http.Request) Entry
}

// LocalEndpoints is an optional Provider capability: calls the connector
// answers itself, with stand-ins (Feishu's tenant token and user refresh
// calls, its event connection). Entries marks them Local.
type LocalEndpoints interface {
	// Answer replies to a local call whose grant was authenticated and
	// rechecked. It writes the answer itself, or returns a Denial.
	Answer(w http.ResponseWriter, r *http.Request, x *Exchange, entry Entry) *Denial
}

// Pipeline serves one connector's gateway.
type Pipeline struct {
	Scheme   Scheme
	Provider Provider
	Sessions Sessions
	Grants   Grants
	Accounts Accounts
	// Access resolves workspace bindings and the Personal Agent's connector
	// opt-out. A pipeline cannot recheck a session without it.
	Access externalaccounts.ConnectorAccessStore
	Audit  Sink
	// Levels order the access levels the connector knows, lowest first; a
	// request needing a level is allowed to a holder of that level or a
	// higher one. A level's Scopes must be in the account's grant.
	Levels []store.ExternalAccessLevel
	// Limits are taken in order before a request goes upstream.
	Limits []Limit
	// Checks are the tool version checks in progress whose grants act
	// for no session; nil allows none.
	Checks *Checks
	// Work says which completed sessions' agents still work on their own
	// on their devices (SessionLive); nil: none do.
	Work NativeWork
	// Unavailable, if set, says why nothing may be sent upstream now.
	Unavailable func() error
	Now         func() time.Time
	Logf        func(format string, args ...any)
}

func (p *Pipeline) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

func (p *Pipeline) logf(format string, args ...any) {
	if p.Logf != nil {
		p.Logf(format, args...)
	}
}

// Serve answers one request from an authenticated device. It is the only
// way a request reaches Upstream.
func (p *Pipeline) Serve(w http.ResponseWriter, r *http.Request, device Device) {
	started := p.now()
	entry := Entry{Handle: Bearer(r), Kinds: p.Scheme.Bearer}
	if entries, ok := p.Provider.(Entries); ok {
		entry = entries.Enter(r)
	}
	x := &Exchange{Device: device}
	body := &countingBody{ReadCloser: r.Body}
	writer := &countingWriter{ResponseWriter: w}
	if !entry.Raw {
		if r.Body != nil && r.Body != http.NoBody {
			r.Body = body
		}
		w = writer
	}
	var denial *Denial
	var refused Refused
	defer func() {
		record := Record{Request: r, Device: device, Lease: x.Lease, Need: x.Need, Denial: denial, Outcome: x.Outcome, Detail: x.Need.Detail, Status: x.Status, Started: started, Duration: p.now().Sub(started)}
		if x.Detail != nil {
			record.Detail = x.Detail
		}
		if !entry.Raw {
			record.Status, record.BytesIn, record.BytesOut = writer.status, body.n, writer.n
		}
		if denial != nil {
			record.Outcome, record.Message = denial.outcome(), refused.Message
			if entry.Raw {
				record.Status = refused.Status
			}
		}
		if p.Audit != nil {
			p.Audit.Record(r.Context(), record)
		}
	}()
	fail := func(d *Denial) {
		denial = d
		refused = p.Provider.Refuse(w, r, d)
	}

	if entry.Denial != nil {
		fail(entry.Denial)
		return
	}
	lease, d := p.authenticate(r.Context(), entry, device)
	if d != nil {
		fail(d)
		return
	}
	x.Lease = lease
	if entry.Local {
		local, ok := p.Provider.(LocalEndpoints)
		if !ok {
			fail(&Denial{Reason: ReasonInternal, Err: errors.New("a local entry for a connector that answers none")})
			return
		}
		if d := local.Answer(w, r, x, entry); d != nil {
			fail(d)
		}
		return
	}
	held, d := p.holdings(r.Context(), lease)
	if d != nil {
		fail(d)
		return
	}
	lease.Held = held
	need, d := p.Provider.Classify(r, lease)
	x.Need = need
	if d == nil {
		d = p.decide(lease, need)
	}
	if d == nil && p.Unavailable != nil {
		if err := p.Unavailable(); err != nil {
			d = &Denial{Reason: ReasonUnavailable, Message: err.Error(), Err: err}
		}
	}
	if d == nil {
		d = p.limit(lease)
	}
	if d != nil {
		fail(d)
		return
	}
	if d := p.Provider.Upstream(w, r, x); d != nil {
		fail(d)
		return
	}
	if x.Outcome == "" {
		x.Outcome = OutcomeForwarded
	}
}

// authenticate is step 1 and 2: the stand-in (or the grant it was already
// resolved to) on the device that runs its session, and the session and
// account rechecked.
func (p *Pipeline) authenticate(ctx context.Context, entry Entry, device Device) (*Lease, *Denial) {
	var grant store.FeishuGatewayGrant
	var kind string
	if entry.Grant != nil {
		grant = *entry.Grant
	} else {
		kind = p.Scheme.Kind(entry.Handle)
		if kind == "" || !slices.Contains(entry.Kinds, kind) {
			return nil, &Denial{Reason: ReasonNoCredential}
		}
		found, err := p.Grants.FindFeishuGatewayGrant(ctx, kind, p.Scheme.Hash(entry.Handle))
		if errors.Is(err, store.ErrNotFound) {
			return nil, &Denial{Reason: ReasonAccessEnded}
		}
		if err != nil {
			return nil, &Denial{Reason: ReasonInternal, Err: err}
		}
		grant = found
	}
	if device.ID == "" || grant.DeviceID != device.ID || grant.UserID != device.OwnerUserID {
		return nil, &Denial{Reason: ReasonAccessEnded}
	}
	lease, err := p.Live(ctx, Subject{SessionID: grant.SessionID, WorkspaceID: grant.WorkspaceID, DeviceID: grant.DeviceID, UserID: grant.UserID, AccountID: grant.AccountID, AppID: grant.AppID}, device.OwnerUserID)
	if errors.Is(err, ErrSessionEnded) {
		if deleteErr := p.Grants.DeleteFeishuGatewayGrant(ctx, grant.ID); deleteErr != nil {
			p.logf("gateway: drop the grant of ended session %s: %v", grant.SessionID, deleteErr)
		}
		return nil, &Denial{Reason: ReasonAccessEnded}
	}
	// A completed session whose agent has stopped working is refused, but
	// its grant stays: a claim that lapsed for a moment (a reconnect, a
	// restarted server) comes back with the next heartbeat. Prune drops it
	// once it can never be live again.
	if errors.Is(err, ErrAccessEnded) || errors.Is(err, ErrSessionIdle) {
		return nil, &Denial{Reason: ReasonAccessEnded}
	}
	if err != nil {
		return nil, &Denial{Reason: ReasonInternal, Err: err}
	}
	lease.Grant, lease.Kind, lease.Device = grant, kind, device
	if p.Scheme.Lifetime > 0 {
		created, err := time.Parse(time.RFC3339Nano, grant.CreatedAt)
		if err != nil || p.now().After(created.Add(p.Scheme.Lifetime)) {
			return nil, &Denial{Reason: ReasonHandleExpired}
		}
	}
	return lease, nil
}

// ErrSessionEnded: the session is gone, ended for good (failed, canceled,
// archived, past HeldSessionMaxIdle), or not the grant's.
var ErrSessionEnded = errors.New("session ended")

// ErrSessionIdle: the session's turn completed and nothing of its agent
// works on its device now; a new turn or the agent's own work (claimed
// again) makes it live.
var ErrSessionIdle = errors.New("session idle")

// NativeWork is what devices claim about the sessions whose agents still
// work on their own past a Foundry turn: background tasks, timers, a turn
// the agent continues by itself, a kept Codex app-server (DEV-155).
type NativeWork interface {
	// NativeWorkClaimedAt is when the device last claimed that the
	// session's agent still works there; zero if it never did, or not
	// since this server started.
	NativeWorkClaimedAt(deviceID, sessionID string) time.Time
}

// NativeWorkClaimWindow is how long a device's claim of a session's native
// work stands: a worker repeats it in every heartbeat (25 s), so a claim
// older than this means the work ended, or the worker stopped or lost the
// connection.
const NativeWorkClaimWindow = 2 * time.Minute

// HeldSessionMaxIdle is the longest a completed session's grants stay live
// after its last Foundry turn ended, however long its agent works on its
// own (a recurring timer can keep a process for days). The person's next
// message starts a turn with fresh grants.
const HeldSessionMaxIdle = 24 * time.Hour

// SessionLive says whether a session may act through a connector now: one
// in an active status (a Foundry turn is queued, running or blocked), or
// one whose turn completed while its agent still works on its own on the
// session's device: the device claimed it within NativeWorkClaimWindow,
// the session is not archived and its turn ended less than
// HeldSessionMaxIdle ago. Otherwise it answers ErrSessionIdle (completed,
// may come back) or ErrSessionEnded (for good). Device, owner and
// workspace are checked by the caller.
func SessionLive(session store.AgentSession, work NativeWork, now time.Time) error {
	if store.IsActiveSessionStatus(session.Status) {
		return nil
	}
	if session.Status != "completed" || session.ArchivedAt != "" {
		return ErrSessionEnded
	}
	if ended, err := time.Parse(time.RFC3339Nano, session.CompletedAt); err == nil && now.Sub(ended) > HeldSessionMaxIdle {
		return ErrSessionEnded
	}
	if work == nil {
		return ErrSessionIdle
	}
	claimed := work.NativeWorkClaimedAt(session.DeviceID, session.ID)
	if claimed.IsZero() || now.Sub(claimed) > NativeWorkClaimWindow {
		return ErrSessionIdle
	}
	return nil
}

// ErrAccessEnded: the account may no longer be used by that session.
var ErrAccessEnded = errors.New("this session's access through Foundry has ended (the session finished, or the account was stopped, removed or unbound); start a new session, or ask the person to check Connectors in Foundry")

// Subject names the session and account a grant (or a connection a gateway
// handed over) acts for.
type Subject struct {
	SessionID   string
	WorkspaceID string
	DeviceID    string
	// UserID started the session and owns the account.
	UserID    string
	AccountID string
	// AppID is the external provider app (xapp_…).
	AppID string
}

// Live is step 2: the session live (SessionLive) on the subject's device,
// the account Permitted for it (externalaccounts.Eligible: also usable now)
// by a device owned by deviceOwner. It answers ErrSessionEnded,
// ErrSessionIdle or ErrAccessEnded, or a store error.
func (p *Pipeline) Live(ctx context.Context, s Subject, deviceOwner string) (*Lease, error) {
	if IsCheck(s.SessionID) {
		return p.liveCheck(ctx, s, deviceOwner)
	}
	session, err := p.Sessions.GetAgentSessionSummary(ctx, s.SessionID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrSessionEnded
	}
	if err != nil {
		return nil, err
	}
	if session.DeviceID != s.DeviceID || session.CreatedByUserID != s.UserID {
		return nil, ErrSessionEnded
	}
	if err := SessionLive(session, p.Work, p.now()); err != nil {
		return nil, err
	}
	// A grant follows its session's workspace; the grant is not spent by a
	// session that moved, it simply is not valid there.
	if session.WorkspaceID != s.WorkspaceID {
		return nil, ErrAccessEnded
	}
	account, err := p.Accounts.GetExternalAccount(ctx, s.AccountID)
	if err != nil {
		return nil, ErrAccessEnded
	}
	if p.Access == nil {
		return nil, errors.New("gateway pipeline has no connector access store")
	}
	policy, err := externalaccounts.ResolvePolicy(ctx, p.Access, session.WorkspaceID, session.CreatedByUserID)
	if err != nil {
		return nil, err
	}
	if account.Provider != p.Scheme.Provider || account.AppID != s.AppID || !externalaccounts.EligibleFor(account, account.WorkspaceIDs, session.WorkspaceID, session.CreatedByUserID, deviceOwner, policy) {
		return nil, ErrAccessEnded
	}
	app, err := p.Accounts.GetExternalProviderApp(ctx, account.AppID)
	if err != nil {
		return nil, ErrAccessEnded
	}
	return &Lease{Session: session, Account: account, App: app}, nil
}

// liveCheck is step 2 for a check's grant: the check still in progress on
// the subject's device, by its owner, with that account, and the account
// the owner's own, server-held and usable (externalaccounts.CheckEligible).
// No workspace is involved: a check is not a session in one.
func (p *Pipeline) liveCheck(ctx context.Context, s Subject, deviceOwner string) (*Lease, error) {
	check, ok := p.Checks.Active(s.SessionID)
	if !ok || check.DeviceID != s.DeviceID || check.UserID != s.UserID || check.AccountID != s.AccountID {
		return nil, ErrSessionEnded
	}
	account, err := p.Accounts.GetExternalAccount(ctx, s.AccountID)
	if err != nil {
		return nil, ErrAccessEnded
	}
	if account.Provider != p.Scheme.Provider || account.AppID != s.AppID || !externalaccounts.CheckEligible(account, s.UserID, deviceOwner) {
		return nil, ErrAccessEnded
	}
	app, err := p.Accounts.GetExternalProviderApp(ctx, account.AppID)
	if err != nil {
		return nil, ErrAccessEnded
	}
	session := store.AgentSession{ID: s.SessionID, DeviceID: s.DeviceID, CreatedByUserID: s.UserID, Status: "running"}
	return &Lease{Session: session, Account: account, App: app}, nil
}

// holdings is what the session holds: the connector's own account of it
// when it has one, else everything its highest level gives.
func (p *Pipeline) holdings(ctx context.Context, lease *Lease) (Holdings, *Denial) {
	if e, ok := p.Provider.(Entitlements); ok {
		return e.Holdings(ctx, lease)
	}
	held := Holdings{GrantedScopes: lease.Account.GrantedScopes}
	if len(p.Levels) > 0 {
		held.Level = p.Levels[len(p.Levels)-1].Name
	}
	return held, nil
}

// decide is step 4, the comparison every connector gets the same way: the
// resource must be one the session holds, then the level, then the level's
// scopes in the grant.
func (p *Pipeline) decide(lease *Lease, need Need) *Denial {
	if need.Resource != "" && !slices.Contains(lease.Held.Resources, need.Resource) {
		return &Denial{Reason: ReasonNotBound, Resource: need.Resource, Current: lease.Held.Level}
	}
	if need.Otherwise != nil {
		return need.Otherwise
	}
	if need.Level == "" {
		return nil
	}
	rank := func(name string) int {
		return slices.IndexFunc(p.Levels, func(l store.ExternalAccessLevel) bool { return l.Name == name })
	}
	needed, held := rank(need.Level), rank(lease.Held.Level)
	if needed < 0 || held < needed {
		return &Denial{Reason: ReasonAccessLevel, Needed: need.Level, Current: lease.Held.Level}
	}
	var missing []string
	for _, scope := range p.Levels[needed].Scopes {
		if !slices.Contains(lease.Held.GrantedScopes, scope) {
			missing = append(missing, scope)
		}
	}
	if len(missing) > 0 {
		return &Denial{Reason: ReasonScopeMissing, Needed: need.Level, Current: lease.Held.Level, Missing: missing}
	}
	return nil
}

// limit is step 7's first half: a token from every limit, in order.
func (p *Pipeline) limit(lease *Lease) *Denial {
	now := p.now()
	for _, limit := range p.Limits {
		if allowed, wait := limit.Take(limit.Key(lease), now); !allowed {
			return &Denial{Reason: ReasonRateLimited, Wait: wait}
		}
	}
	return nil
}

// Bearer is the stand-in a request carries in its Authorization header.
func Bearer(r *http.Request) string {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(header) > 7 && strings.EqualFold(header[:7], "Bearer ") {
		return strings.TrimSpace(header[7:])
	}
	return ""
}
