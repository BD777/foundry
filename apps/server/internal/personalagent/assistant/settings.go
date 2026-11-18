package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"slices"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The assistant's own settings (assistant_settings, docs/personal-agent.md
// §5, DEV-298). A patch names settings fields by their JSON names; the class
// table (personalagent.SettingsFieldClass) decides whether it applies at once
// or becomes a proposal. Both go through runWrite, so each update is audited
// in pa_actions and refused while the assistant is stopped.

// settingsTool is the audit name of a settings update.
const settingsTool = "update_settings"

// settingsArgs are update_settings' arguments: a patch, the revision the
// assistant read (optional), or the audit id of an applied change to undo.
type settingsArgs struct {
	Patch            map[string]json.RawMessage `json:"patch"`
	ExpectedRevision *int64                     `json:"expectedRevision"`
	Undo             string                     `json:"undo"`
}

// settingsSpec is one update as recorded: the audit row's args_json, and the
// proposal's spec. Before holds the values the patch replaces (null when the
// field was unset). Revision is the revision the save produces; undo refuses
// unless that is still the current one.
type settingsSpec struct {
	Patch    map[string]json.RawMessage  `json:"patch"`
	Before   map[string]json.RawMessage  `json:"before,omitempty"`
	Revision int64                       `json:"revision,omitempty"`
	Class    personalagent.SettingsClass `json:"class"`
	Undo     string                      `json:"undo,omitempty"`
}

// settingsResult answers an applied update: the fields it set, the revision
// after it, and the audit id an undo names.
type settingsResult struct {
	Status   string   `json:"status"`
	Fields   []string `json:"fields"`
	Revision int64    `json:"revision"`
	ActionID string   `json:"actionId"`
}

func (s *Service) planSettings(ctx context.Context, scope Scope, args map[string]json.RawMessage) (Write, error) {
	var in settingsArgs
	if err := DecodeArgs(args, &in); err != nil {
		return Write{ArgsSummary: settingsTool}, err
	}
	if in.Undo != "" {
		return s.planSettingsUndo(ctx, scope, in.Undo)
	}
	return s.planSettingsPatch(ctx, scope, in.Patch, in.ExpectedRevision, "")
}

// planSettingsUndo reverts an applied immediate change to the values it
// replaced. It is refused once any later save moved the revision on.
func (s *Service) planSettingsUndo(ctx context.Context, scope Scope, actionID string) (Write, error) {
	record, raw, err := s.store.GetPersonalAgentAction(ctx, scope.Agent.ID, actionID)
	if errors.Is(err, store.ErrNotFound) {
		return Write{ArgsSummary: "undo " + actionID}, invalid("there is no change %s to undo", actionID)
	}
	if err != nil {
		return Write{ArgsSummary: "undo " + actionID}, err
	}
	var change settingsSpec
	if err := json.Unmarshal(raw, &change); err != nil {
		return Write{ArgsSummary: "undo " + actionID}, invalid("the change %s cannot be undone: %v", actionID, err)
	}
	if record.Tool != settingsTool || record.Outcome != store.PersonalAgentOutcomeApplied ||
		change.Class != personalagent.SettingsImmediate || len(change.Before) == 0 {
		return Write{ArgsSummary: "undo " + actionID}, invalid("only an applied change to the notice, digest, hours or interface settings can be undone")
	}
	if change.Revision != scope.Agent.Settings.Revision {
		return Write{ArgsSummary: "undo " + actionID}, personalagent.Refuse(store.PersonalAgentRefusalInvalid, http.StatusConflict,
			"the settings changed after %s (revision %d now): read them with get; the undo is refused", actionID, scope.Agent.Settings.Revision)
	}
	return s.planSettingsPatch(ctx, scope, change.Before, nil, actionID)
}

// planSettingsPatch checks a patch against the class table and the revision,
// and builds the write that applies it or proposes it.
func (s *Service) planSettingsPatch(ctx context.Context, scope Scope, patch map[string]json.RawMessage, expected *int64, undoOf string) (Write, error) {
	fields := slices.Sorted(maps.Keys(patch))
	summary := "settings: " + strings.Join(fields, ", ")
	if undoOf != "" {
		summary = "undo " + undoOf + ": " + strings.Join(fields, ", ")
	}
	write := Write{ArgsSummary: summary}
	class, err := personalagent.SettingsPatchClass(fields)
	if err != nil {
		return write, invalid("%v", err)
	}
	if expected != nil && *expected != scope.Agent.Settings.Revision {
		return write, personalagent.Refuse(store.PersonalAgentRefusalInvalid, http.StatusConflict,
			"the settings changed: revision %d now, you read %d; read them with get, then decide again", scope.Agent.Settings.Revision, *expected)
	}
	current, err := settingsFieldValues(scope.Agent.Settings)
	if err != nil {
		return write, err
	}
	before := map[string]json.RawMessage{}
	merged := maps.Clone(current)
	for _, field := range fields {
		before[field] = current[field]
		merged[field] = patch[field]
	}
	var next store.PersonalAgentSettings
	if err := decodeSettingsFields(merged, &next); err != nil {
		return write, invalid("the settings do not take this patch: %v", err)
	}
	write.Spec = settingsSpec{Patch: patch, Before: before, Revision: scope.Agent.Settings.Revision + 1, Class: class, Undo: undoOf}
	write.Apply = func(ctx context.Context) (any, error) {
		if s.SaveSettingsChecked == nil {
			return nil, errors.New("settings checks are not wired: the assistant cannot save settings")
		}
		saved, err := s.SaveSettingsChecked(ctx, scope.Agent, next)
		if err != nil {
			return nil, err
		}
		return settingsResult{Status: "applied", Fields: fields, Revision: saved.Settings.Revision}, nil
	}
	write.Report = func(result any, actionID string) any {
		if applied, ok := result.(settingsResult); ok {
			applied.ActionID = actionID
			return applied
		}
		return result
	}
	if class == personalagent.SettingsProposal {
		write.ProposalKind = store.PersonalAgentProposalSettings
		write.ProposalSummary = personalagent.SettingsProposalSummary(
			personalagent.LanguageOf(scope.Agent.Settings, s.AccountLocale(ctx, scope.Agent.UserID)), fields)
		return write, nil
	}
	write.Decisions = []Decision{{Action: settingsTool, Decision: store.PersonalAgentAuto}}
	return write, nil
}

// CheckRunning refuses while the person has stopped the assistant: the refusal
// every write and every notice call gives.
func CheckRunning(agent store.PersonalAgent) error {
	if agent.State == store.PersonalAgentStopped {
		return errStopped
	}
	return nil
}

// settingsFieldValues is each settings field as JSON, by its name.
func settingsFieldValues(settings store.PersonalAgentSettings) (map[string]json.RawMessage, error) {
	raw, err := json.Marshal(settings)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	return fields, nil
}

// decodeSettingsFields reads settings fields back into a settings value.
func decodeSettingsFields(fields map[string]json.RawMessage, into *store.PersonalAgentSettings) error {
	raw, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, into)
}
