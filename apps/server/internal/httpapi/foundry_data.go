package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Top-level fields of GET /api/foundry-data besides `workspace`, which every
// answer carries. A read may select some with ?fields=a,b; a change
// announcement (foundry_data_changed) names the fields it touched, so a
// client reads only those.
const (
	fieldRuns                   = "runs"
	fieldWorkspaces             = "workspaces"
	fieldDevices                = "devices"
	fieldProviderHealth         = "providerHealth"
	fieldAgentProfiles          = "agentProfiles"
	fieldProfiles               = "profiles"
	fieldDeviceProfiles         = "deviceProfiles"
	fieldDeviceSkillRoots       = "deviceSkillRoots"
	fieldPromotedSkills         = "promotedSkills"
	fieldWorkspaceSkills        = "workspaceSkills"
	fieldBuiltinSkills          = "builtinSkills"
	fieldWorkspaceSkillBindings = "workspaceSkillBindings"
	fieldDefaultSkillIDs        = "defaultSkillIds"
	fieldInheritedSkillIDs      = "inheritedSkillIds"
	fieldOffSkillIDs            = "offSkillIds"
	fieldSkillBundles           = "skillBundles"
	fieldWorkspaceBundleIDs     = "workspaceBundleIds"
	fieldDefaultBundleIDs       = "defaultBundleIds"
	fieldDeviceTools            = "deviceTools"
	fieldAgents                 = "agents"
	fieldWorkspaceFiles         = "workspaceFiles"
	fieldAgentSessions          = "agentSessions"
	fieldSkills                 = "skills"
	fieldIssues                 = "issues"
	fieldChats                  = "chats"
	fieldAssets                 = "assets"
)

const fieldWorkspace = "workspace"

// foundryDataFields lists every selectable field.
var foundryDataFields = []string{
	fieldRuns, fieldWorkspaces, fieldDevices, fieldProviderHealth, fieldAgentProfiles,
	fieldProfiles, fieldDeviceProfiles, fieldDeviceSkillRoots, fieldPromotedSkills,
	fieldWorkspaceSkills, fieldBuiltinSkills, fieldWorkspaceSkillBindings,
	fieldDefaultSkillIDs, fieldInheritedSkillIDs, fieldOffSkillIDs, fieldSkillBundles,
	fieldWorkspaceBundleIDs, fieldDefaultBundleIDs, fieldDeviceTools, fieldAgents,
	fieldWorkspaceFiles, fieldAgentSessions, fieldSkills, fieldIssues, fieldChats, fieldAssets,
}

// Fields a read without ?fields= leaves out: the library's whole catalog,
// which only the Skills and Skill library pages show (they select it; the
// composer's menu has workspaceSkills), and skills, which no page reads.
var foundryDataPageFields = map[string]bool{fieldPromotedSkills: true, fieldSkills: true}

// Field groups changes announce together.
var (
	// What a workspace's skill choices derive: its bindings, the skills it
	// gets by default or through bundles, and the composer's menu.
	workspaceSkillFields = []string{fieldWorkspaceSkillBindings, fieldDefaultSkillIDs,
		fieldInheritedSkillIDs, fieldOffSkillIDs, fieldWorkspaceSkills}
	// What the library's catalog and bundles derive.
	skillLibraryFields = append([]string{fieldPromotedSkills, fieldSkillBundles,
		fieldWorkspaceBundleIDs, fieldDefaultBundleIDs, fieldDevices}, workspaceSkillFields...)
	// Agents and agent profiles derive from devices, connections and their
	// bindings.
	connectionFields = []string{fieldProfiles, fieldDeviceProfiles, fieldAgentProfiles, fieldAgents}
	// What a device's skill scan changes: its skills version and tools, and
	// the dependencies the catalog finds among the skills it reports.
	deviceScanFields = []string{fieldDevices, fieldDeviceTools, fieldPromotedSkills}
	// What removing a workspace changes beyond its own data, which goes with
	// it: the workspace list, the catalog's list of the workspaces using each
	// skill and, for whoever reached a device only through the workspace,
	// the devices shown and what derives from them.
	workspaceRemovalFields = append([]string{fieldWorkspaces, fieldPromotedSkills, fieldDevices,
		fieldDeviceTools, fieldDeviceSkillRoots, fieldProviderHealth}, connectionFields...)
)

// foundryDataAnswer is what GET /api/foundry-data answers: the projection,
// and the composer's skills, which only this answer carries.
type foundryDataAnswer struct {
	store.FoundryDataProjection
	// WorkspaceSkills: the library skills the workspace selected or gets
	// from its owner's defaults, as the composer's "/" menu lists them.
	WorkspaceSkills []workspaceSkillSummary `json:"workspaceSkills,omitempty"`
}

// workspaceSkillSummary is a library skill as the composer offers it.
type workspaceSkillSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// fieldSet is a selection of foundry-data fields.
type fieldSet map[string]bool

func (f fieldSet) has(names ...string) bool {
	for _, name := range names {
		if f[name] {
			return true
		}
	}
	return false
}

// requestedFoundryDataFields reads ?fields=. Without it (or empty) a read
// gets every field but the page fields. key names the selection for the
// snapshot cache.
func requestedFoundryDataFields(raw string) (want fieldSet, key string, err error) {
	want = fieldSet{}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		for _, name := range foundryDataFields {
			if !foundryDataPageFields[name] {
				want[name] = true
			}
		}
		return want, "default", nil
	}
	for _, name := range strings.Split(raw, ",") {
		name = strings.TrimSpace(name)
		if name == "" || name == fieldWorkspace {
			continue
		}
		if !slices.Contains(foundryDataFields, name) {
			return nil, "", fmt.Errorf("unknown field %q", name)
		}
		want[name] = true
	}
	names := make([]string, 0, len(want))
	for name := range want {
		names = append(names, name)
	}
	sort.Strings(names)
	return want, strings.Join(names, ","), nil
}

func (s *Server) handleFoundryData(w http.ResponseWriter, r *http.Request) {
	actor := actorFromContext(r.Context())
	workspaceID := requestedWorkspace(actor, r.URL.Query().Get("workspaceId"))
	want, selection, err := requestedFoundryDataFields(r.URL.Query().Get("fields"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	view, err := s.visibilityFor(r.Context(), actor)
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	started := time.Now()
	// The projection is per caller: the key carries the caller's reach, so a
	// membership change never serves a stale view.
	cacheKey := workspaceID + "|" + view.scope.fingerprint() + "|" + selection
	// A snapshot is served until an event bumps the revision or its short
	// TTL passes, also while sessions run: every session status change
	// publishes an event (or invalidates), and what a running session
	// changes without one (its activity time, which agent_session_event
	// carries live) is bounded by the TTL.
	payload, err := s.projections.load(r.Context(), cacheKey, s.stream.Revision, func() ([]byte, bool, error) {
		data, err := s.foundryData(r.Context(), workspaceID, view, want)
		if err != nil {
			return nil, false, err
		}
		encoded, err := encodeFoundryData(data, want)
		if err == nil && len(encoded) > largeProjectionBytes {
			logProjectionSize(workspaceID, encoded)
		}
		return encoded, true, err
	})
	w.Header().Set("Server-Timing", fmt.Sprintf("projection;dur=%.3f", float64(time.Since(started).Microseconds())/1000))
	if err != nil {
		writeResult(w, payload, err)
		return
	}
	writeCacheableJSON(w, r, payload)
}

// encodeFoundryData encodes the selected fields and the workspace, each as
// a whole projection encodes it (an omitted empty field stays omitted).
func encodeFoundryData(data foundryDataAnswer, want fieldSet) ([]byte, error) {
	full, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(full, &fields); err != nil {
		return nil, err
	}
	for name := range fields {
		if name != fieldWorkspace && !want[name] {
			delete(fields, name)
		}
	}
	return json.Marshal(fields)
}

// foundryData projects what one caller may see of the selected fields:
// visible workspaces, the devices it owns or reaches through them, and its
// own connections. Only what the selection needs is read.
func (s *Server) foundryData(ctx context.Context, workspaceID string, view visibility, want fieldSet) (foundryDataAnswer, error) {
	timer := newPhaseTimer("foundry-data")
	defer timer.logIfSlow(time.Second)
	workspaces := view.workspaces
	if view.scope.all {
		timer.mark("ListWorkspaces")
		all, err := s.store.ListWorkspaces(ctx)
		if err != nil {
			return foundryDataAnswer{}, err
		}
		workspaces = view.scope.filterWorkspaces(all)
	}
	if workspaceID != "" && !view.scope.can(workspaceID, store.WorkspaceRoleViewer) {
		return foundryDataAnswer{}, store.ErrNotFound
	}
	workspace, err := selectWorkspace(ctx, s.store, workspaces, workspaceID)
	if err != nil {
		return foundryDataAnswer{}, err
	}
	if workspace.ID != "" {
		workspace.AccessRole = view.scope.role(workspace.ID)
	}
	data := foundryDataAnswer{FoundryDataProjection: store.FoundryDataProjection{Workspace: workspace, Workspaces: workspaces}}
	// Agents and agent profiles derive from devices, connections and their
	// bindings.
	connections := want.has(fieldAgentProfiles, fieldAgents)
	if connections || want.has(fieldDevices, fieldDeviceSkillRoots) {
		timer.mark("ListDevices")
		allDevices, err := s.store.ListDevices(ctx)
		if err != nil {
			return foundryDataAnswer{}, err
		}
		data.Devices = s.liveDevices(view.filterDevices(allDevices))
	}
	if connections || want.has(fieldProfiles) {
		timer.mark("ListProfiles")
		allProfiles, err := s.store.ListProfiles(ctx)
		if err != nil {
			return foundryDataAnswer{}, err
		}
		data.Profiles = s.overlayProfileCredentials(ctx, view.filterConnections(allProfiles))
	}
	if connections || want.has(fieldDeviceProfiles) {
		timer.mark("ListDeviceProfiles")
		deviceProfiles, err := s.store.ListDeviceProfiles(ctx, "")
		if err != nil {
			return foundryDataAnswer{}, err
		}
		data.DeviceProfiles = filterOwnedDevice(view, deviceProfiles, func(item store.DeviceProfileBinding) string { return item.DeviceID })
	}
	if want.has(fieldProviderHealth) {
		timer.mark("ListProviderHealth")
		providerHealth, err := s.store.ListProviderHealth(ctx, "")
		if err != nil {
			return foundryDataAnswer{}, err
		}
		data.ProviderHealth = workspaceOfficialSkills(filterByDevice(view, providerHealth, func(item store.ProviderHealth) string { return item.DeviceID }), workspace.DeviceID)
	}
	var agentProfiles []store.AgentProfileProjection
	if connections {
		timer.mark("ListAgentProfiles")
		listed, err := s.store.ListAgentProfiles(ctx, "")
		if err != nil {
			return foundryDataAnswer{}, err
		}
		agentProfiles = filterByDevice(view, s.overlayServerCredential(ctx, listed),
			func(item store.AgentProfileProjection) string { return item.DeviceID })
	}
	if want.has(fieldDeviceSkillRoots) {
		timer.mark("allEffectiveSkillRoots")
		deviceSkillRoots, err := s.allEffectiveSkillRoots(ctx, data.Devices)
		if err != nil {
			return foundryDataAnswer{}, err
		}
		data.DeviceSkillRoots = filterOwnedDevice(view, deviceSkillRoots, func(item store.DeviceSkillRoot) string { return item.DeviceID })
	}
	// The library's catalog belongs to no workspace: the Skills pages read
	// it also before there is one.
	var catalog []store.PromotedSkill
	if want.has(fieldPromotedSkills, fieldWorkspaceSkills) {
		timer.mark("ListPromotedSkills")
		if catalog, err = s.store.ListPromotedSkills(ctx); err != nil {
			return foundryDataAnswer{}, err
		}
		if want.has(fieldPromotedSkills) {
			data.PromotedSkills = view.skillUsage(slices.Clone(catalog))
		}
	}
	if tools, ok := s.store.(deviceToolStore); ok && want.has(fieldDeviceTools) {
		all, err := tools.ListDeviceTools(ctx, "")
		if err != nil {
			return foundryDataAnswer{}, err
		}
		data.DeviceTools = filterByDevice(view, all, func(item store.DeviceTool) string { return item.DeviceID })
	}
	if workspace.ID == "" {
		// Server profiles exist before any workspace does, so the settings and
		// devices views stay accurate on a fresh install.
		if connections {
			timer.mark("serverProfileProjections")
			serverProfiles, _, err := s.serverProfileProjections(ctx, workspace, data.Devices, data.Profiles, data.DeviceProfiles, agentProfiles, []store.AgentProjection{})
			if err != nil {
				return foundryDataAnswer{}, err
			}
			data.AgentProfiles = serverProfiles
		}
		data.Agents = []store.AgentProjection{}
		data.WorkspaceSkillBindings = []store.WorkspaceSkillBinding{}
		data.WorkspaceFiles = []store.WorkspaceFileEntry{}
		data.AgentSessions = []store.AgentSession{}
		data.Skills = []store.SkillPackRef{}
		data.Issues = []store.Issue{}
		data.Chats = []store.ChatThread{}
		data.Assets = []store.AssetProjection{}
		return data, nil
	}
	if connections {
		timer.mark("ListAgents")
		agents, err := s.store.ListAgents(ctx, workspace.ID, strings.TrimSpace(workspace.DeviceID))
		if err != nil {
			return foundryDataAnswer{}, err
		}
		timer.mark("serverProfileProjections")
		data.AgentProfiles, data.Agents, err = s.serverProfileProjections(ctx, workspace, data.Devices, data.Profiles, data.DeviceProfiles, agentProfiles, agents)
		if err != nil {
			return foundryDataAnswer{}, err
		}
	}
	if want.has(fieldWorkspaceFiles) {
		timer.mark("ListWorkspaceFiles")
		if data.WorkspaceFiles, err = s.store.ListWorkspaceFiles(ctx, workspace.ID); err != nil {
			return foundryDataAnswer{}, err
		}
	}
	if want.has(fieldAgentSessions) {
		timer.mark("ListAgentSessionSummaries")
		agentSessions, err := s.store.ListAgentSessionSummaries(ctx, workspace.ID)
		if err != nil {
			return foundryDataAnswer{}, err
		}
		data.AgentSessions = withoutRepeatedPrompts(summarizeAgentSessionsForList(s.reconcileAgentSessions(ctx, agentSessions)))
	}
	if want.has(fieldAssets) {
		timer.mark("ListAssets")
		if data.Assets, err = s.store.ListAssets(ctx, workspace.ID); err != nil {
			return foundryDataAnswer{}, err
		}
	}
	if want.has(fieldSkills) {
		timer.mark("ListSkills")
		if data.Skills, err = s.store.ListSkills(ctx, workspace.ID); err != nil {
			return foundryDataAnswer{}, err
		}
	}
	if want.has(fieldIssues) {
		timer.mark("ListIssues")
		if data.Issues, err = s.store.ListIssues(ctx, workspace.ID); err != nil {
			return foundryDataAnswer{}, err
		}
	}
	if want.has(fieldChats) {
		timer.mark("ListChats")
		if data.Chats, err = s.store.ListChats(ctx, workspace.ID); err != nil {
			return foundryDataAnswer{}, err
		}
	}
	if want.has(fieldRuns) {
		timer.mark("ListRuns")
		if data.Runs, err = s.store.ListRuns(ctx, workspace.ID); err != nil {
			return foundryDataAnswer{}, err
		}
	}
	if want.has(fieldWorkspaceSkillBindings, fieldWorkspaceSkills) {
		timer.mark("ListWorkspaceSkillBindings")
		if data.WorkspaceSkillBindings, err = s.store.ListWorkspaceSkillBindings(ctx, workspace.ID); err != nil {
			return foundryDataAnswer{}, err
		}
	}
	if want.has(fieldDefaultSkillIDs, fieldInheritedSkillIDs, fieldOffSkillIDs, fieldWorkspaceSkills) {
		skillSources, err := resolveWorkspaceSkills(ctx, s.store, workspace.ID)
		if err != nil {
			return foundryDataAnswer{}, err
		}
		data.DefaultSkillIDs, data.InheritedSkillIDs, data.OffSkillIDs = skillSources.DefaultIDs, skillSources.InheritedIDs, skillSources.OffIDs
	}
	if want.has(fieldWorkspaceSkills) {
		data.WorkspaceSkills = workspaceSkillSummaries(catalog, data.WorkspaceSkillBindings, data.DefaultSkillIDs)
	}
	if want.has(fieldBuiltinSkills) {
		data.BuiltinSkills = builtinSkillProjections()
	}
	if want.has(fieldSkillBundles, fieldWorkspaceBundleIDs, fieldDefaultBundleIDs) {
		timer.mark("bundleProjection")
		if data.SkillBundles, data.WorkspaceBundleIDs, data.DefaultBundleIDs, err = s.bundleProjection(ctx, workspace.ID); err != nil {
			return foundryDataAnswer{}, err
		}
	}
	return data, nil
}

// workspaceOfficialSkills keeps the skills agents ship only on the workspace
// device's rows: the composer and the Skills page show that device's alone,
// and every device's list runs to tens of kilobytes.
func workspaceOfficialSkills(rows []store.ProviderHealth, deviceID string) []store.ProviderHealth {
	for index := range rows {
		if deviceID == "" || rows[index].DeviceID != deviceID {
			rows[index].OfficialSkills = nil
		}
	}
	return rows
}

// workspaceSkillSummaries lists, in catalog order, the library skills the
// workspace selected or gets from its owner's defaults.
func workspaceSkillSummaries(catalog []store.PromotedSkill, bindings []store.WorkspaceSkillBinding, defaultIDs []string) []workspaceSkillSummary {
	ids := make(map[string]bool, len(bindings)+len(defaultIDs))
	for _, binding := range bindings {
		ids[binding.SkillID] = true
	}
	for _, id := range defaultIDs {
		ids[id] = true
	}
	summaries := []workspaceSkillSummary{}
	for _, skill := range catalog {
		if ids[skill.ID] {
			summaries = append(summaries, workspaceSkillSummary{ID: skill.ID, Name: skill.Name, Description: skill.Description})
		}
	}
	return summaries
}

// withoutRepeatedPrompts drops a summary's opening prompt where its input
// repeats it: clients read the input's.
func withoutRepeatedPrompts(sessions []store.AgentSession) []store.AgentSession {
	for index := range sessions {
		if sessions[index].Prompt == sessions[index].Input.Prompt {
			sessions[index].Prompt = ""
		}
	}
	return sessions
}
