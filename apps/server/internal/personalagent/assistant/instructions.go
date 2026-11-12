package assistant

import (
	"cmp"
	"context"
	"fmt"
	"log"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/permission"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/workspacedigest"
)

// What a run of the person's assistant gets (docs/personal-agent.md §12),
// however the run started (their message, a timer, a server notice, a
// message that found it idle): the files Foundry writes into its folder
// before the run (prompt.RunFiles: AGENTS.md with the person's rules and
// confirmed facts, which Claude Code and Codex load natively, the project
// index, its canonical skills and worked examples); and the turn's context
// (prompt.TurnContext: the time in the person's zone and, for a captured
// message, its receipt), facts added to the turn's input as Foundry's words.
// Live state comes from tools. The input stored for the turn stays the
// person's own, which is what `remember` judges.

// Run is what a run of the person's assistant is given.
type Run struct {
	// Files are written into the assistant's folder before the run.
	Files []personalagent.WorkspaceFile
	// TurnContext goes with the turn's input.
	TurnContext string
}

// RunFor is what a run of the session needs as the person's
// assistant; ok is false for any other session. A run of the assistant
// does not start without it.
func (s *Service) RunFor(ctx context.Context, session store.AgentSession) (run Run, ok bool, err error) {
	agent, ok := s.Conversation(ctx, session)
	if !ok {
		return run, false, nil
	}
	input, err := s.PromptInput(ctx, agent, time.Now())
	if err != nil {
		return run, true, err
	}
	if all, e := s.store.ListKnowledgePublications(ctx, agent.UserID); e == nil {
		for _, grant := range all {
			if grant.Scope == "memory_root" && s.knowledge.CheckPublication(ctx, session, grant) == nil {
				input.MemoryPublications = append(input.MemoryPublications, grant.ID)
			}
		}
	}
	turnContext := prompt.TurnContext(input)
	if entry, err := s.store.PersonalAgentInboxByInput(ctx, agent.ID, session.Input.ID); err == nil {
		root := entry
		if entry.RootID != entry.ID {
			if source, err := s.store.GetPersonalAgentInbox(ctx, agent.ID, entry.RootID); err == nil {
				root = source
			}
		}
		receipt := fmt.Sprintf("Receipt: %s; original source: %s; receivedAt: %s; time zone: %s.\n", entry.ID, root.ID, root.CreatedAt, cmp.Or(root.Timezone, "unknown"))
		if root.ID != entry.ID && root.SessionID != "" {
			receipt += fmt.Sprintf("A retry the person asked for; previous attempt: %s.\n", root.SessionID)
		}
		turnContext = strings.Replace(turnContext, prompt.TurnContextEnd, receipt+prompt.TurnContextEnd, 1)
	}
	files := prompt.RunFiles(input)
	if s.channelSkills != nil {
		files = append(files, s.channelSkills(ctx, agent)...)
	}
	return Run{Files: files, TurnContext: turnContext}, true, nil
}

// WithTurnContext is the turn's input as the assistant reads it: the
// person's words first (a leading "/skill" keeps working), then Foundry's
// context.
func WithTurnContext(input store.SessionInput, turnContext string) store.SessionInput {
	if turnContext == "" {
		return input
	}
	if strings.TrimSpace(input.Prompt) == "" {
		input.Prompt = turnContext
	} else {
		input.Prompt = strings.TrimRight(input.Prompt, "\n") + "\n\n" + turnContext
	}
	return input
}

// PromptInput is everything the assistant's prompt is filled
// from, as of now.
func (s *Service) PromptInput(ctx context.Context, agent store.PersonalAgent, now time.Time) (prompt.Input, error) {
	user, err := s.store.GetUser(ctx, agent.UserID)
	if err != nil {
		return prompt.Input{}, err
	}
	settings := agent.Settings
	if policy, err := personalagent.CompletePolicy(settings.Policy); err == nil {
		settings.Policy = policy
	} else {
		settings.Policy = personalagent.DefaultPolicy()
	}
	settings.Limits = personalagent.EffectiveLimits(settings.Limits)
	memory, err := s.turnMemory(ctx, agent)
	if err != nil {
		return prompt.Input{}, err
	}
	digests := s.digests
	records, err := s.workspaceCandidates(ctx, agent)
	if err != nil {
		return prompt.Input{}, err
	}
	workspaces := make([]store.WorkspaceDigest, len(records))
	for i, record := range records {
		workspaces[i] = record.Digest
	}
	devices, err := digests.Devices(ctx, agent.UserID)
	if err != nil {
		return prompt.Input{}, err
	}
	l0Index := workspacedigest.Index(workspaces, devices, now)
	places, err := s.ownDevicePlacements(ctx, devices, now)
	if err != nil {
		return prompt.Input{}, err
	}
	return prompt.Input{
		Now:                           now,
		PersonName:                    cmp.Or(user.DisplayName, user.Username),
		Settings:                      settings,
		AccountLanguage:               user.Locale,
		HomeDeviceID:                  agent.HomeDeviceID,
		Memory:                        memory,
		Workspaces:                    workspaces,
		Devices:                       devices,
		L0Index:                       l0Index,
		Places:                        places,
		DirectChatPreviousWorkspaceID: s.directChatPrior(ctx, agent),
		ConnectorsURL:                 s.WebURL("/connectors"),
		SettingsURL:                   s.WebURL(personalagent.AssistantSettingsPath(agent.ID)),
	}, nil
}

// ownDevicePlacements are the labels and detected facts of the person's
// devices (their digests), by device id.
func (s *Service) ownDevicePlacements(ctx context.Context, digests []store.DeviceDigest, now time.Time) (map[string]store.DevicePlacement, error) {
	all, err := s.store.ListDevices(ctx)
	if err != nil {
		return nil, err
	}
	owned := []store.DeviceProjection{}
	for _, device := range all {
		if slices.ContainsFunc(digests, func(digest store.DeviceDigest) bool { return digest.DeviceID == device.ID }) {
			owned = append(owned, device)
		}
	}
	return s.devices.Placements(ctx, owned, now)
}

// TakesDirectChat reports whether the assistant takes the person's Feishu
// direct chat on Connectors app appID (§10): the setting is on, for its
// chosen app or, with none chosen, for any.
func TakesDirectChat(settings store.PersonalAgentSettings, appID string) bool {
	return settings.FeishuDirectChat && (settings.FeishuAppID == "" || settings.FeishuAppID == appID)
}

// directChatPrior is where the person's Feishu direct chat went before the
// assistant took it over (§14), "" when nowhere else.
func (s *Service) directChatPrior(ctx context.Context, agent store.PersonalAgent) string {
	routes, err := s.store.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{})
	if err != nil {
		log.Printf("personal agent %s: read direct chat routes: %v", agent.UserID, err)
		return ""
	}
	for _, route := range routes {
		if route.Kind == store.FeishuRouteP2P && route.BoundUserID == agent.UserID &&
			route.WorkspaceID != "" && route.WorkspaceID != agent.WorkspaceID && TakesDirectChat(agent.Settings, route.AppID) {
			return route.WorkspaceID
		}
	}
	return ""
}

// workspaceCandidates is the routing projection of readable history.
// A removed device's digest stays readable through get_workspace and its old
// work stays attributable, but neither the prompt index nor find_workspace may
// propose it for new work. Shared workspaces retain their membership scope.
// Digests are kept per person; an assistant reads only those of the
// workspaces its permission package allows.
func (s *Service) workspaceCandidates(ctx context.Context, agent store.PersonalAgent) ([]store.WorkspaceDigestRecord, error) {
	records, err := s.digests.Sync(ctx, agent.UserID)
	if err != nil {
		return nil, err
	}
	pkg, err := s.store.GetPermissionPackage(ctx, agent.UserID, agent.PermissionPackageID)
	if err != nil {
		return nil, err
	}
	access := permission.Access{Applicable: true, Agent: agent, Package: pkg}
	records = slices.DeleteFunc(records, func(record store.WorkspaceDigestRecord) bool {
		return !access.WorkspaceAllowed(record.Digest.WorkspaceID)
	})
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return nil, err
	}
	available := map[string]bool{"": true}
	for _, device := range devices {
		available[device.ID] = true
	}
	candidates := make([]store.WorkspaceDigestRecord, 0, len(records))
	for _, record := range records {
		if available[record.Digest.DeviceID] {
			candidates = append(candidates, record)
		}
	}
	return candidates, nil
}

// WithTaskWaits marks the unfinished tasks whose session is queued for an
// offline computer with that computer's name (PersonalAgentTask.WaitingFor).
func (s *Service) WithTaskWaits(ctx context.Context, tasks []store.PersonalAgentTask) []store.PersonalAgentTask {
	for i, task := range tasks {
		if task.SessionID == "" || (task.Status != store.PersonalAgentTaskQueued && task.Status != store.PersonalAgentTaskRunning) {
			continue
		}
		session, err := s.store.GetAgentSessionSummary(ctx, task.SessionID)
		if err == nil && s.sessions.WaitsForDevice(session) {
			tasks[i].WaitingFor = s.devices.Label(ctx, session.DeviceID)
		}
	}
	return tasks
}
