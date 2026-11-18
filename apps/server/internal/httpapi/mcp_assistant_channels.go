package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// assistant_channels (docs/personal-agent.md §5, DEV-298 S3) lets the person's
// assistant read and change its message channels: the connector sources it
// reads and the conversations it answers. list, peers and test answer from
// the same functions the person's Channels routes run; create and update are
// writes through the assistant's pipeline (personalagent/assistant/channels.go),
// which decides by the class table (personalagent.ChannelOpClasses). Granting a
// source to the permission package is person-only (personOnlyOperations).

// assistantChannelsForMCP answers assistant_channels for the calling assistant conversation.
func (s *Server) assistantChannelsForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	scope, err := s.paScope(ctx, call.actor)
	if err != nil {
		return "", err
	}
	switch op := mcpArgString(call.args, "op"); op {
	case "list":
		list, err := s.messageChannelList(ctx, scope.Agent)
		if err != nil {
			return "", err
		}
		return encodeJSON(list)
	case "peers":
		accountID := strings.TrimSpace(mcpArgString(call.args, "accountId"))
		if accountID == "" {
			return "", invalid("accountId names the source account whose conversations you want")
		}
		peers, err := s.messageChannelPeers(ctx, scope.Agent, accountID)
		if err != nil {
			return "", err
		}
		return encodeJSON(peers)
	case "test":
		var input store.MessageChannelTestInput
		if err := assistant.DecodeArgs(call.args, &input); err != nil {
			return "", err
		}
		result, err := s.testMessageChannelRules(ctx, scope.Agent, input)
		if err != nil {
			return "", err
		}
		return encodeJSON(result)
	case "create", "update":
		answer, err := s.assistant.RunTool(ctx, scope, "assistant_channels", call.args)
		if err != nil {
			return "", err
		}
		return encodeJSON(answer)
	default:
		return "", invalid("op is list, peers, test, create or update, not %q", op)
	}
}

// saveAssistantChannel saves a channel for the assistant's writes. It runs the
// same checks as the person's route, against the scope of ctx's actor: the
// assistant's own call, or the person accepting its proposal.
func (s *Server) saveAssistantChannel(ctx context.Context, agent store.PersonalAgent, id string, input store.MessageChannelInput, resumeFromNow bool) (store.MessageChannelView, error) {
	input.ResumeFromNow = resumeFromNow
	return s.saveMessageChannelInput(ctx, agent, id, input)
}

// assistantChannelInput is a channel's input as the person's route would take
// it back: the stored fields, for a patch to change.
func (s *Server) assistantChannelInput(ctx context.Context, agent store.PersonalAgent, id string) (store.MessageChannelInput, error) {
	st, err := s.messageChannelStore()
	if err != nil {
		return store.MessageChannelInput{}, err
	}
	record, err := st.GetMessageChannel(ctx, id)
	if err != nil || record.UserID != agent.UserID || record.AssistantID != agent.ID {
		return store.MessageChannelInput{}, &statusError{http.StatusNotFound, errors.New("not found")}
	}
	raw, err := json.Marshal(record.MessageChannel)
	if err != nil {
		return store.MessageChannelInput{}, err
	}
	var input store.MessageChannelInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return store.MessageChannelInput{}, err
	}
	return input, nil
}
