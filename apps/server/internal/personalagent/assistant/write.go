package assistant

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// The propose-or-apply pipeline every write tool of the assistant runs
// (docs/personal-agent.md §4, §5): a planner checks and resolves the
// write; the policy denies, proposes or applies it; pa_actions audits it.

// refusalKind is why the audit says a write was refused
// (store.PersonalAgentRefusal*).
func refusalKind(err error) string {
	if kind, ok := personalagent.RefusalKind(err); ok {
		return kind
	}
	var limit *personalagent.LimitError
	if errors.As(err, &limit) {
		return store.PersonalAgentRefusalLimit
	}
	if errors.Is(err, errStopped) {
		return store.PersonalAgentRefusalStopped
	}
	var none *placeRefusal
	if errors.As(err, &none) {
		return store.PersonalAgentRefusalNoPlace
	}
	return store.PersonalAgentRefusalInvalid
}

func notAllowed(action, settingsURL string) error {
	return refuse(store.PersonalAgentRefusalNotAllowed, http.StatusUnprocessableEntity,
		"not allowed: the person does not let you do this (%s). Tell them what you could not do and that they can do it themselves or change when you ask first in your settings (%s).",
		action, settingsURL)
}

// Decision is one managed action a write takes, and the policy's word.
type Decision struct{ Action, Decision string }

// Write is one write the assistant asked for, checked and resolved:
// what the policy decides, what a proposal would show, and how to apply it.
type Write struct {
	// Spec is the write's arguments as resolved: a proposal's spec, applied
	// exactly as approved, and the audit's record of them.
	Spec        any
	ArgsSummary string
	WorkspaceID string
	// DeviceID is the computer the write needs when no workspace names it
	// (a new project's).
	DeviceID  string
	Decisions []Decision
	// ProposalKind makes the write a proposal whatever the policy says
	// (loosening the rules).
	ProposalKind string
	Subject      string
	// RenameTo is the new name a rename gives Subject: its card says so.
	RenameTo string
	// ProposalSummary overrides the generic question when the card must name
	// exactly what will change or be lost.
	ProposalSummary string
	Apply           func(ctx context.Context) (any, error)
}

// Planner checks and resolves one write tool's arguments for scope.
type Planner func(ctx context.Context, scope Scope, args map[string]json.RawMessage) (Write, error)

// planner is the planner of a write tool.
func (s *Service) planner(tool string) (Planner, bool) {
	switch tool {
	case "create_workspace":
		return s.planCreateWorkspace, true
	case "update_workspace":
		return s.planUpdateWorkspace, true
	case "archive_workspace":
		return s.planArchiveWorkspace, true
	case "remove_device":
		return s.planRemoveDevice, true
	case "remember":
		return s.planRemember, true
	case "update_rules":
		return s.planRuleChange, true
	case "update_list":
		return s.planUpdateList, true
	case "archive_session":
		return s.archiveSessions, s.archiveSessions != nil
	}
	return nil, false
}

// RunTool runs the write tool for scope (runWrite).
func (s *Service) RunTool(ctx context.Context, scope Scope, tool string, args map[string]json.RawMessage) (any, error) {
	plan, ok := s.planner(tool)
	if !ok {
		return nil, fmt.Errorf("%s is not one of the assistant's write tools", tool)
	}
	return s.runWrite(ctx, scope, tool, args, plan)
}

// runWrite is how every write tool runs (§4, §5): refused while the
// assistant is stopped or the write is invalid, not the person's or past a
// limit; denied, proposed or applied as the policy says; audited in
// pa_actions whatever happens.
func (s *Service) runWrite(ctx context.Context, scope Scope, tool string, args map[string]json.RawMessage, plan Planner) (any, error) {
	record := store.PersonalAgentActionRecord{UserID: scope.Agent.UserID, SessionID: scope.SessionID, Tool: tool}
	var spec []byte
	refused := func(err error) (any, error) {
		record.Outcome, record.Refusal, record.Error = store.PersonalAgentOutcomeRefused, refusalKind(err), err.Error()
		s.recordAction(ctx, record, spec)
		var none *placeRefusal
		if errors.As(err, &none) {
			return none.answer, nil
		}
		return nil, err
	}
	if scope.Agent.State == store.PersonalAgentStopped {
		record.ArgsSummary = tool
		return refused(errStopped)
	}
	write, err := plan(ctx, scope, args)
	record.ArgsSummary, record.WorkspaceID = cutSummary(write.ArgsSummary), write.WorkspaceID
	if write.Spec != nil {
		spec, _ = json.Marshal(write.Spec)
	}
	if err != nil {
		return refused(err)
	}
	decision, askKind := "", write.ProposalKind
	for _, step := range write.Decisions {
		if step.Decision == store.PersonalAgentDeny {
			record.Decision = store.PersonalAgentDeny
			return refused(notAllowed(step.Action, s.settingsURL()))
		}
		decision = personalagent.Strictest(cmp.Or(decision, store.PersonalAgentAuto), step.Decision)
		if step.Decision == store.PersonalAgentAsk && askKind == "" {
			askKind = step.Action
		}
	}
	if write.ProposalKind != "" {
		decision = store.PersonalAgentAsk
	}
	record.Decision = decision
	if decision == store.PersonalAgentAsk {
		return s.proposeWrite(ctx, scope, record, write, askKind, spec)
	}
	result, err := write.Apply(ctx)
	if err != nil {
		record.Outcome, record.Error = store.PersonalAgentOutcomeFailed, err.Error()
		s.recordAction(ctx, record, spec)
		s.NoteOfflineRefusal(ctx, scope, tool, write, err)
		return nil, err
	}
	record.Outcome = store.PersonalAgentOutcomeApplied
	record.WorkspaceID = cmp.Or(record.WorkspaceID, workspaceIDOf(result))
	s.recordAction(ctx, record, spec)
	return result, nil
}

// proposeWrite turns a write into a proposal only the person can
// accept, and tells the assistant a card is in front of them.
func (s *Service) proposeWrite(ctx context.Context, scope Scope, record store.PersonalAgentActionRecord, write Write, kind string, spec []byte) (any, error) {
	language := personalagent.LanguageOf(scope.Agent.Settings, s.AccountLocale(ctx, scope.Agent.UserID))
	summary := cmp.Or(write.ProposalSummary, personalagent.ProposalSummary(language, kind, write.Subject))
	if kind == store.PersonalAgentActionRenameWorkspace && write.RenameTo != "" {
		summary = personalagent.RenameSummary(language, write.Subject, write.RenameTo)
	}
	proposal, err := s.store.CreatePersonalAgentProposal(ctx, store.PersonalAgentProposal{
		UserID: scope.Agent.UserID, SessionID: scope.SessionID, Kind: kind, WorkspaceID: write.WorkspaceID,
		Spec: spec, Summary: summary,
		ExpiresAt: formatPATime(time.Now().Add(personalagent.ProposalTTL)),
	})
	if err != nil {
		return nil, err
	}
	record.Outcome, record.ProposalID = store.PersonalAgentOutcomeProposed, proposal.ID
	s.recordAction(ctx, record, spec)
	s.supersedeProposals(ctx, proposal)
	s.channel.PersonalAgentProposalCreated(proposal)
	return store.PersonalAgentNeedsConfirmation{
		Status: store.PersonalAgentNeedsConfirmationStatus, ProposalID: proposal.ID, Summary: proposal.Summary, ExpiresAt: proposal.ExpiresAt,
	}, nil
}

// supersedeProposals expires the older cards still waiting that
// ask the same thing of the same project: asked again, the person answers
// the new card, and a stale one must not linger or apply later.
func (s *Service) supersedeProposals(ctx context.Context, proposal store.PersonalAgentProposal) {
	if proposal.WorkspaceID == "" {
		return
	}
	pending, err := s.store.ListPersonalAgentProposals(ctx, proposal.UserID, []string{store.PersonalAgentProposalPending})
	if err != nil {
		log.Printf("personal agent %s: list proposals to supersede: %v", proposal.UserID, err)
		return
	}
	for _, older := range pending {
		if older.ID == proposal.ID || older.Kind != proposal.Kind || older.WorkspaceID != proposal.WorkspaceID {
			continue
		}
		expired, err := s.store.SetPersonalAgentProposalStatus(ctx, proposal.UserID, older.ID,
			[]string{store.PersonalAgentProposalPending}, store.PersonalAgentProposalExpired, "superseded", "")
		if err != nil {
			continue
		}
		s.channel.PersonalAgentProposalChanged(expired)
	}
}

// applyProposal applies an accepted proposal's spec as the person's
// assistant, re-checking what may have changed since (ownership, limits).
func (s *Service) applyProposal(ctx context.Context, proposal store.PersonalAgentProposal) (any, error) {
	agent, err := s.store.GetPersonalAgent(ctx, proposal.UserID)
	if err != nil {
		return nil, err
	}
	scope, err := s.ScopeFor(ctx, agent, proposal.SessionID, store.SessionInput{})
	if err != nil {
		return nil, err
	}
	var args map[string]json.RawMessage
	if err := json.Unmarshal(proposal.Spec, &args); err != nil {
		return nil, fmt.Errorf("proposal spec: %w", err)
	}
	var plan Planner
	switch proposal.Kind {
	case store.PersonalAgentProposalRelaxRules:
		plan = s.planRuleChange
	case store.PersonalAgentActionCreateWorkspace, store.PersonalAgentActionRegisterFolder:
		plan = s.planCreateWorkspace
	case store.PersonalAgentActionArchive, store.PersonalAgentActionRestore:
		plan = s.planArchiveWorkspace
	case store.PersonalAgentActionRemoveDevice:
		plan = s.planRemoveDevice
	case store.PersonalAgentActionArchiveSession:
		plan = s.archiveSessions
	default:
		plan = s.planUpdateWorkspace
	}
	write, err := plan(ctx, scope, args)
	if err != nil {
		return nil, err
	}
	return write.Apply(ctx)
}

func workspaceIDOf(result any) string {
	if value, ok := result.(workspaceResult); ok {
		return value.Workspace.ID
	}
	return ""
}

func cutSummary(text string) string {
	return textcut.Excerpt(strings.Join(strings.Fields(text), " "), 200)
}

// DecodeArgs decodes a tool's arguments into target, refusing ones that do
// not match its schema.
func DecodeArgs(args map[string]json.RawMessage, target any) error {
	raw, err := json.Marshal(args)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return invalid("arguments do not match the tool's schema: %v", err)
	}
	return nil
}
