package connectors

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The Cloudflare connector of the gateway pipeline (internal/gateway): it
// says what a request touches (a zone and an access level), what a refusal
// looks like in Cloudflare's error format, and how a call reaches
// Cloudflare (through the official MCP's execute tool). Authentication, the
// session and account recheck, the comparison, the limit and the audit lines
// are the pipeline's.

// maxCloudflareBody is the largest body the gateway forwards (a DNS record).
const maxCloudflareBody = 16 * 1024

// cloudflareCall is Classify's reading of a request, handed to Upstream.
type cloudflareCall struct {
	method string
	path   string
	query  url.Values
	// body is a change's body, read once, at most maxCloudflareBody+1 bytes.
	body      json.RawMessage
	zone      string
	rest      []string
	zeroTrust *cloudflareZeroTrustCall
}

// cloudflarePath is the Cloudflare API path a gateway request names: below
// the gateway prefix, without the client/v4 cf adds.
func cloudflarePath(r *http.Request) string {
	path := strings.TrimPrefix(r.URL.Path, CloudflareGatewayPath)
	return strings.TrimPrefix("/"+strings.TrimPrefix(path, "/"), "/client/v4")
}

func asDenial(err error) *gateway.Denial {
	var refusal *CloudflareRefusal
	if errors.As(err, &refusal) {
		return &gateway.Denial{Reason: refusal.Reason, Message: refusal.Message, Needed: refusal.Needed, Current: refusal.Current}
	}
	if errors.Is(err, ErrCloudflareAccess) {
		return &gateway.Denial{Reason: gateway.ReasonAccessEnded}
	}
	return &gateway.Denial{Reason: gateway.ReasonInternal, Err: err}
}

// Enter (gateway.Entries): a change's body is read once, here, so one larger
// than a DNS record is refused before anything is looked at (and, as the
// call never authenticated, leaves no line in an account's activity); the
// body is put back for Classify.
func (g *CloudflareGateway) Enter(r *http.Request) gateway.Entry {
	entry := gateway.Entry{Handle: gateway.Bearer(r), Kinds: g.pipeline.Scheme.Bearer}
	if r.Method == http.MethodGet || r.Body == nil || r.Body == http.NoBody {
		return entry
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxCloudflareBody+1))
	_ = r.Body.Close()
	r.Body = io.NopCloser(bytes.NewReader(raw))
	if err != nil || len(raw) > maxCloudflareBody {
		entry.Denial = &gateway.Denial{Reason: RefusalBadRequest, Message: "the body is larger than 16 KiB"}
	}
	return entry
}

// cloudflareClassifyBody reads a change once for classification and puts it
// back for the confirmation service's exact-request digest.
func cloudflareClassifyBody(r *http.Request) json.RawMessage {
	if r.Body == nil || r.Body == http.NoBody {
		return nil
	}
	raw, _ := io.ReadAll(io.LimitReader(r.Body, maxCloudflareBody))
	_ = r.Body.Close()
	r.Body = io.NopCloser(bytes.NewReader(raw))
	return raw
}

// Holdings (gateway.Entitlements): the zones the session's workspace bound
// to the grant's account, and the access level it set.
func (g *CloudflareGateway) Holdings(ctx context.Context, lease *gateway.Lease) (gateway.Holdings, *gateway.Denial) {
	bound, err := g.bindingFor(ctx, lease.Session, lease.Grant.DeviceID, lease.Device.OwnerUserID, lease.Account.ID)
	if err != nil {
		return gateway.Holdings{}, asDenial(err)
	}
	if bound.account.ID != lease.Account.ID {
		return gateway.Holdings{}, &gateway.Denial{Reason: gateway.ReasonAccessEnded}
	}
	level := accessOf(bound.binding)
	resources := append([]string(nil), bound.binding.ResourceIDs...)
	if level == externalaccounts.CloudflareAccessZeroTrust {
		resources = append(resources, g.zeroTrustAccountIDs(ctx, lease, bound)...)
	}
	return gateway.Holdings{Level: level, Resources: resources, GrantedScopes: lease.Account.GrantedScopes}, nil
}

// Classify (gateway.Provider): zone reads need the read level, zone changes
// need the level whose rules allow them, and account-level Zero Trust calls
// need the zero_trust level for an account one of the bound zones belongs to.
func (g *CloudflareGateway) Classify(r *http.Request, lease *gateway.Lease) (gateway.Need, *gateway.Denial) {
	method, path, query := strings.ToUpper(r.Method), cloudflarePath(r), r.URL.Query()
	call := &cloudflareCall{method: method, path: path, query: query}
	need := gateway.Need{Payload: call}
	zeroTrust, knownZeroTrust := classifyCloudflareZeroTrust(method, path)
	if knownZeroTrust || strings.HasPrefix(path, "/accounts/") {
		if !knownZeroTrust {
			if method != http.MethodGet {
				need.Write = true
				need.Detail = &CloudflareWriteDetail{WorkspaceID: lease.Session.WorkspaceID, Method: method, Path: cloudflareWriteAuditPath(path), Result: "refused"}
			}
			return need, &gateway.Denial{Reason: RefusalPathNotAllowed, Message: method + " " + cloudflareWriteAuditPath(path) + " is outside what Foundry's Cloudflare Zero Trust access allows"}
		}
		call.zeroTrust = &zeroTrust
		need.Level = externalaccounts.CloudflareAccessZeroTrust
		need.Resource = zeroTrust.account
		need.Write = zeroTrust.write
		if zeroTrust.write {
			detail := &CloudflareWriteDetail{WorkspaceID: lease.Session.WorkspaceID, Method: method, Path: cloudflareWriteAuditPath(path), Result: "refused"}
			need.Detail = detail
			need.Risk = "cloudflare_zero_trust_write"
			need.RiskSummary = "The assistant wants to change Cloudflare Zero Trust (" + method + " " + cloudflareWriteAuditPath(path) + ")."
			call.body = cloudflareClassifyBody(r)
		}
		if method == http.MethodGet {
			if err := validateCloudflareZeroTrustRead(path, query); err != nil {
				return need, asDenial(err)
			}
		} else {
			if len(query) > 0 {
				return need, &gateway.Denial{Reason: RefusalQueryNotAllow, Message: method + " takes no query parameters; put the fields in the JSON body"}
			}
			if err := validateCloudflareZeroTrustWrite(method, path); err != nil {
				return need, asDenial(err)
			}
		}
		return need, nil
	}
	if method == http.MethodGet {
		if err := validateCloudflareRead(path, query); err != nil {
			return need, asDenial(err)
		}
		need.Level = externalaccounts.CloudflareAccessRead
		if path != "/zones" {
			call.zone = strings.Split(strings.TrimPrefix(path, "/"), "/")[1]
			need.Resource = call.zone
		}
		return need, nil
	}

	detail := &CloudflareWriteDetail{WorkspaceID: lease.Session.WorkspaceID, Method: method, Path: cloudflareWriteAuditPath(path), Result: "refused"}
	need.Detail = detail
	need.Write = true
	need.Risk = "dns_change"
	need.RiskSummary = "The assistant wants to change DNS in Cloudflare (" + method + " " + cloudflareWriteAuditPath(path) + ")."
	raw := cloudflareClassifyBody(r)
	call.body = raw
	// A refused attempt names the record it was for, too.
	var attempted map[string]any
	if len(raw) <= maxCloudflareBody && json.Unmarshal(raw, &attempted) == nil {
		detail.RecordName, detail.RecordType, detail.Content = recordFields(attempted)
	}
	if len(query) > 0 {
		return need, &gateway.Denial{Reason: RefusalQueryNotAllow, Message: method + " takes no query parameters; put the fields in the JSON body"}
	}
	switch method {
	case http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete:
	default:
		return need, &gateway.Denial{Reason: RefusalBadRequest, Message: fmt.Sprintf("method %s is not supported; use GET, POST, PATCH, PUT or DELETE", method)}
	}
	if strings.ContainsAny(path, "\\%?#\x00\r\n") || strings.Contains(path, "..") {
		return need, &gateway.Denial{Reason: RefusalPathNotAllowed, Message: "the path holds characters Foundry does not forward"}
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) < 3 || parts[0] != "zones" || !cloudflareZoneID.MatchString(parts[1]) {
		return need, &gateway.Denial{Reason: RefusalPathNotAllowed, Message: fmt.Sprintf("%s %s is outside what a workspace's Cloudflare access allows. DNS edit allows %s in the workspace's bound zones; other changes stay with the person in the Cloudflare dashboard", method, cloudflareWriteAuditPath(path), cloudflareDNSEditPaths)}
	}
	call.zone, call.rest = parts[1], parts[2:]
	need.Resource = call.zone
	// The level whose rules allow the change; the session's own is the one
	// asked first.
	levels := []string{lease.Held.Level}
	for name := range cloudflareWriteRules {
		levels = append(levels, name)
	}
	for _, name := range levels {
		if allows := cloudflareWriteRules[name]; allows != nil && allows(method, call.rest) {
			need.Level = name
			return need, nil
		}
	}
	need.Otherwise = &gateway.Denial{Reason: RefusalPathNotAllowed, Current: lease.Held.Level, Message: fmt.Sprintf("%s %s is outside what a workspace's Cloudflare access allows. DNS edit allows %s; other changes stay with the person in the Cloudflare dashboard", method, cloudflareWriteAuditPath(path), cloudflareDNSEditPaths)}
	return need, nil
}

// Refuse (gateway.Provider) answers a denied request in Cloudflare's
// error shape, with Foundry's structured "foundry" part.
func (g *CloudflareGateway) Refuse(w http.ResponseWriter, r *http.Request, d *gateway.Denial) gateway.Refused {
	var err error
	refusal := &CloudflareRefusal{Message: d.Message, Reason: d.Reason, Needed: d.Needed, Current: d.Current}
	method, path := strings.ToUpper(r.Method), cloudflarePath(r)
	switch d.Reason {
	case gateway.ReasonNoCredential, gateway.ReasonAccessEnded:
		err = ErrCloudflareAccess
	case gateway.ReasonHandleExpired:
		err = ErrCloudflareHandleExpired
	case gateway.ReasonInternal:
		err = d.Err
	case gateway.ReasonNotBound:
		refusal.Reason, refusal.Current = RefusalNotBound, ""
		refusal.Message = "that zone is not bound to this workspace; the account owner binds zones in Connectors → this workspace → Cloudflare"
	case gateway.ReasonAccessLevel:
		refusal.Reason = RefusalAccessLevel
		refusal.Message = fmt.Sprintf("%s %s needs the %s access level; this workspace's Cloudflare binding has %s access, and %s", method, cloudflareWriteAuditPath(path), d.Needed, d.Current, cloudflareAccessWhere)
	case gateway.ReasonConnectorOff:
		refusal.Message = "the person did not give the assistant access to this Cloudflare account; they change that in Assistant settings → Connectors"
	case gateway.ReasonConnectorRead:
		refusal.Message = "the assistant has read-only access to this Cloudflare account; this change needs write access in Assistant settings → Connectors"
	case gateway.ReasonNeedsConfirmation:
		refusal.Message = d.Summary + " Accept proposal " + d.ProposalID + " before repeating this exact request."
	case gateway.ReasonScopeMissing:
		refusal.Reason, refusal.Needed = RefusalScopeMissing, d.Current
		refusal.Message = fmt.Sprintf("this workspace has %s access, but the Cloudflare authorization no longer includes %s; the account owner re-authorizes in Connectors → Cloudflare", d.Current, strings.Join(d.Missing, ", "))
	case gateway.ReasonRateLimited:
		seconds := strconv.Itoa(int(d.Wait/time.Second) + 1)
		w.Header().Set("Retry-After", seconds)
		refusal.Message = "too many Cloudflare calls from this session; slow down"
	case gateway.ReasonUnavailable:
		refusal.Message = d.Message
	}
	if err == nil {
		err = refusal
	}
	return writeCloudflareGatewayError(w, err, d.Reason)
}

// Upstream (gateway.Provider) sends the request through the official
// Cloudflare MCP with the account's real token: a read as a read, a change
// after its body is checked.
func (g *CloudflareGateway) Upstream(w http.ResponseWriter, r *http.Request, x *gateway.Exchange) *gateway.Denial {
	call := x.Need.Payload.(*cloudflareCall)
	lease := x.Lease
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	use := externalaccounts.Use{SessionID: lease.Grant.SessionID, DeviceID: x.Device.ID, By: "session"}
	account := lease.Account
	if call.method == http.MethodGet {
		var result json.RawMessage
		var err error
		if call.path == "/zones" {
			result, err = g.listZones(ctx, account, lease.Held.Resources, call.query, use)
		} else {
			result, err = g.accounts.CloudflareRead(ctx, account, call.path, call.query, use)
		}
		if err != nil {
			x.Outcome = gateway.OutcomeUpstreamError
			writeCloudflareGatewayError(w, err, "")
			return nil
		}
		writeCloudflareResult(w, result)
		return nil
	}

	detail := x.Need.Detail.(*CloudflareWriteDetail)
	var body map[string]any
	var err error
	if call.zeroTrust != nil {
		body, err = cloudflareZeroTrustBody(call.method, call.body)
		if err != nil {
			return asDenial(err)
		}
	} else {
		detail.ZoneID = call.zone
		if len(call.rest) == 2 {
			detail.RecordID = call.rest[1]
		}
		body, err = cloudflareWriteBody(call.method, call.body)
		if err != nil {
			return asDenial(err)
		}
		detail.RecordName, detail.RecordType, detail.Content = recordFields(body)
		if call.method == http.MethodDelete {
			// The log names what was removed, not only its id.
			if before, e := g.accounts.CloudflareRead(ctx, account, call.path, nil, use); e == nil {
				detail.RecordName, detail.RecordType, detail.Content = recordFields(resultObject(before))
			}
		}
	}
	result, err := g.accounts.CloudflareRequest(ctx, account, call.method, call.path, nil, body, use)
	detail.Result = "failed"
	if err != nil {
		x.Outcome = gateway.OutcomeUpstreamError
		detail.Error = shortError(err)
		writeCloudflareGatewayError(w, err, "")
		return nil
	}
	var answer struct {
		Success bool                                  `json:"success"`
		Errors  []externalaccounts.CloudflareAPIError `json:"errors"`
	}
	_ = json.Unmarshal(result, &answer)
	if !answer.Success {
		for _, e := range answer.Errors {
			detail.Error = strings.TrimPrefix(detail.Error+fmt.Sprintf("; %d: %s", e.Code, e.Message), "; ")
		}
		if detail.Error == "" {
			detail.Error = "Cloudflare did not report success"
		}
		if call.zeroTrust != nil && cloudflareZeroTrustResponseHasSecret(call.method, call.path) {
			result = redactCloudflareClientSecrets(result)
		}
		writeCloudflareResult(w, result)
		return nil
	}
	detail.Result = "succeeded"
	if call.zeroTrust != nil {
		if cloudflareZeroTrustResponseHasSecret(call.method, call.path) {
			result = redactCloudflareClientSecrets(result)
		}
		writeCloudflareResult(w, result)
		return nil
	}
	if name, kind, content := recordFields(resultObject(result)); name != "" {
		detail.RecordName, detail.RecordType, detail.Content = name, kind, content
	}
	writeCloudflareResult(w, result)
	return nil
}

// writeCloudflareResult answers with Cloudflare's own answer; one that
// reports success:false is a 400.
func writeCloudflareResult(w http.ResponseWriter, result json.RawMessage) {
	status := http.StatusOK
	var answer struct {
		Success *bool `json:"success"`
	}
	if json.Unmarshal(result, &answer) == nil && answer.Success != nil && !*answer.Success {
		status = http.StatusBadRequest
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(result)
}

// writeCloudflareGatewayError answers in Cloudflare's own shape. A request
// Foundry refused says so in "foundry" (why, which level would allow it,
// where the person sets it); a failure of Cloudflare's own passes its error
// codes and messages through, and its HTTP status when the tool reported it.
func writeCloudflareGatewayError(w http.ResponseWriter, err error, reason string) gateway.Refused {
	status, errs := http.StatusBadGateway, []any{}
	var refusal *CloudflareRefusal
	var upstream *externalaccounts.CloudflareRequestError
	body := map[string]any{"success": false, "messages": []any{}, "result": nil}
	switch {
	case errors.Is(err, ErrCloudflareHandleExpired):
		status = http.StatusUnauthorized
	case errors.As(err, &refusal):
		status = http.StatusForbidden
		switch reason {
		case gateway.ReasonRateLimited:
			status = http.StatusTooManyRequests
		case gateway.ReasonUnavailable:
			status = http.StatusServiceUnavailable
		}
		body["foundry"] = refusal.Foundry()
	case errors.Is(err, ErrCloudflareAccess):
		status = http.StatusForbidden
		body["foundry"] = (&CloudflareRefusal{Reason: RefusalNoGrant}).Foundry()
	case errors.As(err, &upstream):
		if upstream.APIStatus >= 400 && upstream.APIStatus <= 599 {
			status = upstream.APIStatus
		}
		for _, e := range upstream.API {
			errs = append(errs, map[string]any{"code": e.Code, "message": e.Message})
		}
	}
	if len(errs) == 0 {
		errs = append(errs, map[string]any{"code": status, "message": err.Error()})
	}
	body["errors"] = errs
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
	return gateway.Refused{Status: status, Message: err.Error()}
}

// cloudflareAudit is the pipeline's audit (gateway.Sink): a read is a line
// of the account's activity, a change a line with the record it concerned.
// A call whose stand-in named no grant of its device names no account and
// has no line.
type cloudflareAudit struct{ g *CloudflareGateway }

func (a cloudflareAudit) Record(ctx context.Context, record gateway.Record) {
	grant := record.Grant
	if record.Lease != nil {
		grant = &record.Lease.Grant
	}
	if grant == nil {
		return
	}
	r := record.Request
	event := store.ExternalAccountEvent{SessionID: grant.SessionID, DeviceID: grant.DeviceID, ActorID: record.Device.OwnerUserID}
	if detail, ok := record.Detail.(*CloudflareWriteDetail); ok {
		if record.Denial != nil && detail.Error == "" {
			detail.Error = shortError(errors.New(cmp.Or(record.Message, record.Denial.Message)))
		}
		line, _ := json.Marshal(detail)
		event.Kind, event.Detail = CloudflareWriteEvent, string(line)
	} else {
		outcome := "forwarded"
		switch {
		case record.Denial != nil:
			outcome = "refused"
		case record.Outcome == gateway.OutcomeUpstreamError:
			outcome = "upstream_error"
		}
		event.Kind, event.Detail = "cloudflare_request", "GET "+cloudflareAuditPath(cloudflarePath(r))+" "+outcome
	}
	a.g.audit(ctx, grant.AccountID, event)
}
