package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"strings"
	"sync"

	"github.com/foundry-dev/foundry/apps/server/internal/chattitle"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Both explicit recap and first-answer naming enter this service. Jobs are
// durable, independent provider sessions; no original thread/native ID resumes.
type chatTitleService struct {
	store store.Store
	// dispatch hands a job its viewers know of to its device; one the
	// device does not take comes back failed, its end told like any other.
	dispatch  func(context.Context, store.AgentSession) (store.AgentSession, error)
	connected func(string) bool
	// sessions tells the jobs it creates; chats announces the titles and
	// the layout groups naming changes.
	sessions sessionChangeNotifier
	chats    chatTitleAnnouncer
	// jobChats follows the chat each naming job names (jobTitleChanged).
	jobChats namingJobChats
}

// chatTitleAnnouncer is the part of the chat list's notifier naming uses.
type chatTitleAnnouncer interface {
	announcePickedTitles(workspaceID string, pick func(titles []store.ChatTitle) []string)
	layoutChanged(workspaceID string, layout store.ChatLayout)
}

func (s *chatTitleService) Start(ctx context.Context, workspaceID, chatID string, automatic bool) (store.AgentSession, error) {
	sessions, err := s.store.ListAgentSessionThread(ctx, workspaceID, chatID)
	input := store.CreateAgentSessionInput{WorkspaceID: workspaceID, Source: "naming", CodexSandboxMode: "read-only", CodexApprovalPolicy: "never", ClaudePermissionMode: "plan"}
	messages := []chattitle.Message{}
	profileID, deviceID := "", ""
	if err == nil && len(sessions) > 0 {
		latest := sessions[len(sessions)-1]
		chatID = sessions[0].ThreadID
		if chatID == "" {
			chatID = sessions[0].ID
		}
		input.AgentID, input.Provider, input.Model = latest.AgentID, latest.Provider, latest.Model
		input.ProfileID = latest.ProfileID
		input.ClaudeEffort, input.CodexReasoningEffort = latest.ClaudeEffort, latest.CodexReasoningEffort
		profileID, deviceID = latest.ProfileID, latest.DeviceID
		for _, session := range sessions {
			if !sessionRecordsInputs(session) {
				messages = append(messages, chattitle.Message{Role: "user", Text: session.Prompt})
			}
			for _, event := range session.Events {
				switch event.Label {
				case store.SessionInputEventLabel:
					if event.Message != nil {
						messages = append(messages, chattitle.Message{Role: "user", Text: event.Message.Text})
					}
				case "Steered into active turn":
					messages = append(messages, chattitle.Message{Role: "user", Text: event.Detail})
				case "Response stream":
					if event.Metadata != nil && event.Metadata.TaskID != "" {
						continue
					}
					messages = append(messages, chattitle.Message{Role: "assistant", Text: event.Detail})
				}
			}
			if session.Response != "" && (len(messages) == 0 || messages[len(messages)-1].Text != session.Response) {
				messages = append(messages, chattitle.Message{Role: "assistant", Text: session.Response})
			}
		}
	} else {
		if err != nil && !errors.Is(err, store.ErrNotFound) && !errors.Is(err, sql.ErrNoRows) {
			return store.AgentSession{}, err
		}
		chat, err := s.store.GetChat(ctx, chatID)
		if err != nil {
			return store.AgentSession{}, err
		}
		if chat.WorkspaceID != workspaceID {
			return store.AgentSession{}, store.ErrNotFound
		}
		input.Provider = chat.Provider
		profileID = chat.ProfileID
		for _, message := range chat.RecentMessages {
			messages = append(messages, chattitle.Message{Role: message.Role, Text: message.Text})
		}
		if len(messages) == 0 {
			return store.AgentSession{}, errors.New("the native session has not synced its latest two turns yet; wait for the local worker to update, then retry")
		}
	}
	var agent *store.AgentProjection
	if input.AgentID != "" {
		// A Foundry chat is named by the agent it ran on, resolved the way a
		// new session resolves it: a device-reported agent or the server's
		// projection of a bound server connection (never in ListAgents).
		resolved, err := s.store.ResolveSessionAgent(ctx, input)
		if err == nil && (resolved.Status == "" || resolved.Status == "healthy") {
			agent = &resolved
		}
		if agent == nil || !s.connected(agent.DeviceID) {
			return store.AgentSession{}, errors.New("the provider or profile this chat uses is unavailable, so it cannot be named automatically")
		}
		return s.createTitleJob(ctx, chatID, input, agent, messages, automatic)
	}
	agents, err := s.store.ListAgents(ctx, workspaceID, deviceID)
	if err != nil {
		return store.AgentSession{}, err
	}
	for i := range agents {
		candidate := &agents[i]
		if candidate.Provider != input.Provider || candidate.Status != "healthy" {
			continue
		}
		if input.AgentID != "" && candidate.ID != input.AgentID {
			continue
		}
		if profileID != "" && candidate.ProfileID != profileID {
			continue
		}
		agent = candidate
		break
	}
	if agent == nil || !s.connected(agent.DeviceID) {
		return store.AgentSession{}, errors.New("the provider or profile this chat uses is unavailable, so it cannot be named automatically")
	}
	return s.createTitleJob(ctx, chatID, input, agent, messages, automatic)
}

func (s *chatTitleService) createTitleJob(ctx context.Context, chatID string, input store.CreateAgentSessionInput, agent *store.AgentProjection, messages []chattitle.Message, automatic bool) (store.AgentSession, error) {
	var err error
	input.AgentID = agent.ID
	input.Prompt, err = chattitle.Prompt(messages)
	if err != nil {
		return store.AgentSession{}, err
	}
	job, err := s.store.CreateChatTitleJob(ctx, chatID, input, automatic)
	if err != nil || job.ID == "" {
		return job, err
	}
	if job.Status != "queued" {
		return job, nil
	}
	s.sessions.changed(ctx, sessionCreated, job)
	return s.dispatch(ctx, job)
}

func (s *chatTitleService) SessionCompleted(ctx context.Context, session store.AgentSession) {
	if session.Status != "completed" || strings.TrimSpace(session.Response) == "" {
		return
	}
	// An AI group-naming job applies its short response to the layout group.
	if session.Source == "naming" && strings.TrimSpace(session.GroupNameTarget) != "" {
		name := groupNameFromResponse(session.Response)
		if name == "" {
			return
		}
		layout, err := s.store.RenameLayoutGroup(ctx, session.WorkspaceID, session.GroupNameTarget, name)
		if err != nil {
			log.Printf("automatic group naming: %v", err)
			return
		}
		s.chats.layoutChanged(session.WorkspaceID, layout)
		return
	}
	// Automatic naming happens once per chat; the title record guards reruns.
	if session.Source != "chat" {
		return
	}
	if _, err := s.Start(ctx, session.WorkspaceID, session.ID, true); err != nil {
		log.Printf("automatic chat naming: %v", err)
	}
}

// StartGroupName dispatches an asynchronous naming session for an
// auto-created orchestration group, using the parent thread as context. Any
// failure keeps the deterministic placeholder name.
func (s *chatTitleService) StartGroupName(ctx context.Context, workspaceID, groupID, parentSessionID string) {
	sessions, err := s.store.ListAgentSessionThread(ctx, workspaceID, parentSessionID)
	if err != nil || len(sessions) == 0 {
		return
	}
	latest := sessions[len(sessions)-1]
	messages := []chattitle.Message{}
	for _, item := range sessions {
		messages = append(messages, chattitle.Message{Role: "user", Text: item.Prompt})
		if item.Response != "" {
			messages = append(messages, chattitle.Message{Role: "assistant", Text: item.Response})
		}
		if len(messages) >= 4 {
			break
		}
	}
	prompt, err := chattitle.Prompt(messages)
	if err != nil {
		return
	}
	agents, err := s.store.ListAgents(ctx, workspaceID, latest.DeviceID)
	if err != nil {
		return
	}
	var agent *store.AgentProjection
	for i := range agents {
		candidate := &agents[i]
		if candidate.Provider != latest.Provider || candidate.Status != "healthy" {
			continue
		}
		if latest.ProfileID != "" && candidate.ProfileID != latest.ProfileID {
			continue
		}
		agent = candidate
		break
	}
	if agent == nil || !s.connected(agent.DeviceID) {
		return
	}
	input := store.CreateAgentSessionInput{
		WorkspaceID:          workspaceID,
		AgentID:              agent.ID,
		Provider:             latest.Provider,
		ProfileID:            latest.ProfileID,
		Model:                latest.Model,
		ClaudeEffort:         latest.ClaudeEffort,
		CodexReasoningEffort: latest.CodexReasoningEffort,
		CodexSandboxMode:     "read-only",
		CodexApprovalPolicy:  "never",
		ClaudePermissionMode: "plan",
		Prompt:               prompt,
	}
	job, err := s.store.CreateGroupNameJob(ctx, input, groupID)
	if err != nil || job.ID == "" {
		return
	}
	s.sessions.changed(ctx, sessionCreated, job)
	_, _ = s.dispatch(ctx, job)
}

// groupNameFromResponse reads a group-naming answer. The job uses the chat
// title prompt, which asks for {"title": …}; chattitle owns that format. An
// invalid answer returns "" and the deterministic name stays.
func groupNameFromResponse(response string) string {
	title, err := chattitle.Parse(response)
	if err != nil {
		return ""
	}
	name := strings.Trim(strings.TrimLeft(title, "-•*#> "), "\"'“”‘’ \t")
	if runes := []rune(name); len(runes) > 24 {
		name = strings.TrimSpace(string(runes[:24]))
	}
	return name
}

// sessionRecordsInputs tells a session whose inputs are transcript events
// from a legacy per-turn row that only carried its prompt.
func sessionRecordsInputs(session store.AgentSession) bool {
	for _, event := range session.Events {
		if event.Label == store.SessionInputEventLabel {
			return true
		}
	}
	return false
}

// sessionChanged follows a chat-naming job's changes: the title list shows
// the job's state (queued, running, failed) and, once it completes, the
// title it wrote.
func (s *chatTitleService) sessionChanged(_ context.Context, _ sessionChange, session store.AgentSession) {
	if session.Source == "naming" && strings.TrimSpace(session.GroupNameTarget) == "" && strings.TrimSpace(session.WorkspaceID) != "" {
		s.jobTitleChanged(session)
	}
}

// sessionEndReported names what a session its device reported completed
// answered: a chat's first answer names the chat, a group-naming job's
// answer its group (SessionCompleted). It reads the chat's whole thread and
// starts a job on a device, so it runs on its own, after the device that
// reported the end was answered and without holding its next message up.
func (s *chatTitleService) sessionEndReported(ctx context.Context, session store.AgentSession) {
	namesGroup := session.Source == "naming" && strings.TrimSpace(session.GroupNameTarget) != ""
	if session.Status != "completed" || strings.TrimSpace(session.Response) == "" || (session.Source != "chat" && !namesGroup) {
		return
	}
	go s.SessionCompleted(context.WithoutCancel(ctx), session)
}

// jobTitleChanged announces the title of the chat a naming job names. A
// job's events do not name its chat: while it runs, the chat's title names
// the job; once it completed, jobChats remembers the chat.
func (s *chatTitleService) jobTitleChanged(job store.AgentSession) {
	s.chats.announcePickedTitles(job.WorkspaceID, func(titles []store.ChatTitle) []string {
		if chatID := s.jobChats.follow(job, titles); chatID != "" {
			return []string{chatID}
		}
		return nil
	})
}

// namingJobChats remembers the chat each naming job seen running names:
// its title stops naming the job once the job completes.
type namingJobChats struct {
	mu    sync.Mutex
	chats map[string]string
}

// follow is the chat job names, as titles list it or as remembered; it is
// remembered while the job runs and forgotten once the job ended.
func (j *namingJobChats) follow(job store.AgentSession, titles []store.ChatTitle) string {
	j.mu.Lock()
	defer j.mu.Unlock()
	chatID := j.chats[job.ID]
	for _, title := range titles {
		if title.GenerationSessionID == job.ID {
			chatID = title.ChatID
			break
		}
	}
	switch job.Status {
	case "completed", "failed", "canceled":
		delete(j.chats, job.ID)
	default:
		if chatID != "" {
			if j.chats == nil {
				j.chats = map[string]string{}
			}
			j.chats[job.ID] = chatID
		}
	}
	return chatID
}
