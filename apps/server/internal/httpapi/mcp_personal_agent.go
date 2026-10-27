package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/workspacedigest"
)

// personalAgentMCPTools are the Personal Agent's own tools
// (docs/personal-agent.md §5): only a personal_agent session lists them.
var personalAgentMCPTools = map[string]bool{
	"find_workspace":       true,
	"get_workspace":        true,
	"create_workspace":     true,
	"update_workspace":     true,
	"archive_workspace":    true,
	"remember":             true,
	"update_rules":         true,
	"list_tasks":           true,
	"update_list":          true,
	"dispatch_item":        true,
	"cancel_item_dispatch": true,
	"read_list":            true,
}

// assistantWithheldMCPTools are tools the assistant does not get (§5): work
// needing a device's resources or Feishu events goes to a session in a
// project there.
var assistantWithheldMCPTools = map[string]bool{
	"acquire_resource": true, "operate_resource": true, "release_resource": true, "resource_status": true,
	"feishu_events": true,
}

// workspaceLifecycle is what the assistant's writes apply: the same
// service functions the REST routes call (workspace_lifecycle.go).
type workspaceLifecycle interface {
	CreateWorkspace(ctx context.Context, actor WorkspaceActor, request WorkspaceCreateRequest) (store.WorkspaceProjection, error)
	UpdateWorkspaceDetails(ctx context.Context, actor WorkspaceActor, workspaceID string, details WorkspaceDetails) (store.WorkspaceProjection, error)
	ChangeWorkspaceSkills(ctx context.Context, actor WorkspaceActor, workspaceID string, add, remove []string) ([]store.WorkspaceSkillBinding, error)
	ChangeWorkspaceConnectors(ctx context.Context, actor WorkspaceActor, workspaceID string, add, remove []string) (store.WorkspaceExternalAccounts, error)
	ArchiveWorkspace(ctx context.Context, actor WorkspaceActor, workspaceID string) (store.WorkspaceProjection, error)
	RestoreWorkspace(ctx context.Context, actor WorkspaceActor, workspaceID string) (store.WorkspaceProjection, error)
}

// lifecycleFor is the lifecycle a server applies; tests replace it.
var lifecycleFor = func(s *Server) workspaceLifecycle { return s }

// paRefusal is a write the assistant may not make, with why for the audit.
type paRefusal struct {
	kind string
	*statusError
}

// Unwrap lets errorStatus read the refusal's status.
func (r *paRefusal) Unwrap() error { return r.statusError }

func refuse(kind string, status int, format string, args ...any) error {
	return &paRefusal{kind, &statusError{status, fmt.Errorf(format, args...)}}
}

func refusalKind(err error) string {
	var refusal *paRefusal
	if errors.As(err, &refusal) {
		return refusal.kind
	}
	var limit *personalagent.LimitError
	if errors.As(err, &limit) {
		return store.PersonalAgentRefusalLimit
	}
	if errors.Is(err, errAssistantStopped) {
		return store.PersonalAgentRefusalStopped
	}
	var noPlace *paNoPlace
	if errors.As(err, &noPlace) {
		return store.PersonalAgentRefusalNoPlace
	}
	return store.PersonalAgentRefusalInvalid
}

func invalid(format string, args ...any) error {
	return refuse(store.PersonalAgentRefusalInvalid, http.StatusBadRequest, format, args...)
}

func notAllowed(action, settingsURL string) error {
	return refuse(store.PersonalAgentRefusalNotAllowed, http.StatusUnprocessableEntity,
		"not allowed: the person does not let you do this (%s). Tell them what you could not do and that they can do it themselves or change when you ask first in your settings (%s).",
		action, settingsURL)
}

// paDecision is one managed action a write takes, and the policy's word.
type paDecision struct{ action, decision string }

// paWrite is one write the assistant asked for, checked and resolved:
// what the policy decides, what a proposal would show, and how to apply it.
type paWrite struct {
	// spec is the write's arguments as resolved: a proposal's spec, applied
	// exactly as approved, and the audit's record of them.
	spec        any
	argsSummary string
	workspaceID string
	// deviceID is the computer the write needs when no workspace names it
	// (a new project's).
	deviceID  string
	decisions []paDecision
	// proposalKind makes the write a proposal whatever the policy says
	// (loosening the rules).
	proposalKind string
	subject      string
	// renameTo is the new name a rename gives subject: its card says so.
	renameTo string
	apply    func(ctx context.Context) (any, error)
}

type paPlanner func(s *Server, ctx context.Context, scope paScope, args map[string]json.RawMessage) (paWrite, error)

// assistantWrite is how every write tool runs (§4, §5): refused while the
// assistant is stopped or the write is invalid, not the person's or past a
// limit; denied, proposed or applied as the policy says; audited in
// pa_actions whatever happens.
func (s *Server) assistantWrite(call mcpCall, tool string, plan paPlanner) (string, error) {
	ctx := call.r.Context()
	scope, err := s.paScope(ctx, call.actor)
	if err != nil {
		return "", err
	}
	record := store.PersonalAgentActionRecord{UserID: scope.agent.UserID, SessionID: scope.sessionID, Tool: tool}
	var spec []byte
	refused := func(err error) (string, error) {
		record.Outcome, record.Refusal, record.Error = store.PersonalAgentOutcomeRefused, refusalKind(err), err.Error()
		s.recordPAAction(ctx, record, spec)
		var noPlace *paNoPlace
		if errors.As(err, &noPlace) {
			return encodeJSON(noPlace.answer)
		}
		return "", err
	}
	if scope.agent.State == store.PersonalAgentStopped {
		record.ArgsSummary = tool
		return refused(errAssistantStopped)
	}
	write, err := plan(s, ctx, scope, call.args)
	record.ArgsSummary, record.WorkspaceID = cutSummary(write.argsSummary), write.workspaceID
	if write.spec != nil {
		spec, _ = json.Marshal(write.spec)
	}
	if err != nil {
		return refused(err)
	}
	decision, askKind := "", write.proposalKind
	for _, step := range write.decisions {
		if step.decision == store.PersonalAgentDeny {
			record.Decision = store.PersonalAgentDeny
			return refused(notAllowed(step.action, s.assistantSettingsURL()))
		}
		decision = personalagent.Strictest(firstNonEmpty(decision, store.PersonalAgentAuto), step.decision)
		if step.decision == store.PersonalAgentAsk && askKind == "" {
			askKind = step.action
		}
	}
	if write.proposalKind != "" {
		decision = store.PersonalAgentAsk
	}
	record.Decision = decision
	if decision == store.PersonalAgentAsk {
		return s.proposeAssistantWrite(ctx, scope, record, write, askKind, spec)
	}
	result, err := write.apply(ctx)
	if err != nil {
		record.Outcome, record.Error = store.PersonalAgentOutcomeFailed, err.Error()
		s.recordPAAction(ctx, record, spec)
		s.noteOfflineRefusal(ctx, scope, tool, write, err)
		return "", err
	}
	record.Outcome = store.PersonalAgentOutcomeApplied
	record.WorkspaceID = firstNonEmpty(record.WorkspaceID, workspaceIDOf(result))
	s.recordPAAction(ctx, record, spec)
	return encodeJSON(result)
}

// proposeAssistantWrite turns a write into a proposal only the person can
// accept, and tells the assistant a card is in front of them.
func (s *Server) proposeAssistantWrite(ctx context.Context, scope paScope, record store.PersonalAgentActionRecord, write paWrite, kind string, spec []byte) (string, error) {
	language := personalagent.LanguageOf(scope.agent.Settings, s.accountLocale(ctx, scope.agent.UserID))
	summary := personalagent.ProposalSummary(language, kind, write.subject)
	if kind == store.PersonalAgentActionRenameWorkspace && write.renameTo != "" {
		summary = personalagent.RenameSummary(language, write.subject, write.renameTo)
	}
	proposal, err := s.store.CreatePersonalAgentProposal(ctx, store.PersonalAgentProposal{
		UserID: scope.agent.UserID, SessionID: scope.sessionID, Kind: kind, WorkspaceID: write.workspaceID,
		Spec: spec, Summary: summary,
		ExpiresAt: formatPATime(time.Now().Add(personalagent.ProposalTTL)),
	})
	if err != nil {
		return "", err
	}
	record.Outcome, record.ProposalID = store.PersonalAgentOutcomeProposed, proposal.ID
	s.recordPAAction(ctx, record, spec)
	s.supersedeAssistantProposals(ctx, proposal)
	s.feishu.PersonalAgentProposalCreated(proposal)
	return encodeJSON(store.PersonalAgentNeedsConfirmation{
		Status: store.PersonalAgentNeedsConfirmationStatus, ProposalID: proposal.ID, Summary: proposal.Summary, ExpiresAt: proposal.ExpiresAt,
	})
}

// supersedeAssistantProposals expires the older cards still waiting that
// ask the same thing of the same project: asked again, the person answers
// the new card, and a stale one must not linger or apply later.
func (s *Server) supersedeAssistantProposals(ctx context.Context, proposal store.PersonalAgentProposal) {
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
		s.feishu.PersonalAgentProposalChanged(expired)
	}
}

func (s *Server) accountLocale(ctx context.Context, userID string) string {
	user, err := s.store.GetUser(ctx, userID)
	if err != nil {
		return ""
	}
	return user.Locale
}

// personLocation is the time zone of the assistant's person
// (personalagent.Location).
func (s *Server) personLocation(ctx context.Context, agent store.PersonalAgent) *time.Location {
	return personalagent.Location(agent.Settings, s.accountLocale(ctx, agent.UserID))
}

// applyProposal applies an accepted proposal's spec as the person's
// assistant, re-checking what may have changed since (ownership, limits).
func (s *Server) applyProposal(ctx context.Context, proposal store.PersonalAgentProposal) (any, error) {
	agent, err := s.store.GetPersonalAgent(ctx, proposal.UserID)
	if err != nil {
		return nil, err
	}
	scope, err := s.paScopeFor(ctx, agent, proposal.SessionID, store.SessionInput{})
	if err != nil {
		return nil, err
	}
	var args map[string]json.RawMessage
	if err := json.Unmarshal(proposal.Spec, &args); err != nil {
		return nil, fmt.Errorf("proposal spec: %w", err)
	}
	var plan paPlanner
	switch proposal.Kind {
	case store.PersonalAgentProposalRelaxRules:
		plan = (*Server).planRuleChange
	case store.PersonalAgentActionCreateWorkspace, store.PersonalAgentActionRegisterFolder:
		plan = (*Server).planCreateWorkspace
	case store.PersonalAgentActionArchive, store.PersonalAgentActionRestore:
		plan = (*Server).planArchiveWorkspace
	case store.PersonalAgentActionArchiveSession:
		plan = (*Server).planArchiveSession
	default:
		plan = (*Server).planUpdateWorkspace
	}
	write, err := plan(s, ctx, scope, args)
	if err != nil {
		return nil, err
	}
	return write.apply(ctx)
}

func workspaceIDOf(result any) string {
	if value, ok := result.(paWorkspaceResult); ok {
		return value.Workspace.ID
	}
	return ""
}

func cutSummary(text string) string {
	return truncateRunes(strings.Join(strings.Fields(text), " "), 200)
}

func (s *Server) createWorkspaceForMCP(call mcpCall) (string, error) {
	return s.assistantWrite(call, "create_workspace", (*Server).planCreateWorkspace)
}

func (s *Server) updateWorkspaceForMCP(call mcpCall) (string, error) {
	return s.assistantWrite(call, "update_workspace", (*Server).planUpdateWorkspace)
}

func (s *Server) archiveWorkspaceForMCP(call mcpCall) (string, error) {
	return s.assistantWrite(call, "archive_workspace", (*Server).planArchiveWorkspace)
}

func (s *Server) rememberForMCP(call mcpCall) (string, error) {
	return s.assistantWrite(call, "remember", (*Server).planRemember)
}

func (s *Server) updateRulesForMCP(call mcpCall) (string, error) {
	return s.assistantWrite(call, "update_rules", (*Server).planRuleChange)
}

// paWorkspaceSummary is a project as the assistant's tools answer it.
type paWorkspaceSummary struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	DeviceID   string `json:"deviceId,omitempty"`
	LocalPath  string `json:"localPath,omitempty"`
	ArchivedAt string `json:"archivedAt,omitempty"`
}

func summarizeWorkspace(workspace store.WorkspaceProjection) paWorkspaceSummary {
	return paWorkspaceSummary{ID: workspace.ID, Name: workspace.Name, DeviceID: workspace.DeviceID, LocalPath: workspace.LocalPath, ArchivedAt: workspace.ArchivedAt}
}

// paWorkspaceResult is a write tool's answer when it was applied.
type paWorkspaceResult struct {
	Status     string                           `json:"status"`
	Before     *paWorkspaceSummary              `json:"before,omitempty"`
	Workspace  paWorkspaceSummary               `json:"workspace"`
	Purpose    string                           `json:"purpose,omitempty"`
	Skills     []store.WorkspaceSkillBinding    `json:"skills,omitempty"`
	Connectors *store.WorkspaceExternalAccounts `json:"connectors,omitempty"`
	// Place is where a new project went and why.
	Place *store.PersonalAgentPlacement `json:"place,omitempty"`
}

// paCreateSpec is create_workspace's arguments, resolved.
type paCreateSpec struct {
	Name    string `json:"name"`
	Purpose string `json:"purpose"`
	Source  struct {
		Kind    string `json:"kind"`
		GitInit bool   `json:"gitInit,omitempty"`
		URL     string `json:"url,omitempty"`
		Path    string `json:"path,omitempty"`
	} `json:"source"`
	Skills []string `json:"skills,omitempty"`
	// Needs are what the work needs from a computer, as key:value labels
	// ("network:corp", "toolchain:go").
	Needs    []string `json:"needs,omitempty"`
	DeviceID string   `json:"deviceId,omitempty"`
}

func decodeArgs(args map[string]json.RawMessage, target any) error {
	raw, err := json.Marshal(args)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return invalid("arguments do not match the tool's schema: %v", err)
	}
	return nil
}

func oneLineName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 80 || strings.ContainsAny(name, "\r\n\t") {
		return "", invalid("name must be 1-80 characters on one line")
	}
	return name, nil
}

const purposeMaxChars = 600

func (s *Server) planCreateWorkspace(ctx context.Context, scope paScope, args map[string]json.RawMessage) (paWrite, error) {
	var spec paCreateSpec
	if err := decodeArgs(args, &spec); err != nil {
		return paWrite{argsSummary: "create_workspace"}, err
	}
	write := paWrite{argsSummary: fmt.Sprintf("create %q (%s)", spec.Name, spec.Source.Kind), subject: spec.Name}
	name, err := oneLineName(spec.Name)
	if err != nil {
		return write, err
	}
	spec.Name, spec.Purpose = name, strings.TrimSpace(spec.Purpose)
	if utf8.RuneCountInString(spec.Purpose) > purposeMaxChars {
		return write, invalid("purpose is at most %d characters: one sentence", purposeMaxChars)
	}
	switch spec.Source.Kind {
	case WorkspaceCreateEmpty:
	case WorkspaceCreateClone:
		if strings.TrimSpace(spec.Source.URL) == "" {
			return write, invalid("source.url is required to clone")
		}
	case "existing":
		if !filepath.IsAbs(spec.Source.Path) {
			return write, invalid("source.path must be an absolute folder on the computer")
		}
		spec.Source.Path = filepath.Clean(spec.Source.Path)
	default:
		return write, invalid("source.kind must be empty, clone or existing")
	}
	skills, err := s.resolveSkills(ctx, spec.Skills)
	if err != nil {
		return write, err
	}
	needs, err := personalagent.ParseNeeds(spec.Needs)
	if err != nil {
		return write, invalid("needs: %v", err)
	}
	spec.Needs = nil
	for _, need := range needs {
		spec.Needs = append(spec.Needs, personalagent.LabelText(need))
	}
	devices, err := store.DeviceCandidates(ctx, s.store)
	if err != nil {
		return write, err
	}
	device, place, err := s.assistantCreateDevice(ctx, scope, devices, spec, needs)
	if err != nil {
		return write, err
	}
	spec.DeviceID, write.deviceID = device.ID, device.ID
	action := store.PersonalAgentActionCreateWorkspace
	if spec.Source.Kind == "existing" && !withinAny(device.ManagedRoots, spec.Source.Path) {
		action = store.PersonalAgentActionRegisterFolder
		write.subject = spec.Source.Path
	}
	write.spec = spec
	usage, err := s.personalAgentUsage(ctx, scope.agent)
	if err != nil {
		return write, err
	}
	if err := personalagent.CheckNewWorkspace(scope.agent.Settings.Limits, usage); err != nil {
		return write, limitRefusal(err, s.assistantSettingsURL())
	}
	write.decisions = []paDecision{{action, personalagent.Decide(scope.agent.Settings.Policy, action)}}
	write.apply = func(ctx context.Context) (any, error) {
		request := WorkspaceCreateRequest{DeviceID: spec.DeviceID, Name: spec.Name, Purpose: spec.Purpose}
		if spec.Source.Kind == "existing" {
			request.Path = spec.Source.Path
		} else {
			request.Create = &WorkspaceCreateSource{Kind: spec.Source.Kind, URL: strings.TrimSpace(spec.Source.URL), GitInit: spec.Source.Kind == WorkspaceCreateEmpty && spec.Source.GitInit}
		}
		if spec.Source.Kind == WorkspaceCreateEmpty {
			request.Create.Files = []WorkspaceFile{{Path: "AGENTS.md", Content: fmt.Sprintf("# %s\n\n## Purpose\n%s\n\n## Working agreement\nKeep domain artifacts here. Preserve their source and version; do not treat summaries as current execution status. Link existing work before starting a duplicate. Ask when the goal, authority or permissions are unclear. Propose changes to these instructions for review when a session may depend on them.\n\n## Open context\nConfirm authoritative inputs, desired outputs and completion evidence with the person as needed. Do not invent personal facts.\n", spec.Name, spec.Purpose)}}
		}
		actor := WorkspaceActor{UserID: scope.agent.UserID, SessionID: scope.sessionID}
		lifecycle := lifecycleFor(s)
		workspace, err := lifecycle.CreateWorkspace(ctx, actor, request)
		if err != nil {
			return nil, err
		}
		result := paWorkspaceResult{Status: "applied", Workspace: summarizeWorkspace(workspace), Purpose: spec.Purpose, Place: &place}
		if len(skills) > 0 {
			if result.Skills, err = lifecycle.ChangeWorkspaceSkills(ctx, actor, workspace.ID, skills, nil); err != nil {
				return result, fmt.Errorf("the project %s was created, but adding its skills failed: %w", workspace.ID, err)
			}
		}
		return result, nil
	}
	return write, nil
}

// paNoPlace is create_workspace's answer when no computer fits; the
// assistant gets it as a result, not an error, and the audit as a refusal.
type paNoPlace struct {
	answer store.PersonalAgentNoPlace
}

func (n *paNoPlace) Error() string {
	return "no computer fits: missing " + strings.Join(n.answer.Missing, ", ")
}

// assistantCreateDevice is where a new project goes (§4): the device asked
// for, which must be the person's and allow it; else personalagent.Place
// over the person's devices that allow it, online or not, by what the work
// needs and their labels and detected facts. A device whose system account
// someone else shares allows it only where the person chose it: "can start
// new projects here" (by default only the home, picked at setup) or their
// default place; never by a default such as "can work on this computer".
func (s *Server) assistantCreateDevice(ctx context.Context, scope paScope, devices []store.DeviceProjection, spec paCreateSpec, needs []store.DeviceLabel) (store.DeviceProjection, store.PersonalAgentPlacement, error) {
	shares, err := s.store.ListDeviceAccountShares(ctx)
	if err != nil {
		return store.DeviceProjection{}, store.PersonalAgentPlacement{}, err
	}
	allowed := func(device store.DeviceProjection) bool {
		settings := scope.device(device.ID)
		if len(shares[device.ID]) > 0 && !settings.AllowCreate && device.ID != scope.agent.Settings.PreferredDeviceID {
			return false
		}
		if spec.Source.Kind == "existing" && !withinAny(device.ManagedRoots, spec.Source.Path) {
			return settings.AllowWork
		}
		return settings.AllowCreate
	}
	owned := []store.DeviceProjection{}
	for _, device := range devices {
		if scope.owned[device.ID] && device.Status != "removed" {
			owned = append(owned, device)
		}
	}
	placements, err := s.devicePlacements(ctx, owned, time.Now())
	if err != nil {
		return store.DeviceProjection{}, store.PersonalAgentPlacement{}, err
	}
	candidates := make([]personalagent.PlaceCandidate, 0, len(owned))
	for _, device := range owned {
		placement := placements[device.ID]
		candidates = append(candidates, personalagent.PlaceCandidate{
			DeviceID: device.ID, Name: device.Label, Online: s.hub.HasConnection(device.ID), Allowed: allowed(device),
			Shared: sharedAccountNote(shares[device.ID]),
			Labels: placement.Labels, Facts: placement.Facts, OnlineShare: placement.OnlineShare,
		})
	}
	if spec.DeviceID != "" {
		for i, device := range owned {
			if device.ID != spec.DeviceID {
				continue
			}
			candidate := candidates[i]
			if !candidate.Allowed {
				return device, store.PersonalAgentPlacement{}, notAllowed("creating projects on that computer", s.assistantSettingsURL())
			}
			reason := "the computer you named"
			if candidate.Shared != "" {
				reason += "; " + candidate.Shared + ", which the person chose to allow: tell them"
			}
			return device, store.PersonalAgentPlacement{
				Computer: device.Label, DeviceID: device.ID, Online: candidate.Online,
				Reason: reason, Unverified: emptyNil(candidate.Lacks(needs)),
			}, nil
		}
		return store.DeviceProjection{}, store.PersonalAgentPlacement{}, refuse(store.PersonalAgentRefusalNotOwner, http.StatusUnprocessableEntity,
			"not allowed: %s is not one of the person's own computers", spec.DeviceID)
	}
	defaultID := firstNonEmpty(scope.agent.Settings.PreferredDeviceID, scope.agent.HomeDeviceID)
	if err := store.RequireDeviceAvailable(ctx, s.store, defaultID); err != nil {
		return store.DeviceProjection{}, store.PersonalAgentPlacement{}, err
	}
	place, err := personalagent.Place(candidates, needs, defaultID)
	var none *personalagent.NoPlace
	switch {
	case errors.Is(err, personalagent.ErrNoComputer):
		return store.DeviceProjection{}, store.PersonalAgentPlacement{}, notAllowed("creating projects: no computer of the person's allows it", s.assistantSettingsURL())
	case errors.As(err, &none):
		return store.DeviceProjection{}, store.PersonalAgentPlacement{}, &paNoPlace{noPlaceAnswer(none)}
	case err != nil:
		return store.DeviceProjection{}, store.PersonalAgentPlacement{}, err
	}
	for i, device := range owned {
		if device.ID == place.DeviceID {
			return device, store.PersonalAgentPlacement{Computer: device.Label, DeviceID: device.ID, Online: candidates[i].Online, Reason: place.Reason}, nil
		}
	}
	return store.DeviceProjection{}, store.PersonalAgentPlacement{}, fmt.Errorf("placement chose an unknown device %s", place.DeviceID)
}

// sharedAccountNote says who else uses the device's system account
// (docs/devices-and-workspaces.md): they would reach the files and
// sign-ins of work put there, so placement uses it only as the person
// chose it (personalagent.PlaceCandidate.Shared). "" when no one does.
func sharedAccountNote(shares []store.DeviceAccountShare) string {
	if len(shares) == 0 {
		return ""
	}
	names := []string{}
	for _, share := range shares {
		if name := strings.TrimSpace(share.OwnerName); name != "" && !slices.Contains(names, name) {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return "its system account is shared with someone else, who can reach its files and sign-ins"
	}
	return fmt.Sprintf("its system account is shared with %s, who can reach its files and sign-ins", strings.Join(names, ", "))
}

func emptyNil(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	return values
}

// noPlaceAnswer is what the assistant reads when no computer fits.
func noPlaceAnswer(none *personalagent.NoPlace) store.PersonalAgentNoPlace {
	answer := store.PersonalAgentNoPlace{
		Status: store.PersonalAgentNoPlaceStatus, Missing: none.Missing, Computers: []store.PersonalAgentPlaceGap{},
		Next: "Nothing was created. None of the computers you may use is known to have " + strings.Join(none.Missing, ", ") +
			". Ask the person ONE plain question in their words, naming what the work needs as they know it (\"the company network\", \"your work files\") and offering the computers that might have it by name, with the one you would pick. " +
			"Never say device, label or these key:value words. If they name a computer, call create_workspace again with its deviceId; if a computer has it but is not allowed, they can allow it in your settings.",
	}
	for _, gap := range none.Computers {
		answer.Computers = append(answer.Computers, store.PersonalAgentPlaceGap{
			Name: gap.Name, DeviceID: gap.DeviceID, Online: gap.Online, Lacks: gap.Lacks, NotAllowed: gap.NotAllowed,
		})
	}
	return answer
}

func withinAny(roots []string, path string) bool {
	for _, root := range roots {
		if pathWithinRoot(root, path) {
			return true
		}
	}
	return false
}

// resolveSkills turns skill names (or ids) into library skill ids.
// Foundry's built-in skills are always there and need nothing.
func (s *Server) resolveSkills(ctx context.Context, names []string) ([]string, error) {
	if len(names) == 0 {
		return nil, nil
	}
	library, err := s.store.ListPromotedSkills(ctx)
	if err != nil {
		return nil, err
	}
	builtin := map[string]bool{}
	for _, skill := range builtinSkillProjections() {
		builtin[strings.ToLower(skill.Name)] = true
	}
	ids, unknown := []string{}, []string{}
	for _, name := range names {
		name = strings.TrimSpace(name)
		found := ""
		for _, skill := range library {
			if skill.ID == name || strings.EqualFold(skill.Name, name) {
				found = skill.ID
				break
			}
		}
		switch {
		case found != "":
			if !slices.Contains(ids, found) {
				ids = append(ids, found)
			}
		case builtin[strings.ToLower(name)]:
		default:
			unknown = append(unknown, name)
		}
	}
	if len(unknown) > 0 {
		return nil, invalid("unknown skills: %s; use the names of skills in the person's skill library", strings.Join(unknown, ", "))
	}
	return ids, nil
}

// assistantWorkspace is a workspace the assistant names: visible to the
// person, and with manage, one the person owns on their own device.
func (s *Server) assistantWorkspace(ctx context.Context, scope paScope, workspaceID string, manage bool) (store.WorkspaceProjection, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return store.WorkspaceProjection{}, invalid("workspaceId is required")
	}
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if _, visible := scope.owner[workspaceID]; errors.Is(err, store.ErrNotFound) || (err == nil && !visible) {
		return store.WorkspaceProjection{}, refuse(store.PersonalAgentRefusalInvalid, http.StatusNotFound, "project not found")
	}
	if err != nil {
		return workspace, err
	}
	if manage && !scope.manages(workspace) {
		return workspace, refuse(store.PersonalAgentRefusalNotOwner, http.StatusUnprocessableEntity,
			"not allowed: the person does not own %q or the computer it is on, so you may not change it. Tell them; its owner can change it in the project's settings.", workspace.Name)
	}
	return workspace, nil
}

// paUpdateSpec is update_workspace's arguments.
type paUpdateSpec struct {
	WorkspaceID string  `json:"workspaceId"`
	Name        *string `json:"name,omitempty"`
	Purpose     *string `json:"purpose,omitempty"`
	Skills      struct {
		Add    []string `json:"add,omitempty"`
		Remove []string `json:"remove,omitempty"`
	} `json:"skills"`
	Connectors struct {
		Add    []string `json:"add,omitempty"`
		Remove []string `json:"remove,omitempty"`
	} `json:"connectors"`
}

func (s *Server) planUpdateWorkspace(ctx context.Context, scope paScope, args map[string]json.RawMessage) (paWrite, error) {
	var spec paUpdateSpec
	if err := decodeArgs(args, &spec); err != nil {
		return paWrite{argsSummary: "update_workspace"}, err
	}
	write := paWrite{workspaceID: spec.WorkspaceID, argsSummary: updateSummary(spec), spec: spec}
	workspace, err := s.assistantWorkspace(ctx, scope, spec.WorkspaceID, true)
	if err != nil {
		return write, err
	}
	write.subject = workspace.Name
	policy := scope.agent.Settings.Policy
	decide := func(action string) {
		write.decisions = append(write.decisions, paDecision{action, personalagent.Decide(policy, action)})
	}
	var details WorkspaceDetails
	if spec.Name != nil {
		name, err := oneLineName(*spec.Name)
		if err != nil {
			return write, err
		}
		details.Name = &name
		if name != workspace.Name {
			write.renameTo = name
		}
	}
	if spec.Purpose != nil {
		purpose := strings.TrimSpace(*spec.Purpose)
		if utf8.RuneCountInString(purpose) > purposeMaxChars {
			return write, invalid("purpose is at most %d characters: one sentence", purposeMaxChars)
		}
		details.Purpose = &purpose
	}
	if details.Name != nil || details.Purpose != nil {
		decide(store.PersonalAgentActionRenameWorkspace)
	}
	addSkills, err := s.resolveSkills(ctx, spec.Skills.Add)
	if err != nil {
		return write, err
	}
	removeSkills, err := s.resolveSkills(ctx, spec.Skills.Remove)
	if err != nil {
		return write, err
	}
	if len(addSkills) > 0 {
		decide(store.PersonalAgentActionAddSkill)
	}
	if len(removeSkills) > 0 {
		created, err := s.store.PersonalAgentCreatedWorkspace(ctx, scope.agent.UserID, workspace.ID)
		if err != nil {
			return write, err
		}
		if created {
			decide(store.PersonalAgentActionRemoveSkillCreated)
		} else {
			decide(store.PersonalAgentActionRemoveSkill)
		}
	}
	for _, accountID := range append(slices.Clone(spec.Connectors.Add), spec.Connectors.Remove...) {
		account, err := s.store.GetExternalAccount(ctx, accountID)
		if err != nil || account.OwnerUserID != scope.agent.UserID {
			return write, invalid("connector account %s is not one of the person's", accountID)
		}
	}
	if len(spec.Connectors.Add) > 0 {
		// The first binding of each account to the project is the policy's;
		// binding a pair again is not new (§4).
		decision := store.PersonalAgentAuto
		for _, accountID := range spec.Connectors.Add {
			bound, err := s.store.PersonalAgentConnectorBoundBefore(ctx, scope.agent.UserID, workspace.ID, accountID)
			if err != nil {
				return write, err
			}
			if !bound {
				decision = personalagent.Decide(policy, store.PersonalAgentActionBindConnector)
			}
		}
		write.decisions = append(write.decisions, paDecision{store.PersonalAgentActionBindConnector, decision})
	}
	if len(spec.Connectors.Remove) > 0 {
		decide(store.PersonalAgentActionUnbindConnector)
	}
	if len(write.decisions) == 0 {
		return write, invalid("nothing to change: give a name, a purpose, skills or connectors")
	}
	write.apply = func(ctx context.Context) (any, error) {
		actor := WorkspaceActor{UserID: scope.agent.UserID, SessionID: scope.sessionID}
		lifecycle := lifecycleFor(s)
		before := summarizeWorkspace(workspace)
		result := paWorkspaceResult{Status: "applied", Before: &before, Workspace: before}
		if details.Name != nil || details.Purpose != nil {
			updated, err := lifecycle.UpdateWorkspaceDetails(ctx, actor, workspace.ID, details)
			if err != nil {
				return nil, err
			}
			result.Workspace = summarizeWorkspace(updated)
			if details.Purpose != nil {
				result.Purpose = *details.Purpose
			}
		}
		if len(addSkills) > 0 || len(removeSkills) > 0 {
			skills, err := lifecycle.ChangeWorkspaceSkills(ctx, actor, workspace.ID, addSkills, removeSkills)
			if err != nil {
				return result, err
			}
			result.Skills = skills
		}
		if len(spec.Connectors.Add) > 0 || len(spec.Connectors.Remove) > 0 {
			connectors, err := lifecycle.ChangeWorkspaceConnectors(ctx, actor, workspace.ID, spec.Connectors.Add, spec.Connectors.Remove)
			if err != nil {
				return result, err
			}
			result.Connectors = &connectors
		}
		return result, nil
	}
	return write, nil
}

func updateSummary(spec paUpdateSpec) string {
	parts := []string{"update " + spec.WorkspaceID}
	if spec.Name != nil {
		parts = append(parts, fmt.Sprintf("name %q", *spec.Name))
	}
	if spec.Purpose != nil {
		parts = append(parts, "purpose")
	}
	for label, names := range map[string][]string{"+skills": spec.Skills.Add, "-skills": spec.Skills.Remove,
		"+connectors": spec.Connectors.Add, "-connectors": spec.Connectors.Remove} {
		if len(names) > 0 {
			parts = append(parts, label+" "+strings.Join(names, ","))
		}
	}
	slices.Sort(parts[1:])
	return strings.Join(parts, "; ")
}

// paArchiveSpec is archive_workspace's arguments.
type paArchiveSpec struct {
	WorkspaceID string `json:"workspaceId"`
	Restore     bool   `json:"restore,omitempty"`
}

func (s *Server) planArchiveWorkspace(ctx context.Context, scope paScope, args map[string]json.RawMessage) (paWrite, error) {
	var spec paArchiveSpec
	if err := decodeArgs(args, &spec); err != nil {
		return paWrite{argsSummary: "archive_workspace"}, err
	}
	action, verb := store.PersonalAgentActionArchive, "archive "
	if spec.Restore {
		action, verb = store.PersonalAgentActionRestore, "restore "
	}
	write := paWrite{workspaceID: spec.WorkspaceID, argsSummary: verb + spec.WorkspaceID, spec: spec}
	workspace, err := s.assistantWorkspace(ctx, scope, spec.WorkspaceID, true)
	if err != nil {
		return write, err
	}
	if workspace.ID == scope.agent.WorkspaceID {
		return write, refuse(store.PersonalAgentRefusalNotAllowed, http.StatusUnprocessableEntity, "not allowed: your own space cannot be archived")
	}
	write.subject = workspace.Name
	write.decisions = []paDecision{{action, personalagent.Decide(scope.agent.Settings.Policy, action)}}
	write.apply = func(ctx context.Context) (any, error) {
		actor := WorkspaceActor{UserID: scope.agent.UserID, SessionID: scope.sessionID}
		apply := lifecycleFor(s).ArchiveWorkspace
		if spec.Restore {
			apply = lifecycleFor(s).RestoreWorkspace
		}
		updated, err := apply(ctx, actor, workspace.ID)
		if err != nil {
			return nil, err
		}
		before := summarizeWorkspace(workspace)
		return paWorkspaceResult{Status: "applied", Before: &before, Workspace: summarizeWorkspace(updated)}, nil
	}
	return write, nil
}

// paRuleSpec is update_rules' arguments.
type paRuleSpec struct {
	Change store.PersonalAgentRuleChange `json:"change"`
}

func (s *Server) planRuleChange(ctx context.Context, scope paScope, args map[string]json.RawMessage) (paWrite, error) {
	var spec paRuleSpec
	if err := decodeArgs(args, &spec); err != nil {
		return paWrite{argsSummary: "update_rules"}, err
	}
	write := paWrite{argsSummary: spec.Change.Action + " -> " + spec.Change.Decision, spec: spec}
	plan, err := personalagent.PlanRuleChange(scope.agent.Settings.Policy, spec.Change)
	if err != nil {
		return write, invalid("%v", err)
	}
	language := personalagent.LanguageOf(scope.agent.Settings, s.accountLocale(ctx, scope.agent.UserID))
	write.subject = personalagent.RuleSummary(language, spec.Change)
	if plan.Propose {
		write.proposalKind = store.PersonalAgentProposalRelaxRules
	}
	write.apply = func(ctx context.Context) (any, error) {
		return s.applyRuleChange(ctx, scope.agent.UserID, args)
	}
	return write, nil
}

func (s *Server) applyRuleChange(ctx context.Context, userID string, args map[string]json.RawMessage) (any, error) {
	var spec paRuleSpec
	if err := decodeArgs(args, &spec); err != nil {
		return nil, err
	}
	agent, err := s.store.GetPersonalAgent(ctx, userID)
	if err != nil {
		return nil, err
	}
	settings := agent.Settings
	settings.Policy = personalagent.WithRule(settings.Policy, spec.Change)
	if _, err := s.store.SavePersonalAgentSettings(ctx, userID, settings); err != nil {
		return nil, err
	}
	return map[string]string{"status": "applied", "action": spec.Change.Action, "decision": spec.Change.Decision}, nil
}

// paMemorySpec is remember's arguments.
type paMemorySpec struct {
	Op   string           `json:"op"`
	Item paMemoryItemArgs `json:"item"`
}

// paMemoryItemArgs is remember's item: quote is the person's words the
// fact rests on, which the server looks for in what they wrote (§2).
type paMemoryItemArgs struct {
	VaultID          string `json:"vaultId,omitempty"`
	IntentKey        string `json:"intentKey,omitempty"`
	Title            string `json:"title,omitempty"`
	ExpiresAt        string `json:"expiresAt,omitempty"`
	ExpectedRevision *int64 `json:"expectedRevision,omitempty"`
	ExpectedHash     string `json:"expectedHash,omitempty"`
	store.PersonalAgentMemoryInput
	Quote string `json:"quote,omitempty"`
}

// Why a fact the assistant gave as the person's waits for them.
const (
	memoryNoteUngrounded = "The quote is not in anything the person wrote in this conversation (a document, web page, file, helper's output or Foundry's own notice is not their words), so this waits until they confirm it in settings; do not rely on it yet. If the person did say it, quote their exact words; if you concluded it, set item.inferred."
	memoryNoteExternal   = "This did not come from the person's own words in this conversation, so it waits until they confirm it in settings; do not rely on it yet."
)

// planRemember stores, corrects or forgets one fact about the person. A
// fact given as the person's is theirs only when its quote is found in
// what they wrote in this conversation; otherwise it waits for them. Its
// audit keeps the op and the item id, never the content or quote:
// forgetting erases it everywhere (§2).
func (s *Server) planRemember(ctx context.Context, scope paScope, args map[string]json.RawMessage) (paWrite, error) {
	var spec paMemorySpec
	if err := decodeArgs(args, &spec); err != nil {
		return paWrite{argsSummary: "remember"}, err
	}
	write := paWrite{argsSummary: strings.TrimSpace(spec.Op + " " + spec.Item.ID),
		spec: map[string]any{"op": spec.Op, "item": map[string]string{"id": spec.Item.ID}}}
	item := store.PersonalAgentMemoryItem{
		UserID: scope.agent.UserID, SourceSessionID: scope.sessionID, SourceInputID: scope.turn.ID,
	}
	note := ""
	switch spec.Op {
	case store.PersonalAgentMemoryAdd, store.PersonalAgentMemoryUpdate:
		content, err := personalagent.MemoryContent(spec.Item.Content)
		if err != nil {
			return write, invalid("%v", err)
		}
		item.Content = content
		grounded := false
		if !spec.Item.Inferred {
			quote := strings.TrimSpace(spec.Item.Quote)
			if quote == "" {
				return write, invalid("item.quote is required: copy the person's own words this fact rests on from their messages in this conversation, or set item.inferred when you concluded it")
			}
			said, err := s.personSaid(ctx, scope.sessionID, scope.turn)
			if err != nil {
				return write, err
			}
			grounded = personalagent.QuoteGrounded(quote, said)
			note = memoryNoteExternal
			if len(said) > 0 {
				note = memoryNoteUngrounded
			}
		}
		item.Origin = personalagent.MemoryOrigin(spec.Item.Inferred, grounded)
		item.Status = personalagent.MemoryStatus(item.Origin)
	case store.PersonalAgentMemoryForget:
	default:
		return write, invalid("op must be add, update or forget")
	}
	if planned, handled, err := s.planRememberSource(ctx, scope, spec, item, write); handled {
		return planned, err
	}
	if spec.Op != store.PersonalAgentMemoryAdd {
		existing, err := s.store.GetPersonalAgentMemory(ctx, scope.agent.UserID, strings.TrimSpace(spec.Item.ID))
		if err != nil || existing.Status == store.PersonalAgentMemoryForgotten || existing.Status == store.PersonalAgentMemorySuperseded {
			return write, refuse(store.PersonalAgentRefusalInvalid, http.StatusNotFound, "no current memory item %q", spec.Item.ID)
		}
	}
	write.apply = func(ctx context.Context) (any, error) {
		userID := scope.agent.UserID
		var saved store.PersonalAgentMemoryItem
		var err error
		switch spec.Op {
		case store.PersonalAgentMemoryAdd:
			saved, err = s.store.AddPersonalAgentMemory(ctx, item)
		case store.PersonalAgentMemoryUpdate:
			saved, err = s.store.SupersedePersonalAgentMemory(ctx, userID, strings.TrimSpace(spec.Item.ID), item)
		default:
			if err = s.store.ForgetPersonalAgentMemory(ctx, userID, strings.TrimSpace(spec.Item.ID)); err == nil {
				return map[string]string{"status": "forgotten", "id": spec.Item.ID}, nil
			}
		}
		if err != nil {
			return nil, err
		}
		answer := map[string]any{"status": "applied", "item": saved}
		if saved.Status == store.PersonalAgentMemoryPending {
			answer["note"] = note
		}
		return answer, nil
	}
	return write, nil
}

// personSaid is what the person wrote in the assistant conversation: each
// input and message steered into a turn, without the server's notices, the
// timers' prompts or Foundry's context for a turn. Tool outputs, files and
// helpers' answers are never inputs.
func (s *Server) personSaid(ctx context.Context, sessionID string, turn store.SessionInput) ([]string, error) {
	session, err := s.store.GetAgentSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	var said []string
	add := func(input store.SessionInput) {
		if text, ok := personalagent.PersonWords(input); ok {
			said = append(said, withoutTurnContext(text))
		}
	}
	for _, event := range session.Events {
		switch {
		case event.Label == store.SessionInputEventLabel && event.Message != nil && event.Message.Kind == "user":
			input := store.SessionInput{Prompt: event.Message.Text}
			if event.Metadata != nil {
				input.TimerFire = event.Metadata.TimerFire
				input.SentBySessionID = event.Metadata.SentBySessionID
			}
			add(input)
		case event.Label == steeredIntoTurnLabel:
			input := store.SessionInput{Prompt: event.Detail}
			if event.Metadata != nil {
				input.SentBySessionID = event.Metadata.SentBySessionID
			}
			add(input)
		}
	}
	add(turn)
	return said, nil
}

// withoutTurnContext drops Foundry's context blocks (prompt.TurnContext)
// from a text.
func withoutTurnContext(text string) string {
	for {
		start := strings.Index(text, prompt.TurnContextStart)
		if start < 0 {
			return text
		}
		end := strings.Index(text[start:], prompt.TurnContextEnd)
		if end < 0 {
			return text[:start]
		}
		text = text[:start] + text[start+end+len(prompt.TurnContextEnd):]
	}
}

func (s *Server) listTasksForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	scope, err := s.paScope(ctx, call.actor)
	if err != nil {
		return "", err
	}
	statuses := mcpArgList(call.args, "status")
	if len(statuses) == 0 {
		statuses = []string{store.PersonalAgentTaskQueued, store.PersonalAgentTaskRunning, store.PersonalAgentTaskAsking}
	}
	s.refreshAssistantTasks(ctx, scope.agent.UserID)
	tasks, err := s.store.ListPersonalAgentTasks(ctx, scope.agent.UserID, statuses)
	if err != nil {
		return "", err
	}
	return encodeJSON(s.withTaskWaits(ctx, tasks))
}

func (s *Server) findWorkspaceForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	scope, err := s.paScope(ctx, call.actor)
	if err != nil {
		return "", err
	}
	query := strings.TrimSpace(mcpArgString(call.args, "query"))
	if query == "" {
		return "", &statusError{http.StatusBadRequest, errors.New("query is required: the request in the person's own words")}
	}
	limit := min(max(mcpArgNumber(call.args, "limit", 3), 1), personalagent.FindWorkspaceLimit)
	records, err := s.assistantWorkspaceCandidates(ctx, scope.agent.UserID)
	if err != nil {
		return "", err
	}
	candidates := workspacedigest.RankRecords(query, records, s.assistantNotes(ctx, scope.agent), time.Now(), limit)
	return encodeJSON(map[string]any{"candidates": candidates, "close": workspacedigest.Close(candidates)})
}

// getWorkspaceForMCP reads one project: its digest, and as include asks,
// live state, the start of its instructions and the assistant's note.
func (s *Server) getWorkspaceForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	scope, err := s.paScope(ctx, call.actor)
	if err != nil {
		return "", err
	}
	workspace, err := s.assistantWorkspace(ctx, scope, mcpArgString(call.args, "workspaceId"), false)
	if err != nil {
		return "", err
	}
	include := mcpArgList(call.args, "include")
	if len(include) == 0 {
		include = []string{"live", "instructions", "note"}
	}
	answer := map[string]any{"workspace": summarizeWorkspace(workspace)}
	if digest, err := s.workspaceDigests().Digest(ctx, scope.agent.UserID, workspace.ID); err == nil {
		answer["digest"] = digest
	}
	// Server-side, so read even while the device is offline: which
	// accounts can run a session there, and the one used without profileId.
	answer["accounts"] = s.accountsAnswer(ctx, workspace, scope.agent.UserID)
	online := workspace.DeviceID != "" && s.hub.HasConnection(workspace.DeviceID)
	if slices.Contains(include, "live") {
		answer["live"] = s.liveWorkspace(ctx, workspace, online)
	}
	if slices.Contains(include, "instructions") {
		answer["instructions"] = s.workspaceInstructions(ctx, workspace, online)
	}
	if slices.Contains(include, "note") {
		answer["note"] = s.assistantNote(ctx, scope.agent, workspace.ID)
	}
	return encodeJSON(answer)
}

func (s *Server) liveWorkspace(ctx context.Context, workspace store.WorkspaceProjection, online bool) map[string]any {
	live := map[string]any{"deviceOnline": online}
	running := []map[string]string{}
	if sessions, err := s.store.ListAgentSessionSummaries(ctx, workspace.ID); err == nil {
		for _, session := range sessions {
			if activeOrBlocked(session.Status) {
				running = append(running, map[string]string{"id": session.ID, "title": session.Title, "status": session.Status})
			}
		}
	}
	live["runningSessions"] = running
	if online {
		if connection := s.hub.connectionFor(workspace.DeviceID); connection != nil {
			inspectCtx, cancel := context.WithTimeout(ctx, sessionControlTimeout)
			defer cancel()
			payload, _ := json.Marshal(map[string]any{"workspaceId": workspace.ID, "rescan": false})
			if result, err := daemonRequest[wsWorkspaceInspectionResult](inspectCtx, connection, wsInspectWorkspaceType, payload); err == nil && result.Error == "" {
				var inspection map[string]json.RawMessage
				if json.Unmarshal(result.Inspection, &inspection) == nil && inspection["git"] != nil {
					live["git"] = inspection["git"]
				}
			}
		}
	}
	return live
}

// workspaceInstructions is the start of the project's AGENTS.md, else its
// README.
func (s *Server) workspaceInstructions(ctx context.Context, workspace store.WorkspaceProjection, online bool) map[string]any {
	if !online {
		return map[string]any{"error": "the project's computer is offline"}
	}
	for _, name := range []string{"AGENTS.md", "README.md"} {
		readCtx, cancel := context.WithTimeout(ctx, deviceFileRequestTimeout)
		file, err := s.hub.ReadWorkspaceFile(readCtx, workspace, name)
		cancel()
		if err == nil && strings.TrimSpace(file.Content) != "" {
			content := file.Content
			truncated := file.Truncated || len(content) > personalagent.DigestSourceBytes
			if len(content) > personalagent.DigestSourceBytes {
				content = strings.ToValidUTF8(content[:personalagent.DigestSourceBytes], "")
			}
			return map[string]any{"path": name, "content": content, "truncated": truncated}
		}
	}
	return map[string]any{"error": "no AGENTS.md or README.md"}
}

// assistantNotesMax bounds the routing notes find_workspace reads.
const assistantNotesMax = 100

// assistantNotes are the assistant's routing notes, cards/<workspaceId>.md
// in its folder, by workspace id; none while its computer is offline.
func (s *Server) assistantNotes(ctx context.Context, agent store.PersonalAgent) map[string]string {
	notes := map[string]string{}
	home, err := s.store.GetWorkspace(ctx, agent.WorkspaceID)
	if err != nil || home.DeviceID == "" || !s.hub.HasConnection(home.DeviceID) {
		return notes
	}
	listCtx, cancel := context.WithTimeout(ctx, deviceFileRequestTimeout)
	defer cancel()
	entries, err := s.hub.ListWorkspaceTree(listCtx, home, "cards")
	if err != nil {
		return notes
	}
	for _, entry := range entries {
		workspaceID, isNote := strings.CutSuffix(entry.Name, ".md")
		if entry.IsDirectory || !isNote || len(notes) >= assistantNotesMax {
			continue
		}
		if file, err := s.hub.ReadWorkspaceFile(listCtx, home, "cards/"+entry.Name); err == nil {
			notes[workspaceID] = file.Content
		}
	}
	return notes
}

// assistantNote is the assistant's routing note on a project,
// cards/<workspaceId>.md in its own folder.
func (s *Server) assistantNote(ctx context.Context, agent store.PersonalAgent, workspaceID string) map[string]any {
	home, err := s.store.GetWorkspace(ctx, agent.WorkspaceID)
	if err != nil || home.DeviceID == "" || !s.hub.HasConnection(home.DeviceID) {
		return map[string]any{"error": "your own computer is offline"}
	}
	path := "cards/" + workspaceID + ".md"
	readCtx, cancel := context.WithTimeout(ctx, deviceFileRequestTimeout)
	defer cancel()
	file, err := s.hub.ReadWorkspaceFile(readCtx, home, path)
	if err != nil {
		return map[string]any{"path": path, "content": ""}
	}
	return map[string]any{"path": path, "content": file.Content}
}
