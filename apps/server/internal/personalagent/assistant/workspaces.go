package assistant

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/workspacedigest"
)

// The assistant's workspace tools (docs/personal-agent.md §5): finding and
// reading the person's projects, and the planners of the writes that
// create, change and archive them.

// workspaceSummary is a project as the assistant's tools answer it.
type workspaceSummary struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	DeviceID   string `json:"deviceId,omitempty"`
	LocalPath  string `json:"localPath,omitempty"`
	ArchivedAt string `json:"archivedAt,omitempty"`
}

func summarizeWorkspace(workspace store.WorkspaceProjection) workspaceSummary {
	return workspaceSummary{ID: workspace.ID, Name: workspace.Name, DeviceID: workspace.DeviceID, LocalPath: workspace.LocalPath, ArchivedAt: workspace.ArchivedAt}
}

// workspaceResult is a write tool's answer when it was applied.
type workspaceResult struct {
	Status     string                           `json:"status"`
	Before     *workspaceSummary                `json:"before,omitempty"`
	Workspace  workspaceSummary                 `json:"workspace"`
	Purpose    string                           `json:"purpose,omitempty"`
	Skills     []store.WorkspaceSkillBinding    `json:"skills,omitempty"`
	Connectors *store.WorkspaceExternalAccounts `json:"connectors,omitempty"`
	// Place is where a new project went and why.
	Place *store.PersonalAgentPlacement `json:"place,omitempty"`
}

// createSpec is create_workspace's arguments, resolved.
type createSpec struct {
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

func oneLineName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 80 || strings.ContainsAny(name, "\r\n\t") {
		return "", invalid("name must be 1-80 characters on one line")
	}
	return name, nil
}

const purposeMaxChars = 600

func (s *Service) planCreateWorkspace(ctx context.Context, scope Scope, args map[string]json.RawMessage) (Write, error) {
	var spec createSpec
	if err := DecodeArgs(args, &spec); err != nil {
		return Write{ArgsSummary: "create_workspace"}, err
	}
	write := Write{ArgsSummary: fmt.Sprintf("create %q (%s)", spec.Name, spec.Source.Kind), Subject: spec.Name}
	name, err := oneLineName(spec.Name)
	if err != nil {
		return write, err
	}
	spec.Name, spec.Purpose = name, strings.TrimSpace(spec.Purpose)
	if utf8.RuneCountInString(spec.Purpose) > purposeMaxChars {
		return write, invalid("purpose is at most %d characters: one sentence", purposeMaxChars)
	}
	switch spec.Source.Kind {
	case personalagent.WorkspaceCreateEmpty:
	case personalagent.WorkspaceCreateClone:
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
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return write, err
	}
	device, place, err := s.createDevice(ctx, scope, devices, spec, needs)
	if err != nil {
		return write, err
	}
	spec.DeviceID, write.DeviceID = device.ID, device.ID
	action := store.PersonalAgentActionCreateWorkspace
	if spec.Source.Kind == "existing" && !withinAny(device.ManagedRoots, spec.Source.Path) {
		action = store.PersonalAgentActionRegisterFolder
		write.Subject = spec.Source.Path
	}
	write.Spec = spec
	usage, err := s.usage(ctx, scope.Agent)
	if err != nil {
		return write, err
	}
	if err := personalagent.CheckNewWorkspace(scope.Agent.Settings.Limits, usage); err != nil {
		return write, limitRefusal(err, s.settingsURL(scope.Agent))
	}
	write.Decisions = []Decision{{action, personalagent.Decide(scope.Agent.Settings.Policy, action)}}
	write.Apply = func(ctx context.Context) (any, error) {
		request := personalagent.NewWorkspace{DeviceID: spec.DeviceID, Name: spec.Name, Purpose: spec.Purpose}
		if spec.Source.Kind == "existing" {
			request.Path = spec.Source.Path
		} else {
			request.Create = &personalagent.WorkspaceSource{Kind: spec.Source.Kind, URL: strings.TrimSpace(spec.Source.URL), GitInit: spec.Source.Kind == personalagent.WorkspaceCreateEmpty && spec.Source.GitInit}
		}
		if spec.Source.Kind == personalagent.WorkspaceCreateEmpty {
			request.Create.Files = []personalagent.WorkspaceFile{{Path: "AGENTS.md", Content: fmt.Sprintf("# %s\n\n## Purpose\n%s\n\n## Working agreement\nKeep domain artifacts here. Preserve their source and version; do not treat summaries as current execution status. Link existing work before starting a duplicate. Ask when the goal, authority or permissions are unclear. Propose changes to these instructions for review when a session may depend on them.\n\n## Open context\nConfirm authoritative inputs, desired outputs and completion evidence with the person as needed. Do not invent personal facts.\n", spec.Name, spec.Purpose)}}
		}
		actor := personalagent.WorkspaceActor{UserID: scope.Agent.UserID, SessionID: scope.SessionID}
		lifecycle := s.workspaces
		workspace, err := lifecycle.CreateWorkspace(ctx, actor, request)
		if err != nil {
			return nil, err
		}
		result := workspaceResult{Status: "applied", Workspace: summarizeWorkspace(workspace), Purpose: spec.Purpose, Place: &place}
		if err := s.permitCreatedWorkspace(ctx, scope.Agent, workspace.ID); err != nil {
			return result, fmt.Errorf("the project %s was created, but adding it to this assistant's permissions failed: %w", workspace.ID, err)
		}
		if len(skills) > 0 {
			if result.Skills, err = lifecycle.ChangeWorkspaceSkills(ctx, actor, workspace.ID, skills, nil); err != nil {
				return result, fmt.Errorf("the project %s was created, but adding its skills failed: %w", workspace.ID, err)
			}
		}
		return result, nil
	}
	return write, nil
}

// permitCreatedWorkspace adds a workspace the assistant itself created to
// its permission package, so the project it just made is one it reaches:
// a listed package includes it, an exclusion of it is dropped, and a
// package that reaches every workspace stays as it is.
func (s *Service) permitCreatedWorkspace(ctx context.Context, agent store.PersonalAgent, workspaceID string) error {
	pkg, err := s.store.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil {
		return err
	}
	access := permission.Access{Applicable: true, Agent: agent, Package: pkg}
	if access.WorkspaceAllowed(workspaceID) {
		return nil
	}
	rule := &pkg.Workspaces
	rule.Exclude = slices.DeleteFunc(rule.Exclude, func(id string) bool { return id == workspaceID })
	if rule.Scope == store.PermissionListScopeListed || len(rule.Include) > 0 {
		rule.Include = append(rule.Include, workspaceID)
	}
	_, err = s.store.SavePermissionPackage(ctx, pkg)
	return err
}

// noPlace is create_workspace's answer when no computer fits; the
// assistant gets it as a result, not an error, and the audit as a refusal.
type placeRefusal struct {
	answer store.PersonalAgentNoPlace
}

func (n *placeRefusal) Error() string {
	return "no computer fits: missing " + strings.Join(n.answer.Missing, ", ")
}

// createDevice is where a new project goes (§4): the device asked
// for, which must be the person's and allow it; else personalagent.Place
// over the person's devices that allow it, online or not, by what the work
// needs and their labels and detected facts. A device whose system account
// someone else shares allows it only where the person chose it: "can start
// new projects here" (by default only the home, picked at setup) or their
// default place; never by a default such as "can work on this computer".
func (s *Service) createDevice(ctx context.Context, scope Scope, devices []store.DeviceProjection, spec createSpec, needs []store.DeviceLabel) (store.DeviceProjection, store.PersonalAgentPlacement, error) {
	shares, err := s.store.ListDeviceAccountShares(ctx)
	if err != nil {
		return store.DeviceProjection{}, store.PersonalAgentPlacement{}, err
	}
	allowed := func(device store.DeviceProjection) bool {
		settings := scope.device(device.ID)
		if len(shares[device.ID]) > 0 && !settings.AllowCreate && device.ID != scope.Agent.Settings.PreferredDeviceID {
			return false
		}
		if spec.Source.Kind == "existing" && !withinAny(device.ManagedRoots, spec.Source.Path) {
			return settings.AllowWork
		}
		return settings.AllowCreate
	}
	owned := []store.DeviceProjection{}
	for _, device := range devices {
		if scope.owned[device.ID] {
			owned = append(owned, device)
		}
	}
	placements, err := s.devices.Placements(ctx, owned, time.Now())
	if err != nil {
		return store.DeviceProjection{}, store.PersonalAgentPlacement{}, err
	}
	candidates := make([]personalagent.PlaceCandidate, 0, len(owned))
	for _, device := range owned {
		placement := placements[device.ID]
		candidates = append(candidates, personalagent.PlaceCandidate{
			DeviceID: device.ID, Name: device.Label, Online: s.devices.Connected(device.ID), Allowed: allowed(device),
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
				return device, store.PersonalAgentPlacement{}, notAllowed("creating projects on that computer", s.settingsURL(scope.Agent))
			}
			reason := "the computer you named"
			if candidate.Shared != "" {
				reason += "; " + candidate.Shared + ", which the person chose to allow"
			}
			return device, store.PersonalAgentPlacement{
				Computer: device.Label, DeviceID: device.ID, Online: candidate.Online,
				Reason: reason, Unverified: emptyNil(candidate.Lacks(needs)),
			}, nil
		}
		return store.DeviceProjection{}, store.PersonalAgentPlacement{}, refuse(store.PersonalAgentRefusalNotOwner, http.StatusUnprocessableEntity,
			"not allowed: %s is not one of the person's own computers", spec.DeviceID)
	}
	defaultID := cmp.Or(scope.Agent.Settings.PreferredDeviceID, scope.Agent.HomeDeviceID)
	if err := store.RequireDeviceAvailable(ctx, s.store, defaultID); err != nil {
		return store.DeviceProjection{}, store.PersonalAgentPlacement{}, err
	}
	place, err := personalagent.Place(candidates, needs, defaultID)
	var none *personalagent.NoPlace
	switch {
	case errors.Is(err, personalagent.ErrNoComputer):
		return store.DeviceProjection{}, store.PersonalAgentPlacement{}, notAllowed("creating projects: no computer of the person's allows it", s.settingsURL(scope.Agent))
	case errors.As(err, &none):
		return store.DeviceProjection{}, store.PersonalAgentPlacement{}, &placeRefusal{noPlaceAnswer(none)}
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
			". create_workspace accepts a deviceId from computers; a computer marked notAllowed can be allowed in your settings.",
	}
	for _, gap := range none.Computers {
		answer.Computers = append(answer.Computers, store.PersonalAgentPlaceGap{
			Name: gap.Name, DeviceID: gap.DeviceID, Online: gap.Online, Lacks: gap.Lacks, NotAllowed: gap.NotAllowed,
		})
	}
	return answer
}

// withinAny reports whether a device path lies inside one of the device's
// managed roots, by the device's path rules rather than the server's.
func withinAny(roots []string, path string) bool {
	for _, root := range roots {
		if store.InsideDeviceRoot(root, path) {
			return true
		}
	}
	return false
}

// resolveSkills turns skill names (or ids) into library skill ids.
// Foundry's built-in skills are always there and need nothing.
func (s *Service) resolveSkills(ctx context.Context, names []string) ([]string, error) {
	if len(names) == 0 {
		return nil, nil
	}
	library, err := s.store.ListPromotedSkills(ctx)
	if err != nil {
		return nil, err
	}
	builtin := map[string]bool{}
	for _, name := range s.server.BuiltinSkills() {
		builtin[strings.ToLower(name)] = true
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

// scopedWorkspace is a workspace the assistant names: visible to the
// person, and with manage, one the person owns on their own device.
func (s *Service) scopedWorkspace(ctx context.Context, scope Scope, workspaceID string, manage bool) (store.WorkspaceProjection, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return store.WorkspaceProjection{}, invalid("workspaceId is required")
	}
	workspace, err := s.store.GetWorkspace(ctx, workspaceID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && !scope.reaches(workspaceID)) {
		return store.WorkspaceProjection{}, refuse(store.PersonalAgentRefusalInvalid, http.StatusNotFound, "project not found")
	}
	if err != nil {
		return workspace, err
	}
	if manage && !scope.manages(workspace) {
		return workspace, refuse(store.PersonalAgentRefusalNotOwner, http.StatusUnprocessableEntity,
			"not allowed: the person does not own %q or the computer it is on, so you may not change it; its owner can change it in the project's settings.", workspace.Name)
	}
	return workspace, nil
}

// updateSpec is update_workspace's arguments.
type updateSpec struct {
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

func (s *Service) planUpdateWorkspace(ctx context.Context, scope Scope, args map[string]json.RawMessage) (Write, error) {
	var spec updateSpec
	if err := DecodeArgs(args, &spec); err != nil {
		return Write{ArgsSummary: "update_workspace"}, err
	}
	write := Write{WorkspaceID: spec.WorkspaceID, ArgsSummary: updateSummary(spec), Spec: spec}
	workspace, err := s.scopedWorkspace(ctx, scope, spec.WorkspaceID, true)
	if err != nil {
		return write, err
	}
	write.Subject = workspace.Name
	policy := scope.Agent.Settings.Policy
	decide := func(action string) {
		write.Decisions = append(write.Decisions, Decision{action, personalagent.Decide(policy, action)})
	}
	var details personalagent.WorkspaceDetails
	if spec.Name != nil {
		name, err := oneLineName(*spec.Name)
		if err != nil {
			return write, err
		}
		details.Name = &name
		if name != workspace.Name {
			write.RenameTo = name
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
		created, err := s.store.PersonalAgentCreatedWorkspace(ctx, scope.Agent.ID, workspace.ID)
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
		if err != nil || account.OwnerUserID != scope.Agent.UserID {
			return write, invalid("connector account %s is not one of the person's", accountID)
		}
	}
	if len(spec.Connectors.Add) > 0 {
		// The first binding of each account to the project is the policy's;
		// binding a pair again is not new (§4).
		decision := store.PersonalAgentAuto
		for _, accountID := range spec.Connectors.Add {
			bound, err := s.store.PersonalAgentConnectorBoundBefore(ctx, scope.Agent.ID, workspace.ID, accountID)
			if err != nil {
				return write, err
			}
			if !bound {
				decision = personalagent.Decide(policy, store.PersonalAgentActionBindConnector)
			}
		}
		write.Decisions = append(write.Decisions, Decision{store.PersonalAgentActionBindConnector, decision})
	}
	if len(spec.Connectors.Remove) > 0 {
		decide(store.PersonalAgentActionUnbindConnector)
	}
	if len(write.Decisions) == 0 {
		return write, invalid("nothing to change: give a name, a purpose, skills or connectors")
	}
	write.Apply = func(ctx context.Context) (any, error) {
		actor := personalagent.WorkspaceActor{UserID: scope.Agent.UserID, SessionID: scope.SessionID}
		lifecycle := s.workspaces
		before := summarizeWorkspace(workspace)
		result := workspaceResult{Status: "applied", Before: &before, Workspace: before}
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

func updateSummary(spec updateSpec) string {
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

// archiveSpec is archive_workspace's arguments.
type archiveSpec struct {
	WorkspaceID string `json:"workspaceId"`
	Restore     bool   `json:"restore,omitempty"`
}

func (s *Service) planArchiveWorkspace(ctx context.Context, scope Scope, args map[string]json.RawMessage) (Write, error) {
	var spec archiveSpec
	if err := DecodeArgs(args, &spec); err != nil {
		return Write{ArgsSummary: "archive_workspace"}, err
	}
	action, verb := store.PersonalAgentActionArchive, "archive "
	if spec.Restore {
		action, verb = store.PersonalAgentActionRestore, "restore "
	}
	write := Write{WorkspaceID: spec.WorkspaceID, ArgsSummary: verb + spec.WorkspaceID, Spec: spec}
	workspace, err := s.scopedWorkspace(ctx, scope, spec.WorkspaceID, true)
	if err != nil {
		return write, err
	}
	if workspace.ID == scope.Agent.WorkspaceID {
		return write, refuse(store.PersonalAgentRefusalNotAllowed, http.StatusUnprocessableEntity, "not allowed: your own space cannot be archived")
	}
	write.Subject = workspace.Name
	write.Decisions = []Decision{{action, personalagent.Decide(scope.Agent.Settings.Policy, action)}}
	write.Apply = func(ctx context.Context) (any, error) {
		actor := personalagent.WorkspaceActor{UserID: scope.Agent.UserID, SessionID: scope.SessionID}
		apply := s.workspaces.ArchiveWorkspace
		if spec.Restore {
			apply = s.workspaces.RestoreWorkspace
		}
		updated, err := apply(ctx, actor, workspace.ID)
		if err != nil {
			return nil, err
		}
		before := summarizeWorkspace(workspace)
		return workspaceResult{Status: "applied", Before: &before, Workspace: summarizeWorkspace(updated)}, nil
	}
	return write, nil
}

// FindWorkspace is find_workspace: the person's projects ranked for a
// request in their words, at most limit.
func (s *Service) FindWorkspace(ctx context.Context, scope Scope, query string, limit int) (map[string]any, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, &personalagent.Refusal{Status: http.StatusBadRequest, Err: errors.New("query is required: the request in the person's own words")}
	}
	limit = min(max(limit, 1), personalagent.FindWorkspaceLimit)
	records, err := s.workspaceCandidates(ctx, scope.Agent)
	if err != nil {
		return nil, err
	}
	records = slices.DeleteFunc(records, func(record store.WorkspaceDigestRecord) bool {
		return !scope.reaches(record.Digest.WorkspaceID)
	})
	candidates := workspacedigest.RankRecords(query, records, s.routingNotes(ctx, scope.Agent), time.Now(), limit)
	return map[string]any{"candidates": candidates, "close": workspacedigest.Close(candidates)}, nil
}

// GetWorkspace is get_workspace: one project, its digest, and as include
// asks, live state, the start of its instructions and the assistant's note.
func (s *Service) GetWorkspace(ctx context.Context, scope Scope, workspaceID string, include []string) (map[string]any, error) {
	workspace, err := s.scopedWorkspace(ctx, scope, workspaceID, false)
	if err != nil {
		return nil, err
	}
	if len(include) == 0 {
		include = []string{"live", "instructions", "note"}
	}
	answer := map[string]any{"workspace": summarizeWorkspace(workspace)}
	if digest, err := s.digests.Digest(ctx, scope.Agent.UserID, workspace.ID); err == nil {
		answer["digest"] = digest
	}
	// Server-side, so read even while the device is offline: which
	// accounts can run a session there, and the one used without profileId.
	answer["accounts"] = s.accounts.Answer(ctx, workspace, scope.Agent.UserID)
	online := workspace.DeviceID != "" && s.devices.Connected(workspace.DeviceID)
	if slices.Contains(include, "live") {
		answer["live"] = s.liveWorkspace(ctx, workspace, online)
	}
	if slices.Contains(include, "instructions") {
		answer["instructions"] = s.workspaceInstructions(ctx, workspace, online)
	}
	if slices.Contains(include, "note") {
		answer["note"] = s.routingNote(ctx, scope.Agent, workspace.ID)
	}
	return answer, nil
}

func (s *Service) liveWorkspace(ctx context.Context, workspace store.WorkspaceProjection, online bool) map[string]any {
	live := map[string]any{"deviceOnline": online}
	running := []map[string]string{}
	if summaries, err := s.store.ListAgentSessionSummaries(ctx, workspace.ID); err == nil {
		for _, session := range summaries {
			if store.IsActiveSessionStatus(session.Status) {
				running = append(running, map[string]string{"id": session.ID, "title": session.Title, "status": session.Status})
			}
		}
	}
	live["runningSessions"] = running
	if online {
		if git, ok := s.devices.WorkspaceGit(ctx, workspace); ok {
			live["git"] = git
		}
	}
	return live
}

// workspaceInstructions is the start of the project's AGENTS.md, else its
// README.
func (s *Service) workspaceInstructions(ctx context.Context, workspace store.WorkspaceProjection, online bool) map[string]any {
	if !online {
		return map[string]any{"error": "the project's computer is offline"}
	}
	for _, name := range []string{"AGENTS.md", "README.md"} {
		readCtx, cancel := context.WithTimeout(ctx, s.fileTimeout)
		file, err := s.devices.ReadWorkspaceFile(readCtx, workspace, name)
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

// routingNotesMax bounds the routing notes find_workspace reads.
const routingNotesMax = 100

// routingNotes are the assistant's routing notes, cards/<workspaceId>.md
// in its folder, by workspace id; none while its computer is offline.
func (s *Service) routingNotes(ctx context.Context, agent store.PersonalAgent) map[string]string {
	notes := map[string]string{}
	home, err := s.store.GetWorkspace(ctx, agent.WorkspaceID)
	if err != nil || home.DeviceID == "" || !s.devices.Connected(home.DeviceID) {
		return notes
	}
	listCtx, cancel := context.WithTimeout(ctx, s.fileTimeout)
	defer cancel()
	entries, err := s.devices.ListWorkspaceTree(listCtx, home, "cards")
	if err != nil {
		return notes
	}
	for _, entry := range entries {
		workspaceID, isNote := strings.CutSuffix(entry.Name, ".md")
		if entry.IsDirectory || !isNote || len(notes) >= routingNotesMax {
			continue
		}
		if file, err := s.devices.ReadWorkspaceFile(listCtx, home, "cards/"+entry.Name); err == nil {
			notes[workspaceID] = file.Content
		}
	}
	return notes
}

// routingNote is the assistant's routing note on a project,
// cards/<workspaceId>.md in its own folder.
func (s *Service) routingNote(ctx context.Context, agent store.PersonalAgent, workspaceID string) map[string]any {
	home, err := s.store.GetWorkspace(ctx, agent.WorkspaceID)
	if err != nil || home.DeviceID == "" || !s.devices.Connected(home.DeviceID) {
		return map[string]any{"error": "your own computer is offline"}
	}
	path := "cards/" + workspaceID + ".md"
	readCtx, cancel := context.WithTimeout(ctx, s.fileTimeout)
	defer cancel()
	file, err := s.devices.ReadWorkspaceFile(readCtx, home, path)
	if err != nil {
		return map[string]any{"path": path, "content": ""}
	}
	return map[string]any{"path": path, "content": file.Content}
}
