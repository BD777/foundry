package feishugateway

import (
	"context"
	"net/http"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// auditLines is the pipeline's audit (gateway.Sink): one line per request,
// without bodies, in the gateway's request table.
type auditLines struct{ g *Gateway }

func (a auditLines) Record(ctx context.Context, record gateway.Record) {
	r := record.Request
	line := store.FeishuGatewayRequest{
		At: record.Started.UTC().Format(time.RFC3339Nano), Method: r.Method, Path: pathTemplate(pathOf(r)),
		// Until a handle names the session, the call is the device owner's.
		DeviceID: record.Device.ID, UserID: record.Device.OwnerUserID,
		Status: record.Status, BytesIn: record.BytesIn, BytesOut: record.BytesOut,
		DurationMS: record.Duration.Milliseconds(), Outcome: record.Outcome,
	}
	if line.Outcome == "" {
		line.Outcome = gateway.OutcomeRefused
	}
	grant := record.Grant
	if record.Lease != nil {
		grant = &record.Lease.Grant
	}
	if grant != nil {
		line.UserID, line.SessionID, line.WorkspaceID = grant.UserID, grant.SessionID, grant.WorkspaceID
		line.AccountID, line.AppID = grant.AccountID, grant.AppID
	}
	line.Identity = identityOf(r, record.Lease != nil)
	if err := a.g.store.AppendFeishuGatewayRequest(context.WithoutCancel(ctx), line); err != nil {
		a.g.logf("feishu gateway: audit %s %s: %v", line.Method, line.Path, err)
	}
}

// identityOf is what the call acted as: "user" or "bot" by the token it
// carries (a forwarded call, whatever came of it), "user" for a refresh the
// gateway authenticated, and "" for what it answered without acting.
func identityOf(r *http.Request, authenticated bool) string {
	switch routeOf(r) {
	case routeForward:
		switch handleKind(bearer(r)) {
		case store.FeishuHandleUser:
			return "user"
		case store.FeishuHandleTenant:
			return "bot"
		}
	case routeRefresh:
		if authenticated {
			return "user"
		}
	}
	return ""
}
