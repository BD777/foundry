package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// personalAgentDesk is the person's assistant as their Feishu direct chat
// reaches it (feishu.PersonalAgentDesk, docs/personal-agent.md §4, §8, §10,
// §14): the same stop switch, resuming and answers to proposals as the web.
// The channel calls it only for the person the chat is paired with; every
// call is scoped to that person, so a proposal of anyone else's is not
// found.
type personalAgentDesk struct{ s *Server }

var _ feishu.PersonalAgentDesk = personalAgentDesk{}

func (d personalAgentDesk) Word(text string) string {
	switch {
	case personalagent.IsStop(text):
		return feishu.PersonalAgentWordStop
	case personalagent.IsResume(text):
		return feishu.PersonalAgentWordResume
	case personalagent.IsAccept(text):
		return feishu.PersonalAgentWordAccept
	case personalagent.IsDecline(text):
		return feishu.PersonalAgentWordDecline
	}
	return ""
}

func (d personalAgentDesk) Route(ctx context.Context, userID, appID, routeWorkspaceID string) (feishu.PersonalAgentRoute, bool, error) {
	agent, err := d.s.store.AssistantForFeishuApp(ctx, userID, appID)
	if errors.Is(err, store.ErrNotFound) {
		agent, err = d.s.store.DefaultAssistant(ctx, userID)
	}
	if errors.Is(err, store.ErrNotFound) {
		return feishu.PersonalAgentRoute{}, false, nil
	}
	if err != nil {
		return feishu.PersonalAgentRoute{}, false, err
	}
	route := feishu.PersonalAgentRoute{
		AssistantID:      agent.ID,
		WorkspaceID:      agent.WorkspaceID,
		TakesDirectChats: agent.Settings.FeishuAppID == appID || assistant.TakesDirectChat(agent.Settings, appID),
		Stopped:          agent.State == store.PersonalAgentStopped,
		HomeOffline:      !d.s.hub.HasConnection(agent.HomeDeviceID),
		SettingsURL:      d.s.assistant.WebURL(personalagent.AssistantSettingsPath(agent.ID)),
	}
	if route.TakesDirectChats && routeWorkspaceID != agent.WorkspaceID {
		introduced, err := d.s.store.PersonalAgentChatIntroduced(ctx, agent.ID, appID)
		if err != nil {
			return route, false, err
		}
		route.Introduce = !introduced
	}
	return route, true, nil
}

func (d personalAgentDesk) ClaimIntroduction(ctx context.Context, assistantID, userID, appID string) bool {
	if _, err := d.assistant(ctx, assistantID, userID); err != nil {
		return false
	}
	claimed, err := d.s.store.ClaimPersonalAgentChatIntroduction(ctx, assistantID, userID, appID)
	if err != nil {
		log.Printf("assistant %s: record the introduction of direct chat on %s: %v", assistantID, appID, err)
	}
	return claimed
}

func (d personalAgentDesk) Language(ctx context.Context, assistantID, userID, message string) string {
	agent, err := d.assistant(ctx, assistantID, userID)
	if err != nil {
		agent = store.PersonalAgent{}
	}
	return personalagent.ReplyLanguage(personalagent.ChosenLanguage(agent.Settings, d.s.assistant.AccountLocale(ctx, userID)), message)
}

func (d personalAgentDesk) assistant(ctx context.Context, assistantID, userID string) (store.PersonalAgent, error) {
	agent, err := d.s.store.GetAssistant(ctx, assistantID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return store.PersonalAgent{}, &statusError{http.StatusNotFound, err}
		}
		return store.PersonalAgent{}, err
	}
	if agent.UserID != userID {
		return store.PersonalAgent{}, &statusError{http.StatusNotFound, store.ErrNotFound}
	}
	return agent, nil
}

func (d personalAgentDesk) Stop(ctx context.Context, assistantID, userID, _ string) (feishu.PersonalAgentStopped, error) {
	agent, err := d.assistant(ctx, assistantID, userID)
	if err != nil {
		return feishu.PersonalAgentStopped{}, err
	}
	stopped, err := d.s.assistant.Stop(ctx, agent)
	return feishu.PersonalAgentStopped{Cancelled: stopped}, err
}

func (d personalAgentDesk) Resume(ctx context.Context, assistantID, userID, _ string) (feishu.PersonalAgentResumed, error) {
	agent, err := d.assistant(ctx, assistantID, userID)
	if err != nil {
		return feishu.PersonalAgentResumed{}, err
	}
	tasks, err := d.s.assistant.Resume(ctx, agent)
	resumed := feishu.PersonalAgentResumed{}
	for _, task := range tasks {
		resumed.Stopped = append(resumed.Stopped, task.Title)
	}
	return resumed, err
}

func (d personalAgentDesk) PendingProposals(ctx context.Context, assistantID, userID string) ([]store.PersonalAgentProposal, error) {
	agent, err := d.assistant(ctx, assistantID, userID)
	if err != nil {
		return nil, err
	}
	if err := d.s.assistant.ExpireProposals(ctx, agent, time.Now()); err != nil {
		return nil, err
	}
	return d.s.store.ListPersonalAgentProposals(ctx, agent.ID, []string{store.PersonalAgentProposalPending})
}

func (d personalAgentDesk) Accept(ctx context.Context, assistantID, userID, proposalID, via string) (store.PersonalAgentProposal, error) {
	agent, err := d.assistant(ctx, assistantID, userID)
	if err != nil {
		return store.PersonalAgentProposal{}, err
	}
	return d.s.assistant.DecideProposal(ctx, agent, proposalID, true, via)
}

func (d personalAgentDesk) Decline(ctx context.Context, assistantID, userID, proposalID, via string) (store.PersonalAgentProposal, error) {
	agent, err := d.assistant(ctx, assistantID, userID)
	if err != nil {
		return store.PersonalAgentProposal{}, err
	}
	return d.s.assistant.DecideProposal(ctx, agent, proposalID, false, via)
}
