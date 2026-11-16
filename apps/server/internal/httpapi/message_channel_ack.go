package httpapi

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

	"github.com/foundry-dev/foundry/apps/server/internal/channels"
	"github.com/foundry-dev/foundry/apps/server/internal/externalaccounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// ExtensionAckFailed is the audit kind of an acknowledgement reaction call
// a channel could not finish, so the channel's recent activity can show it.
const ExtensionAckFailed = "extension_ack_failed"

// messageChannelAck puts the source's acknowledgement reaction on a handed
// batch's messages (add) or takes it away when their turn ends. The calls are
// the descriptor's catalogued write routes through the instance's gateway.
// A failure is recorded on the channel's activity and returned for the log;
// it never affects the delivery.
func (s *Server) messageChannelAck(ctx context.Context, channel store.MessageChannelRecord, add bool, messageIDs []string) error {
	if !channels.AckEnabled(channel.MessageChannel) || len(messageIDs) == 0 {
		return nil
	}
	agent, err := s.store.GetAssistant(ctx, channel.AssistantID)
	if err != nil || agent.UserID != channel.UserID {
		return errors.New("the channel's assistant is gone")
	}
	account, err := s.messageChannelAccount(ctx, channel.UserID, channel.Source.AccountID)
	if err != nil {
		return err
	}
	app, data, err := s.messageChannelInstance(ctx, channel.UserID, account)
	if err != nil {
		return err
	}
	spec, _ := s.messageChannelFeed(ctx, channel.UserID, app, data)
	if spec == nil || spec.Ack == nil {
		return nil
	}
	call, action := spec.Ack.Add, "add"
	if !add {
		if spec.Ack.Remove.Method == "" || spec.Ack.Remove.Path == "" {
			return nil
		}
		call, action = spec.Ack.Remove, "remove"
	}
	deviceID, err := s.messageChannelDevice(data)
	if err != nil {
		return err
	}
	if err := s.checkMessageChannelAckRoute(data, call, spec.Ack.Reaction); err != nil {
		return err
	}
	failed := 0
	var first error
	for _, messageID := range messageIDs {
		if err := s.sendMessageChannelAck(ctx, app, deviceID, call, spec.Ack.Reaction, messageID); err != nil {
			failed++
			if first == nil {
				first = err
			}
			s.recordMessageChannelAckFailure(ctx, channel, messageID, action, err)
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d of %d reaction %s calls failed: %w", failed, len(messageIDs), action, first)
	}
	return nil
}

// checkMessageChannelAckRoute requires the call to be a catalogued write
// route the instance's access allows.
func (s *Server) checkMessageChannelAckRoute(data store.ExtensionInstanceData, call store.ConnectorEventsAckCall, reaction string) error {
	path := fillAckTemplate(call.Path, "<message>", reaction)
	route, ok := externalaccounts.ExtensionRouteFor(data.Routes, call.Method, path)
	if !ok || !strings.EqualFold(strings.TrimSpace(route.Access), externalaccounts.ExtensionAccessWrite) ||
		!externalaccounts.ExtensionAccessAllowsRoute(data.Descriptor.ServerHeld.Access, data.ProbeValues, route) {
		return fmt.Errorf("the instance's route directory does not allow %s %s as a write; check the instance again", call.Method, call.Path)
	}
	return nil
}

func (s *Server) sendMessageChannelAck(ctx context.Context, app store.ExternalProviderApp, deviceID string, call store.ConnectorEventsAckCall, reaction, messageID string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	path := fillAckTemplate(call.Path, messageID, reaction)
	var body io.Reader
	headers := http.Header{}
	if strings.TrimSpace(call.Body) != "" {
		payload := fillAckTemplate(call.Body, messageID, reaction)
		if !json.Valid([]byte(payload)) {
			return errors.New("the reaction body template did not produce JSON")
		}
		body = bytes.NewReader([]byte(payload))
		headers.Set("Content-Type", "application/json")
	}
	response, err := s.connectors.ServerHeld.DoExtensionRequest(ctx, app, deviceID, call.Method, path, nil, headers, body)
	if err != nil {
		return fmt.Errorf("the connector could not be reached: %w", err)
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("%s %s answered %d: %s", call.Method, call.Path, response.StatusCode, strings.TrimSpace(string(payload)))
	}
	return nil
}

// fillAckTemplate replaces the two values an ack call may use.
func fillAckTemplate(template, messageID, reaction string) string {
	return strings.NewReplacer(
		"{message.id}", url.PathEscape(messageID),
		"{reaction}", url.PathEscape(reaction),
	).Replace(template)
}

// recordMessageChannelAckFailure leaves the failure in the channel's recent
// activity; a store error is the log's problem alone.
func (s *Server) recordMessageChannelAckFailure(ctx context.Context, channel store.MessageChannelRecord, messageID, action string, callErr error) {
	detail, _ := json.Marshal(struct {
		ChannelID string `json:"channelId"`
		MessageID string `json:"messageId"`
		Action    string `json:"action"`
		Outcome   string `json:"outcome"`
		Error     string `json:"error"`
	}{ChannelID: channel.ID, MessageID: messageID, Action: action, Outcome: "failed", Error: callErr.Error()})
	write, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer done()
	_ = s.store.AppendExternalAccountEvent(write, store.ExternalAccountEvent{
		AccountID: channel.Source.AccountID, Kind: ExtensionAckFailed,
		ActorID: channel.UserID, Detail: string(detail),
	})
}

// messageChannelDevice is the online device a device-held instance's
// requests leave through; "" when the instance reaches its upstream directly.
func (s *Server) messageChannelDevice(data store.ExtensionInstanceData) (string, error) {
	if data.Network != externalaccounts.ExtensionNetworkDevice {
		return "", nil
	}
	for _, check := range data.AvailableDevices {
		if check.Status == "ok" && s.hub != nil && s.hub.HasConnection(check.DeviceID) {
			return check.DeviceID, nil
		}
	}
	return "", channels.ErrWaitingDevice{Detail: "no device that reaches this connector is online"}
}
