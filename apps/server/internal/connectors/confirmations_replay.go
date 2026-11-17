package connectors

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/gateway"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// ReplayConfirmedWrite sends the exact request a person allowed (DEV-265),
// once: the proposal's pending->accepted transition is the guard, so a
// second click or a retry never sends again, and an expired proposal is
// refused. It reports a factual detail for the requesting session, e.g.
// "message id om_…".
func (g *ExtensionGateway) ReplayConfirmedWrite(ctx context.Context, proposal store.PersonalAgentProposal) (string, error) {
	var spec ConnectorConfirmationSpec
	if err := json.Unmarshal(proposal.Spec, &spec); err != nil {
		return "", errors.New("the proposal holds no readable connector request")
	}
	if spec.AccountID == "" || spec.Method == "" || spec.Path == "" {
		return "", errors.New("the proposal holds no connector request")
	}
	if proposal.ExpiresAt != "" {
		expires, err := time.Parse(time.RFC3339Nano, proposal.ExpiresAt)
		if err != nil || g.Now().After(expires) {
			return "", errors.New("the proposal expired before the answer was recorded")
		}
	}
	session, err := g.store.GetAgentSessionSummary(ctx, proposal.SessionID)
	if errors.Is(err, store.ErrNotFound) {
		return "", errors.New("the session is gone")
	}
	if err != nil {
		return "", err
	}
	if gateway.SessionLive(session) != nil {
		return "", errors.New("the session ended")
	}
	account, err := g.store.GetExternalAccount(ctx, spec.AccountID)
	if err != nil {
		return "", errors.New("the account is gone")
	}
	app, err := g.store.GetExternalProviderApp(ctx, account.AppID)
	if err != nil {
		return "", errors.New("the account's connector instance is gone")
	}
	data, err := g.accounts.ExtensionData(ctx, app)
	if err != nil {
		return "", errors.New("the connector instance metadata could not be read")
	}
	route, ok := externalaccounts.ExtensionRouteFor(data.Routes, spec.Method, spec.Path)
	if !ok || strings.ToLower(strings.TrimSpace(route.Access)) != extensionGatewayWrite {
		return "", errors.New("the route is no longer in the instance's write directory")
	}
	if !externalaccounts.ExtensionAccessAllowsRoute(data.Descriptor.ServerHeld.Access, data.ProbeValues, route) {
		return "", errors.New("the instance no longer grants write access")
	}
	deviceID := spec.DeviceID
	if deviceID == "" {
		deviceID = session.DeviceID
	}
	deviceOwner, err := g.store.DeviceOwner(ctx, deviceID)
	if err != nil || deviceOwner == "" {
		return "", errors.New("the device is not available")
	}
	policy, err := externalaccounts.ResolvePolicy(ctx, g.store, session)
	if err != nil {
		return "", err
	}
	if !externalaccounts.EligibleFor(account, account.WorkspaceIDs, session.WorkspaceID, session.CreatedByUserID, deviceOwner, policy) {
		return "", errors.New("the account may no longer be used by this session")
	}
	query, _ := url.ParseQuery(spec.Query)
	response, err := g.accounts.DoExtensionRequest(ctx, app, deviceID, spec.Method, spec.Path, query, http.Header{}, bytes.NewReader(spec.Body))
	if err != nil {
		return "", errors.New("the connector could not be reached")
	}
	defer response.Body.Close()
	payload, readErr := io.ReadAll(io.LimitReader(response.Body, extensionDefaultResponseMax))
	if readErr != nil {
		return "", errors.New("the connector response could not be read")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("the connector answered %d", response.StatusCode)
	}
	pointer, declared := extensionCreatedMessagePointer(data.Descriptor.ServerHeld.Writes, spec.Method, route.Path)
	if !declared {
		return "", nil
	}
	messageID := extensionPointerText(payload, pointer)
	if messageID != "" {
		g.recordReplayedMessage(ctx, account.ID, proposal, deviceID, spec.Method, route.Path, messageID)
	}
	if messageID == "" {
		return "", nil
	}
	return "message id " + messageID, nil
}

// recordReplayedMessage remembers the message a replayed write created, so
// the channel drops the echo as it does for a write it forwarded directly.
func (g *ExtensionGateway) recordReplayedMessage(ctx context.Context, accountID string, proposal store.PersonalAgentProposal, deviceID, method, route, messageID string) {
	detail, _ := json.Marshal(struct {
		MessageID string `json:"messageId"`
		Method    string `json:"method"`
		Route     string `json:"route"`
	}{MessageID: messageID, Method: method, Route: route})
	audit, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer done()
	_ = g.store.AppendExternalAccountEvent(audit, store.ExternalAccountEvent{
		AccountID: accountID, Kind: ExtensionWriteCreatedMessage,
		SessionID: proposal.SessionID, DeviceID: deviceID,
		ActorID: proposal.UserID, Detail: string(detail),
	})
}
