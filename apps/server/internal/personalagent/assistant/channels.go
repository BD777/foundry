package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"reflect"
	"slices"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The assistant's message channel writes (assistant_channels, docs/personal-agent.md
// §5, DEV-298 S3). Create always proposes; an update is decided by the fields it
// changes (personalagent.ChannelPatchClass). Both run through runWrite, so each is
// audited in pa_actions and refused while the assistant is stopped. The save
// itself is the person's channel route, wired in as SaveChannel.

// channelsTool is the audit name of every channel write.
const channelsTool = "assistant_channels"

// channelArgs are assistant_channels' write arguments: op create (channel) or
// update (channelId and patch), or undo (the audit id of an applied immediate
// update). A proposal stores the same shape, so accepting it re-plans it.
type channelArgs struct {
	Op        string                     `json:"op"`
	ChannelID string                     `json:"channelId"`
	Channel   json.RawMessage            `json:"channel"`
	Patch     map[string]json.RawMessage `json:"patch"`
	Undo      string                     `json:"undo"`
}

// channelSpec is one channel write as recorded: the audit row's args_json and
// the proposal's spec. Before holds the values the patch replaced; UndoOf names
// the change an undo reverts (kept out of the args key "undo", so a proposal
// that restores values re-plans as an update, not as an undo).
type channelSpec struct {
	Op        string                      `json:"op"`
	ChannelID string                      `json:"channelId,omitempty"`
	Channel   json.RawMessage             `json:"channel,omitempty"`
	Patch     map[string]json.RawMessage  `json:"patch,omitempty"`
	Before    map[string]json.RawMessage  `json:"before,omitempty"`
	Class     personalagent.SettingsClass `json:"class,omitempty"`
	UndoOf    string                      `json:"undoOf,omitempty"`
}

// channelResult answers an applied channel write; ActionID names it for undo.
type channelResult struct {
	Status    string   `json:"status"`
	ChannelID string   `json:"channelId"`
	Fields    []string `json:"fields,omitempty"`
	ActionID  string   `json:"actionId,omitempty"`
}

// planChannelWrite plans one assistant_channels write (a Planner).
func (s *Service) planChannelWrite(ctx context.Context, scope Scope, args map[string]json.RawMessage) (Write, error) {
	var in channelArgs
	if err := DecodeArgs(args, &in); err != nil {
		return Write{ArgsSummary: channelsTool}, err
	}
	if in.Undo != "" {
		return s.planChannelUndo(ctx, scope, in.Undo)
	}
	switch in.Op {
	case "create":
		return s.planChannelCreate(ctx, scope, in.Channel)
	case "update":
		return s.planChannelUpdate(ctx, scope, in.ChannelID, in.Patch, "")
	}
	return Write{ArgsSummary: channelsTool}, invalid("op is create or update, or undo with the actionId of a change")
}

// planChannelCreate proposes a new channel: it starts reading a source the
// person's assistant did not read before, so the person accepts the card first.
func (s *Service) planChannelCreate(ctx context.Context, scope Scope, raw json.RawMessage) (Write, error) {
	write := Write{ArgsSummary: "create channel"}
	var input store.MessageChannelInput
	if len(raw) == 0 {
		return write, invalid("channel is the new channel's input: name, source, filters and the rest")
	}
	if err := json.Unmarshal(raw, &input); err != nil {
		return write, invalid("channel does not match the channel's schema: %v", err)
	}
	write.ArgsSummary = "create channel " + input.Name
	write.Spec = channelSpec{Op: "create", Channel: raw}
	write.ProposalKind = store.PersonalAgentProposalChannel
	write.ProposalSummary = personalagent.ChannelProposalSummary(s.channelLanguage(ctx, scope), "create", input.Name, nil)
	write.Apply = func(ctx context.Context) (any, error) {
		return s.applyChannel(ctx, scope, "", input, false)
	}
	return write, nil
}

// planChannelUpdate plans a change to a channel's fields. Immediate fields
// (the name, pausing) apply at once; any other field makes it one proposal.
func (s *Service) planChannelUpdate(ctx context.Context, scope Scope, id string, patch map[string]json.RawMessage, undoOf string) (Write, error) {
	write := Write{ArgsSummary: "update channel " + id}
	if id == "" {
		return write, invalid("channelId names the channel to change")
	}
	fields := slices.Sorted(maps.Keys(patch))
	patchText := make(map[string]string, len(patch))
	for field, value := range patch {
		patchText[field] = string(value)
	}
	class, err := personalagent.ChannelPatchClass(patchText)
	if err != nil {
		return write, invalid("%v", err)
	}
	if s.ChannelInputOf == nil || s.SaveChannel == nil {
		return write, errors.New("channel writes are not wired: the assistant cannot save channels")
	}
	current, err := s.ChannelInputOf(ctx, scope.Agent, id)
	if err != nil {
		return write, err
	}
	currentFields, err := channelInputFields(current)
	if err != nil {
		return write, err
	}
	before := map[string]json.RawMessage{}
	merged := maps.Clone(currentFields)
	for _, field := range fields {
		before[field] = currentFields[field]
		merged[field] = patch[field]
	}
	var next store.MessageChannelInput
	if err := decodeChannelFields(merged, &next); err != nil {
		return write, invalid("the channel does not take this patch: %v", err)
	}
	resumeFromNow := next.ResumeFromNow
	write.Spec = channelSpec{Op: "update", ChannelID: id, Patch: patch, Before: before, Class: class, UndoOf: undoOf}
	write.Apply = func(ctx context.Context) (any, error) {
		return s.applyChannel(ctx, scope, id, next, resumeFromNow)
	}
	write.Report = func(result any, actionID string) any {
		if applied, ok := result.(channelResult); ok {
			applied.ActionID = actionID
			applied.Fields = fields
			return applied
		}
		return result
	}
	if class == personalagent.SettingsProposal {
		write.ProposalKind = store.PersonalAgentProposalChannel
		write.ProposalSummary = personalagent.ChannelProposalSummary(s.channelLanguage(ctx, scope), "update", current.Name, fields)
		return write, nil
	}
	write.Decisions = []Decision{{Action: channelsTool, Decision: store.PersonalAgentAuto}}
	return write, nil
}

// planChannelUndo reverts an applied immediate update to the values it
// replaced. It is refused when any field it set has changed since.
func (s *Service) planChannelUndo(ctx context.Context, scope Scope, actionID string) (Write, error) {
	write := Write{ArgsSummary: "undo " + actionID}
	record, raw, err := s.store.GetPersonalAgentAction(ctx, scope.Agent.ID, actionID)
	if errors.Is(err, store.ErrNotFound) {
		return write, invalid("there is no change %s to undo", actionID)
	}
	if err != nil {
		return write, err
	}
	var change channelSpec
	if err := json.Unmarshal(raw, &change); err != nil {
		return write, invalid("the change %s cannot be undone: %v", actionID, err)
	}
	if record.Tool != channelsTool || record.Outcome != store.PersonalAgentOutcomeApplied ||
		change.Op != "update" || change.Class != personalagent.SettingsImmediate || len(change.Before) == 0 {
		return write, invalid("only an applied change to a channel's name or a pause can be undone")
	}
	current, err := s.ChannelInputOf(ctx, scope.Agent, change.ChannelID)
	if err != nil {
		return write, err
	}
	currentFields, err := channelInputFields(current)
	if err != nil {
		return write, err
	}
	for field, value := range change.Patch {
		if !sameJSONValue(currentFields[field], value) {
			return write, personalagent.Refuse(store.PersonalAgentRefusalInvalid, http.StatusConflict,
				"the channel's %s changed after %s: the undo is refused", field, actionID)
		}
	}
	return s.planChannelUpdate(ctx, scope, change.ChannelID, change.Before, actionID)
}

// applyChannel saves the channel through the person's route and answers the id.
func (s *Service) applyChannel(ctx context.Context, scope Scope, id string, input store.MessageChannelInput, resumeFromNow bool) (any, error) {
	view, err := s.SaveChannel(ctx, scope.Agent, id, input, resumeFromNow)
	if err != nil {
		return nil, err
	}
	return channelResult{Status: "applied", ChannelID: view.Channel.ID}, nil
}

func (s *Service) channelLanguage(ctx context.Context, scope Scope) string {
	return personalagent.LanguageOf(scope.Agent.Settings, s.AccountLocale(ctx, scope.Agent.UserID))
}

// channelInputFields is a channel input's fields as JSON, by name.
func channelInputFields(input store.MessageChannelInput) (map[string]json.RawMessage, error) {
	raw, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	return fields, nil
}

// decodeChannelFields reads channel input fields back into an input.
func decodeChannelFields(fields map[string]json.RawMessage, into *store.MessageChannelInput) error {
	raw, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, into)
}

// sameJSONValue compares two JSON values by meaning, not by spelling.
func sameJSONValue(a, b json.RawMessage) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}
