package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/chattitle"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Both explicit recap and first-answer naming enter this service. Jobs are
// durable, independent provider sessions; no original thread/native ID resumes.
type chatTitleService struct {
	store     store.Store
	dispatch  func(store.AgentSession) error
	connected func(string) bool
	publish   func(string, any)
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
			messages = append(messages, chattitle.Message{Role: "user", Text: session.Prompt})
			for _, event := range session.Events {
				switch event.Label {
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
			return store.AgentSession{}, errors.New("原生会话尚未同步最近两轮内容，请等待本地 daemon 更新后重试")
		}
	}
	agents, err := s.store.ListAgents(ctx, workspaceID, deviceID)
	if err != nil {
		return store.AgentSession{}, err
	}
	var agent *store.AgentProjection
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
		return store.AgentSession{}, errors.New("此会话使用的 provider/profile 当前不可用，无法自动命名")
	}
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
	s.publish("agent_session_created", job)
	if err := s.dispatch(job); err != nil {
		failed, _ := s.store.FailAgentSession(ctx, job.ID, err.Error())
		s.publish("agent_session_completed", failed)
		return failed, err
	}
	return job, nil
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
		if _, err := s.store.RenameLayoutGroup(ctx, session.WorkspaceID, session.GroupNameTarget, name); err != nil {
			log.Printf("automatic group naming: %v", err)
			return
		}
		layout, _ := s.store.GetChatLayout(ctx, session.WorkspaceID)
		s.publish("chat_layout_changed", layout)
		return
	}
	if session.Source != "chat" || session.ThreadID != session.ID {
		return
	}
	if _, err := s.Start(ctx, session.WorkspaceID, session.ThreadID, true); err != nil {
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
	s.publish("agent_session_created", job)
	if err := s.dispatch(job); err != nil {
		_, _ = s.store.FailAgentSession(ctx, job.ID, err.Error())
	}
}

func groupNameFromResponse(response string) string {
	name := strings.TrimSpace(response)
	if name == "" {
		return ""
	}
	// Models often return quotes or a leading bullet; take the first short line.
	for _, line := range strings.Split(name, "\n") {
		line = strings.TrimSpace(strings.TrimLeft(line, "-•*#> "))
		line = strings.Trim(line, "\"'“”‘’ \t")
		if line == "" {
			continue
		}
		name = line
		break
	}
	if runes := []rune(name); len(runes) > 24 {
		name = strings.TrimSpace(string(runes[:24]))
	}
	return name
}
