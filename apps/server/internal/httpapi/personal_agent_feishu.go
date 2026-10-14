package httpapi

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/feishu"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
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
	agent, err := d.s.store.GetPersonalAgent(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		return feishu.PersonalAgentRoute{}, false, nil
	}
	if err != nil {
		return feishu.PersonalAgentRoute{}, false, err
	}
	route := feishu.PersonalAgentRoute{
		WorkspaceID:      agent.WorkspaceID,
		TakesDirectChats: takesDirectChat(agent.Settings, appID),
		Stopped:          agent.State == store.PersonalAgentStopped,
		HomeOffline:      !d.s.hub.HasConnection(agent.HomeDeviceID),
		SettingsURL:      d.s.webURL(personalagent.SettingsPath),
	}
	if route.TakesDirectChats && routeWorkspaceID != agent.WorkspaceID {
		introduced, err := d.s.store.PersonalAgentChatIntroduced(ctx, userID, appID)
		if err != nil {
			return route, false, err
		}
		route.Introduce = !introduced
	}
	return route, true, nil
}

func (d personalAgentDesk) ClaimIntroduction(ctx context.Context, userID, appID string) bool {
	claimed, err := d.s.store.ClaimPersonalAgentChatIntroduction(ctx, userID, appID)
	if err != nil {
		log.Printf("personal agent %s: record the introduction of direct chat on %s: %v", userID, appID, err)
	}
	return claimed
}

func (d personalAgentDesk) Language(ctx context.Context, userID, message string) string {
	agent, err := d.s.store.GetPersonalAgent(ctx, userID)
	if err != nil {
		agent = store.PersonalAgent{}
	}
	return personalagent.ReplyLanguage(personalagent.ChosenLanguage(agent.Settings, d.s.accountLocale(ctx, userID)), message)
}

func (d personalAgentDesk) Stop(ctx context.Context, userID, _ string) (feishu.PersonalAgentStopped, error) {
	stopped, err := d.s.StopPersonalAgent(ctx, userID)
	return feishu.PersonalAgentStopped{Cancelled: stopped}, err
}

func (d personalAgentDesk) Resume(ctx context.Context, userID, _ string) (feishu.PersonalAgentResumed, error) {
	tasks, err := d.s.ResumePersonalAgent(ctx, userID)
	resumed := feishu.PersonalAgentResumed{}
	for _, task := range tasks {
		resumed.Stopped = append(resumed.Stopped, task.Title)
	}
	return resumed, err
}

func (d personalAgentDesk) PendingProposals(ctx context.Context, userID string) ([]store.PersonalAgentProposal, error) {
	if err := d.s.expirePersonalAgentProposals(ctx, userID, time.Now()); err != nil {
		return nil, err
	}
	return d.s.store.ListPersonalAgentProposals(ctx, userID, []string{store.PersonalAgentProposalPending})
}

func (d personalAgentDesk) Accept(ctx context.Context, userID, proposalID, via string) (store.PersonalAgentProposal, error) {
	return d.s.DecidePersonalAgentProposal(ctx, userID, proposalID, true, via)
}

func (d personalAgentDesk) Decline(ctx context.Context, userID, proposalID, via string) (store.PersonalAgentProposal, error) {
	return d.s.DecidePersonalAgentProposal(ctx, userID, proposalID, false, via)
}

// webURL is path in the web app.
func (s *Server) webURL(path string) string {
	return strings.TrimRight(s.options.AllowedOrigin, "/") + path
}
