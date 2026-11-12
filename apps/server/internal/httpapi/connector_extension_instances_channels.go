package httpapi

import (
	"context"
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

// A message channel's source (DEV-203) is a connector extension instance's
// event feed, read through the same upstream path as the instance's gateway.

// openMessageChannelSource is the channel's source, after the checks that
// apply every time: the account is still the person's, the assistant may
// use it and has it bound, the feed's route is catalogued as read, and the
// request has a way out.
func (s *Server) openMessageChannelSource(ctx context.Context, channel store.MessageChannelRecord) (channels.Source, error) {
	agent, err := s.store.GetAssistant(ctx, channel.AssistantID)
	if err != nil || agent.UserID != channel.UserID {
		return nil, channels.ErrUnsupported
	}
	if agent.State == store.PersonalAgentStopped {
		return nil, channels.ErrNeedsPermission{Detail: "the assistant is stopped"}
	}
	account, err := s.messageChannelAccount(ctx, channel.UserID, channel.Source.AccountID)
	if err != nil {
		return nil, channels.ErrUnsupported
	}
	prerequisites, err := s.messageChannelPrerequisites(ctx, agent, account.ID)
	if err != nil {
		return nil, err
	}
	if !prerequisites.Allowed {
		return nil, channels.ErrNeedsPermission{Detail: "the assistant's permissions turn this connector off"}
	}
	app, data, err := s.messageChannelInstance(ctx, channel.UserID, account)
	if err != nil {
		return nil, channels.ErrUnsupported
	}
	spec, descriptor := s.messageChannelFeed(ctx, channel.UserID, app, data)
	if spec == nil || descriptor.ServerHeld == nil {
		return nil, channels.ErrUnsupported
	}
	if !strings.HasPrefix(spec.Poll.Path, data.Descriptor.ServerHeld.Upstream.PathPrefix) {
		return nil, fmt.Errorf("%w: the feed path is outside the instance's upstream", channels.ErrUnsupported)
	}
	route, ok := externalaccounts.ExtensionRouteFor(data.Routes, http.MethodGet, spec.Poll.Path)
	if !ok || strings.ToLower(route.Access) != "read" || !externalaccounts.ExtensionAccessAllowsRoute(data.Descriptor.ServerHeld.Access, data.ProbeValues, route) {
		return nil, fmt.Errorf("%w: the instance's route directory does not list GET %s as read; check the instance again", channels.ErrUnsupported, spec.Poll.Path)
	}
	deviceID := ""
	if data.Network == externalaccounts.ExtensionNetworkDevice {
		for _, check := range data.AvailableDevices {
			if check.Status == "ok" && s.hub != nil && s.hub.HasConnection(check.DeviceID) {
				deviceID = check.DeviceID
				break
			}
		}
		if deviceID == "" {
			return nil, channels.ErrWaitingDevice{Detail: "no device that reaches this connector is online"}
		}
	}
	return channels.LongPoll{Spec: *spec, Upstream: messageChannelUpstream{s: s, app: app, deviceID: deviceID}}, nil
}

type messageChannelUpstream struct {
	s        *Server
	app      store.ExternalProviderApp
	deviceID string
}

const messageChannelResponseLimit = 16 << 20

func (u messageChannelUpstream) Get(ctx context.Context, path string, query url.Values) (int, []byte, http.Header, error) {
	ctx, cancel := context.WithTimeout(ctx, 70*time.Second)
	defer cancel()
	response, err := u.s.connectors.ServerHeld.DoExtensionRequest(ctx, u.app, u.deviceID, http.MethodGet, path, query, nil, nil)
	if err != nil {
		var probe *externalaccounts.ExtensionProbeError
		if errors.As(err, &probe) {
			return 0, nil, nil, errors.New(probe.Message)
		}
		return 0, nil, nil, fmt.Errorf("the connector could not be reached: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, messageChannelResponseLimit+1))
	if err != nil {
		return 0, nil, nil, fmt.Errorf("read the feed's answer: %w", err)
	}
	if len(body) > messageChannelResponseLimit {
		return 0, nil, nil, errors.New("the feed's answer is larger than 16 MiB")
	}
	return response.StatusCode, body, response.Header, nil
}
