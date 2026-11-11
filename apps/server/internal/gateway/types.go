package gateway

import (
	"context"
	"io"
	"net/http"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Lease is what steps 1 and 2 establish: the grant a request was
// authenticated with, and the session, account and app it was rechecked
// against just now.
type Lease struct {
	Grant   store.FeishuGatewayGrant
	Session store.AgentSession
	Account store.ExternalAccount
	App     store.ExternalProviderApp
	Device  Device
	// Kind is the kind of stand-in the call presented ("" for a grant
	// found by a ticket).
	Kind string
	// Held is what the session holds of the account.
	Held Holdings
}

// Holdings are what a session may touch of its account.
type Holdings struct {
	// Level is the access level the session holds.
	Level string
	// Resources are the things (Cloudflare zones) it holds; a connector
	// that has none leaves them empty and its requests name no resource.
	Resources []string
	// GrantedScopes are the scopes the account's authorization holds.
	GrantedScopes []string
}

// Need is what Classify found a request to touch.
type Need struct {
	// Resource must be one of the session's Holdings.Resources; "" for a
	// request that names none.
	Resource string
	// Level is the lowest access level that allows the request; "" needs none.
	Level string
	// Write says the request changes something upstream. The assistant's
	// permission package must be write for it.
	Write bool
	// Risk marks a write that needs the person's confirmation before it runs.
	// Empty means the write is ordinary.
	Risk string
	// RiskSummary is what the confirmation card says the call will do.
	RiskSummary string
	// Otherwise is the denial that stands when the resource is held: a
	// request no level allows (its resource is still checked first, so a
	// caller learns of a resource it does not hold before anything else).
	Otherwise *Denial
	// Payload is what Upstream gets back of Classify's reading of the
	// request (a body read once, a parsed path).
	Payload any
	// Detail is the connector's own audit detail for the request. It is
	// written even when the request is denied.
	Detail any
}

// Exchange is one request as the connector's Upstream and Answer see it.
type Exchange struct {
	Device Device
	Lease  *Lease
	Need   Need
	// Outcome is how the call ended, if not OutcomeForwarded: the connector
	// sets it (upstream_error, local).
	Outcome string
	// Detail replaces Need.Detail in the audit line when set.
	Detail any
	// Status is how a Raw call ended (its response is not wrapped).
	Status int
}

// How a call ended, as the audit says.
const (
	OutcomeForwarded     = "forwarded"
	OutcomeLocal         = "local"
	OutcomeBlocked       = "blocked"
	OutcomeRefused       = "refused"
	OutcomeRateLimited   = "rate_limited"
	OutcomeUnavailable   = "unavailable"
	OutcomeUpstreamError = "upstream_error"
)

// Why a call was denied. A connector's Refuse words each in its vendor's
// format; Classify adds its own reasons beyond the common ones.
const (
	// ReasonNoCredential: the call carries no stand-in of this connector's.
	ReasonNoCredential = "no_credential"
	// ReasonAccessEnded: the stand-in names no live access.
	ReasonAccessEnded = "access_ended"
	// ReasonHandleExpired: the stand-in is older than its lifetime.
	ReasonHandleExpired = "handle_expired"
	// ReasonNoGrant: the session holds nothing of the account here.
	ReasonNoGrant = "no_grant"
	// ReasonNotBound: the request names a resource the session does not hold.
	ReasonNotBound = "not_bound"
	// ReasonAccessLevel: the session's level is below the request's.
	ReasonAccessLevel = "access_level"
	// ReasonScopeMissing: the level is held but the grant lost its scopes.
	ReasonScopeMissing = "scope_missing"
	// ReasonBlocked: the connector never forwards this request.
	ReasonBlocked        = "blocked"
	ReasonPathNotAllowed = "path_not_allowed"
	ReasonQueryNotAllow  = "query_not_allowed"
	ReasonBadRequest     = "bad_request"
	ReasonRateLimited    = "rate_limited"
	ReasonUnavailable    = "unavailable"
	ReasonConnectorOff   = "connector_off"
	ReasonConnectorRead  = "connector_read_only"
	// ReasonNeedsConfirmation: the assistant may write, but this risk write
	// waits for the person to accept the proposal named by ProposalID.
	ReasonNeedsConfirmation = "needs_confirmation"
	// ReasonInternal: the check itself failed (Err says how).
	ReasonInternal = "internal"
)

// Denial is a request the pipeline did not send. Message is the connector's
// own wording when it has one; Refuse words the rest from the fields.
type Denial struct {
	Reason  string
	Message string
	// Needed is the level that would allow the request, Current the one
	// the session holds.
	Needed  string
	Current string
	// Resource is the one the session does not hold; Missing the scopes
	// its level needs that the grant lacks.
	Resource string
	Missing  []string
	// Wait is how long until a rate-limited call may be made.
	Wait time.Duration
	// ProposalID and Summary name the confirmation card for a risk write.
	ProposalID string
	Summary    string
	ExpiresAt  string
	Err        error
}

// ConfirmationRequest is a risk write one assistant asked to make.
type ConfirmationRequest struct {
	Lease *Lease
	Need  Need
	// Method, Path, Query and BodyDigest identify the exact call the person
	// is approving.
	Method      string
	Path        string
	Query       string
	BodyDigest  string
	Fingerprint string
	Summary     string
}

// ConfirmationDecision says whether the exact request was accepted. Pending
// proposals are returned with Approved false so the caller can be told which
// card is waiting.
type ConfirmationDecision struct {
	Approved   bool
	ProposalID string
	Summary    string
	ExpiresAt  string
}

// Confirmer creates or consumes one risk write's confirmation. Review must be
// idempotent while a proposal is pending and consume an accepted proposal at
// most once.
type Confirmer interface {
	Review(context.Context, ConfirmationRequest) (ConfirmationDecision, *Denial)
}

func (d *Denial) outcome() string {
	switch d.Reason {
	case ReasonBlocked:
		return OutcomeBlocked
	case ReasonRateLimited:
		return OutcomeRateLimited
	case ReasonUnavailable:
		return OutcomeUnavailable
	}
	return OutcomeRefused
}

// Refused is what Refuse told the caller.
type Refused struct {
	Status  int
	Message string
}

// Record is one request as the audit sees it, written however it ended.
type Record struct {
	Request *http.Request
	Device  Device
	// Lease is nil when the call was never authenticated.
	Lease  *Lease
	Need   Need
	Denial *Denial
	// Message is what a denied caller was told.
	Message string
	Outcome string
	Status  int
	BytesIn int64
	// BytesOut counts the body written.
	BytesOut int64
	Detail   any
	Started  time.Time
	Duration time.Duration
}

// Sink writes the audit line of a call.
type Sink interface {
	Record(ctx context.Context, record Record)
}

// Limit is a token bucket per key, taken before a call goes upstream.
type Limit struct {
	Key  func(*Lease) string
	Take func(key string, now time.Time) (bool, time.Duration)
}

type countingBody struct {
	io.ReadCloser
	n int64
}

func (b *countingBody) Read(p []byte) (int, error) {
	if b.ReadCloser == nil {
		return 0, io.EOF
	}
	n, err := b.ReadCloser.Read(p)
	b.n += int64(n)
	return n, err
}

type countingWriter struct {
	http.ResponseWriter
	status int
	n      int64
}

func (c *countingWriter) WriteHeader(status int) {
	if c.status == 0 && status >= 200 {
		c.status = status
	}
	c.ResponseWriter.WriteHeader(status)
}

func (c *countingWriter) Write(p []byte) (int, error) {
	if c.status == 0 {
		c.status = http.StatusOK
	}
	n, err := c.ResponseWriter.Write(p)
	c.n += int64(n)
	return n, err
}

func (c *countingWriter) Flush() {
	if flusher, ok := c.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (c *countingWriter) Unwrap() http.ResponseWriter { return c.ResponseWriter }
