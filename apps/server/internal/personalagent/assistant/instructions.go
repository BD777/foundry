package assistant

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"
	"sync"
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
	// A message channel's session runs in the channel's workspace, whose
	// instructions are the person's (DEV-203): Foundry adds only its own
	// facts there, the same project index and summary files as the home, so
	// routing reads them from a channel too.
	if session.WorkspaceID != agent.WorkspaceID {
		files := prompt.ProjectFilesAndIndex(input)
		files = append(files, prompt.ChannelClaudeFile())
		return Run{Files: files, TurnContext: turnContext}, true, nil
	}
	// Foundry's upkeep facts travel with the home's files, so a run also
	// refreshes what the sweep last wrote (DEV-252). A channel workspace
	// gets only the project facts above.
	input.Upkeep = s.upkeepFileFor(ctx, agent, time.Now())
	// The default instructions an AGENTS.md first starts from, so a newer
	// default is offered to the person, never applied (DEV-223).
	if st, ok := s.store.(store.WorkspaceFileStore); ok {
		if _, err := st.AssistantInstructionsDefault(ctx, agent.ID); errors.Is(err, store.ErrNotFound) {
			if err := st.SetAssistantInstructionsDefault(ctx, agent.ID, prompt.DefaultInstructionsSha256()); err != nil {
				log.Printf("assistant %s: keep its default instructions: %v", agent.ID, err)
			}
		}
	}
	return Run{Files: prompt.RunFiles(input), TurnContext: turnContext}, true, nil
}

// ProjectFiles are the assistant's one summary file per project, from the
// same permission-filtered digests and notes its prompt index uses.
func (s *Service) ProjectFiles(ctx context.Context, agent store.PersonalAgent) ([]personalagent.WorkspaceFile, error) {
	records, err := s.workspaceCandidates(ctx, agent)
	if err != nil {
		return nil, err
	}
	workspaces := make([]store.WorkspaceDigest, len(records))
	for i, record := range records {
		workspaces[i] = record.Digest
	}
	mentions, err := s.projectMentions(ctx, workspaces)
	if err != nil {
		return nil, err
	}
	return workspacedigest.ProjectFiles(workspaces, s.routingNoteIDs(ctx, agent), mentions, time.Now()), nil
}

// projectMentions are the terms each project's file names, ranked
// against the person's other projects the assistant covers.
func (s *Service) projectMentions(ctx context.Context, workspaces []store.WorkspaceDigest) (map[string][]workspacedigest.Mention, error) {
	ids := make([]string, 0, len(workspaces))
	for _, workspace := range workspaces {
		if !workspace.Archived {
			ids = append(ids, workspace.WorkspaceID)
		}
	}
	return s.digests.Mentions(ctx, ids)
}

// AssistantProjectFiles are the facts Foundry writes into every workspace
// the assistant runs in (its home and each message channel's workspace): the
// project index and one summary file per project, filtered by the permission
// package. A run supplies the same files, so a channel workspace routes from
// them too instead of only at the home.
func (s *Service) AssistantProjectFiles(ctx context.Context, agent store.PersonalAgent) ([]personalagent.WorkspaceFile, error) {
	input, err := s.PromptInput(ctx, agent, time.Now())
	if err != nil {
		return nil, err
	}
	return prompt.ProjectFilesAndIndex(input), nil
}

// WriteProjectFiles writes the project index and summary files into the
// assistant's home and each of its message channel workspaces now, removing
// the files of projects it no longer covers. The digest and summary paths
// call it when their facts change, as do archive/restore and a saved
// permission package; a run writes the same files before the runtime starts.
// Best-effort per workspace: an offline device keeps the last files until the
// next run.
func (s *Service) WriteProjectFiles(ctx context.Context, agent store.PersonalAgent) error {
	// One write per assistant at a time: a digest refresh queued before a
	// membership or archive change could otherwise prune files a later write
	// just made, and the last write must be the freshest.
	s.projectFileWrites.Lock(agent.ID)
	defer s.projectFileWrites.Unlock(agent.ID)
	files, err := s.AssistantProjectFiles(ctx, agent)
	if err != nil {
		return err
	}
	targets, err := s.projectFileWorkspaces(ctx, agent)
	if err != nil {
		return err
	}
	var firstErr error
	for _, workspace := range targets {
		if workspace.DeviceID == "" || !s.devices.Connected(workspace.DeviceID) {
			continue
		}
		if err := s.writeAssistantFiles(ctx, workspace, files); err != nil {
			log.Printf("assistant %s: write project files into %s: %v", agent.ID, workspace.ID, err)
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// projectFileWorkspaces are every workspace the assistant runs in: its home,
// then each message channel's workspace (on the assistant's own computer),
// without duplicates.
func (s *Service) projectFileWorkspaces(ctx context.Context, agent store.PersonalAgent) ([]store.WorkspaceProjection, error) {
	home, err := s.store.GetWorkspace(ctx, agent.WorkspaceID)
	if err != nil {
		return nil, err
	}
	targets := []store.WorkspaceProjection{home}
	if s.messageChannels == nil {
		return targets, nil
	}
	channels, err := s.messageChannels.ListMessageChannels(ctx, agent.UserID, agent.ID)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{home.ID: true}
	for _, channel := range channels {
		if channel.WorkspaceID == "" || seen[channel.WorkspaceID] {
			continue
		}
		workspace, err := s.store.GetWorkspace(ctx, channel.WorkspaceID)
		if err != nil {
			continue
		}
		seen[workspace.ID] = true
		targets = append(targets, workspace)
	}
	return targets, nil
}

// writeAssistantFiles replaces Foundry's files in one workspace and removes
// the project summaries it no longer covers.
func (s *Service) writeAssistantFiles(ctx context.Context, workspace store.WorkspaceProjection, files []personalagent.WorkspaceFile) error {
	keep := make(map[string]bool, len(files))
	for _, file := range files {
		keep[file.Path] = true
	}
	if entries, err := s.devices.ListWorkspaceTree(ctx, workspace, workspacedigest.ProjectFilesDir); err == nil {
		for _, entry := range entries {
			if entry.IsDirectory || !strings.HasSuffix(entry.Name, ".md") {
				continue
			}
			path := workspacedigest.ProjectFilesDir + "/" + entry.Name
			if keep[path] {
				continue
			}
			if err := s.devices.DeleteWorkspaceFile(ctx, workspace, path); err != nil {
				log.Printf("assistant: remove stale project file %s of %s: %v", path, workspace.ID, err)
			}
		}
	}
	for _, file := range files {
		if err := s.devices.WriteWorkspaceFile(ctx, workspace, file.Path, file.Content); err != nil {
			return fmt.Errorf("write %s: %w", file.Path, err)
		}
	}
	return nil
}

// keyedMutex serializes work per key.
type keyedMutex struct {
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

func (m *keyedMutex) Lock(key string) {
	m.mu.Lock()
	if m.locks == nil {
		m.locks = map[string]*sync.Mutex{}
	}
	lock, ok := m.locks[key]
	if !ok {
		lock = &sync.Mutex{}
		m.locks[key] = lock
	}
	m.mu.Unlock()
	lock.Lock()
}

func (m *keyedMutex) Unlock(key string) {
	m.mu.Lock()
	lock := m.locks[key]
	m.mu.Unlock()
	if lock != nil {
		lock.Unlock()
	}
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
	mentions, err := s.projectMentions(ctx, workspaces)
	if err != nil {
		return prompt.Input{}, err
	}
	places, err := s.ownDevicePlacements(ctx, devices, now)
	if err != nil {
		return prompt.Input{}, err
	}
	channels, err := s.channelPlaces(ctx, agent)
	if err != nil {
		return prompt.Input{}, err
	}
	others, err := s.otherAssistants(ctx, agent)
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
		Channels:                      channels,
		OtherAssistants:               others,
		L0Index:                       l0Index,
		ProjectFiles:                  workspacedigest.ProjectFiles(workspaces, s.routingNoteIDs(ctx, agent), mentions, now),
		Places:                        places,
		DirectChatPreviousWorkspaceID: s.directChatPrior(ctx, agent),
		ConnectorsURL:                 s.WebURL("/connectors"),
		SettingsURL:                   s.WebURL(personalagent.AssistantSettingsPath(agent.ID)),
	}, nil
}

// otherAssistants are the person's other active assistants, default first:
// what each is in charge of and the home conversation the person used last.
func (s *Service) otherAssistants(ctx context.Context, agent store.PersonalAgent) ([]prompt.AssistantPlace, error) {
	agents, err := s.store.ListAssistants(ctx, agent.UserID)
	if err != nil {
		return nil, err
	}
	places := []prompt.AssistantPlace{}
	for _, other := range agents {
		if other.ID == agent.ID || other.State != store.PersonalAgentActive {
			continue
		}
		places = append(places, prompt.AssistantPlace{
			Name:           cmp.Or(other.Name, other.Settings.AssistantName),
			Default:        other.IsDefault,
			Responsibility: other.Settings.Responsibility,
			ConversationID: s.latestConversation(ctx, other),
		})
	}
	return places, nil
}

// channelPlaces are the assistant's message channels whose workspace is on
// its home device: the folders its home conversation may edit when the
// person names that channel (DEV-251). A channel workspace on another
// device is left out; its rules stay its own.
func (s *Service) channelPlaces(ctx context.Context, agent store.PersonalAgent) ([]prompt.ChannelPlace, error) {
	if s.messageChannels == nil {
		return nil, nil
	}
	records, err := s.messageChannels.ListMessageChannels(ctx, agent.UserID, agent.ID)
	if err != nil {
		return nil, err
	}
	places := make([]prompt.ChannelPlace, 0, len(records))
	for _, record := range records {
		if record.WorkspaceID == "" || record.WorkspaceID == agent.WorkspaceID {
			continue
		}
		workspace, err := s.store.GetWorkspace(ctx, record.WorkspaceID)
		if err != nil || workspace.DeviceID != agent.HomeDeviceID {
			continue
		}
		places = append(places, prompt.ChannelPlace{Name: record.Name, Path: workspace.LocalPath})
	}
	return places, nil
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
// work stays attributable, but neither the prompt index nor the project
// summary files may propose it for new work. Shared workspaces retain their
// membership scope.
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
