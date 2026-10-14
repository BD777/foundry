package httpapi

import (
	"cmp"
	"context"
	"log"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/prompt"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// What a run of the person's assistant gets (docs/personal-agent.md §12),
// however the run started (their message, a timer, a server notice, a
// message that found it idle): its appended system prompt (prompt.Fill:
// the prompt, the person's requests, what it knows), which stays byte for
// byte the same until one of those changes, so the worker keeps the
// conversation's runtime and its prompt cache; and the turn's context
// (prompt.TurnContext: the time, which computers are online, the work it
// follows up), added to the turn's input as Foundry's words. The input
// stored for the turn stays the person's own, which is what `remember`
// judges.

// assistantRun is what a run of the person's assistant is given.
type assistantRun struct {
	// Instructions are the appended system prompt.
	Instructions string
	// TurnContext goes with the turn's input.
	TurnContext string
}

// assistantRunFor is what a run of the session needs as the person's
// assistant; ok is false for any other session. A run of the assistant
// does not start without it.
func (s *Server) assistantRunFor(ctx context.Context, session store.AgentSession) (run assistantRun, ok bool, err error) {
	agent, ok := s.assistantConversation(ctx, session)
	if !ok {
		return run, false, nil
	}
	input, err := s.assistantPromptInput(ctx, agent, time.Now())
	if err != nil {
		return run, true, err
	}
	return assistantRun{Instructions: prompt.Fill(input), TurnContext: prompt.TurnContext(input)}, true, nil
}

// withTurnContext is the turn's input as the assistant reads it: the
// person's words first (a leading "/skill" keeps working), then Foundry's
// context.
func withTurnContext(input store.SessionInput, turnContext string) store.SessionInput {
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

// assistantPromptInput is everything the assistant's prompt is filled
// from, as of now.
func (s *Server) assistantPromptInput(ctx context.Context, agent store.PersonalAgent, now time.Time) (prompt.Input, error) {
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
	memory, err := s.store.ListPersonalAgentMemory(ctx, agent.UserID)
	if err != nil {
		return prompt.Input{}, err
	}
	digests := s.workspaceDigests()
	records, err := digests.Sync(ctx, agent.UserID)
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
	s.refreshAssistantTasks(ctx, agent.UserID)
	tasks, err := s.store.ListPersonalAgentTasks(ctx, agent.UserID, nil)
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
		Tasks:                         tasks,
		DirectChatPreviousWorkspaceID: s.directChatPrior(ctx, agent),
		ConnectorsURL:                 s.webURL("/connectors"),
		SettingsURL:                   s.webURL(personalagent.SettingsPath),
	}, nil
}

// takesDirectChat reports whether the assistant takes the person's Feishu
// direct chat on Connectors app appID (§10): the setting is on, for its
// chosen app or, with none chosen, for any.
func takesDirectChat(settings store.PersonalAgentSettings, appID string) bool {
	return settings.FeishuDirectChat && (settings.FeishuAppID == "" || settings.FeishuAppID == appID)
}

// directChatPrior is where the person's Feishu direct chat went before the
// assistant took it over (§14), "" when nowhere else.
func (s *Server) directChatPrior(ctx context.Context, agent store.PersonalAgent) string {
	routes, err := s.store.ListFeishuBotRoutes(ctx, store.FeishuBotRouteFilter{})
	if err != nil {
		log.Printf("personal agent %s: read direct chat routes: %v", agent.UserID, err)
		return ""
	}
	for _, route := range routes {
		if route.Kind == store.FeishuRouteP2P && route.BoundUserID == agent.UserID &&
			route.WorkspaceID != "" && route.WorkspaceID != agent.WorkspaceID && takesDirectChat(agent.Settings, route.AppID) {
			return route.WorkspaceID
		}
	}
	return ""
}
