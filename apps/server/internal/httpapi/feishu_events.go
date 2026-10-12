package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishuevents"
	"github.com/foundry-dev/foundry/apps/server/internal/integrations"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// feishuAppStore is what the server reads Feishu apps from: Connectors
// apps, which Workspace Bots run on too.
type feishuAppStore interface {
	store.ExternalAccountStore
	FeishuProviderAppsByClientID(ctx context.Context, clientID string) ([]store.ExternalProviderApp, error)
}

// wireFeishuEvents builds the server's one connection per Feishu app
// (feishuevents.Hub) and hands it to everything that receives events: the
// workspaces' bots, agents (the feishu_events tool) and the gateway's
// emulated event socket (feishu-cli event consume).
func (s *Server) wireFeishuEvents(st store.Store, sw *integrations.Switch) {
	appStore, ok := st.(feishuAppStore)
	if !ok {
		return
	}
	apps := feishuevents.ServerApps{Store: appStore, Secrets: s.secrets}
	hub := feishuevents.NewHub(apps, apps)
	hub.Integrations = sw
	hub.Bots = s.feishu
	hub.Receipts = st
	s.feishuEvents = hub
	s.feishu.Events, s.feishu.Credentials = hub, apps
	s.serveGatewayEvents()
}

// serveGatewayEvents has the gateway serve feishu-cli's event connection
// from the hub, rechecking each socket's access.
func (s *Server) serveGatewayEvents() {
	if s.feishuGateway != nil && s.feishuEvents != nil {
		s.feishuGateway.Events = feishuevents.GatewayEvents{Hub: s.feishuEvents, Recheck: s.feishuGateway.Authorized}
	}
}

// feishuSubscriber is who an MCP caller receives events for: an agent's
// session and the person who started it, or the person calling.
func (s *Server) feishuSubscriber(ctx context.Context, actor Actor) (feishuevents.Subscriber, error) {
	if actor.Agent() {
		session, err := s.store.GetAgentSessionSummary(ctx, actor.Identity.SessionID)
		if err != nil {
			return feishuevents.Subscriber{}, err
		}
		return feishuevents.Subscriber{SessionID: session.ID, UserID: session.CreatedByUserID, WorkspaceID: session.WorkspaceID}, nil
	}
	return feishuevents.Subscriber{UserID: actor.AccountID()}, nil
}

// feishuPollWait is how long a poll waits for the first event unless told.
const feishuPollWait = 60 * time.Second

// feishuEventsForMCP is the feishu_events tool: subscribe to a connected
// Feishu app's events, then read them by cursor, waiting for the next.
func (s *Server) feishuEventsForMCP(r *http.Request, actor Actor, args map[string]json.RawMessage) (string, error) {
	if s.feishuEvents == nil {
		return "", &mcpToolError{http.StatusServiceUnavailable, "this server does not receive Feishu events"}
	}
	ctx := r.Context()
	who, err := s.feishuSubscriber(ctx, actor)
	if err != nil {
		return "", err
	}
	id := mcpArgString(args, "subscriptionId")
	if mcpArgBool(args, "unsubscribe") {
		if id == "" {
			return "", &mcpToolError{http.StatusBadRequest, "name the subscriptionId to unsubscribe"}
		}
		if err := s.feishuEvents.Unsubscribe(who, id); err != nil {
			return "", &mcpToolError{http.StatusNotFound, err.Error()}
		}
		return encodeJSON(map[string]any{"subscriptionId": id, "unsubscribed": true})
	}
	wait := feishuPollWait
	if id == "" {
		subscription, err := s.feishuEvents.Subscribe(ctx, feishuevents.SubscribeInput{
			Who: who, AppID: mcpArgString(args, "appId"), EventTypes: mcpArgList(args, "eventTypes"), ChatID: mcpArgString(args, "chatId"),
		})
		if errors.Is(err, integrations.ErrOff) {
			return "", &mcpToolError{http.StatusServiceUnavailable, err.Error()}
		}
		if err != nil {
			return "", &mcpToolError{http.StatusBadRequest, err.Error()}
		}
		id, wait = subscription.ID, 0
	}
	if raw, ok := args["timeoutMs"]; ok {
		var milliseconds float64
		if json.Unmarshal(raw, &milliseconds) == nil {
			wait = time.Duration(min(max(milliseconds, 0), maxMCPWaitMs)) * time.Millisecond
		}
	}
	var cursor *uint64
	if raw, ok := args["cursor"]; ok {
		var value float64
		if json.Unmarshal(raw, &value) == nil && value >= 0 {
			at := uint64(value)
			cursor = &at
		}
	}
	batch, err := s.feishuEvents.Poll(ctx, who, id, cursor, mcpArgNumber(args, "maxEvents", 50), wait)
	if errors.Is(err, feishuevents.ErrUnknownSubscription) {
		return "", &mcpToolError{http.StatusNotFound, err.Error()}
	}
	if err != nil {
		return "", err
	}
	return encodeJSON(batch)
}
