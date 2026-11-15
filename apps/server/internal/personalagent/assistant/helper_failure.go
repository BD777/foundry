package assistant

import (
	"cmp"
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/run"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Why a helper the assistant handed work to is stuck, as a category its
// notice carries (reasonTag) so the assistant can start the work again
// under an account that works without asking the person.

const (
	helperUnreachable = "unreachable"

	// assistantTaskEventUnreachable is a helper that cannot reach its model
	// service (unreachableSince).
	assistantTaskEventUnreachable = "unreachable"
)

// ServiceUnreachableAfter is how long a helper's latest events may be
// nothing but failed attempts to reach its model service before its
// conversation is told.
var ServiceUnreachableAfter = 2 * time.Minute

// serviceEventWindow bounds the latest events unreachableSince reads.
const serviceEventWindow = 50

// reasonTag is a failure's category in a form the assistant reads the
// same in every language.
func reasonTag(reason string, session store.AgentSession) string {
	return fmt.Sprintf("[reason=%s profileId=%s runtime=%s]", reason, session.ProfileID, session.Provider)
}

// retryAdvice names the other accounts that work where the helper runs,
// the one create_session would choose first; running: the helper is
// still going and is stopped first.
func (s *Service) retryAdvice(ctx context.Context, agent store.PersonalAgent, session store.AgentSession, running bool) string {
	var others []run.Account
	if workspace, err := s.store.GetWorkspace(ctx, session.WorkspaceID); err == nil {
		if accounts, err := s.accounts.WorkspaceAccounts(ctx, workspace, session.CreatedByUserID); err == nil {
			for _, account := range accounts {
				if account.Usable && account.ProfileID != session.ProfileID {
					others = append(others, account)
				}
			}
		}
	}
	if len(others) == 0 {
		if running {
			return s.sayTask(ctx, agent, "noOtherAccountStuck")
		}
		return s.sayTask(ctx, agent, "noOtherAccount")
	}
	first, _ := s.accounts.Pick(others, "", s.DefaultAccount(ctx, agent.ID))
	listed := []string{first.Describe()}
	for _, account := range others {
		if account.ProfileID != first.ProfileID {
			listed = append(listed, account.Describe())
		}
	}
	key := "retryElsewhere"
	if running {
		key = "stopAndRetryElsewhere"
	}
	return s.sayTask(ctx, agent, key, strings.Join(listed, "; "))
}

// retryBlocked reports whether a blocked session waits on its model
// service retrying (the worker's retry labels), not on a person.
func retryBlocked(session store.AgentSession) bool {
	if session.Status != "blocked" {
		return false
	}
	switch session.BlockedReason {
	case store.ProcessLabelModelRetry, store.ProcessLabelRateLimited:
		return true
	}
	return false
}

type serviceSignal int

const (
	serviceProgress serviceSignal = iota
	serviceNeutral
	serviceUnreachable
)

// serviceSignalOf reads one event for whether the session reaches its
// model service: Codex reconnecting ("Reconnecting... 2/5 (request timed
// out)", "Reconnecting... waiting for network") and Claude retrying a
// request that got no answer or a server error are failed attempts;
// notices, rate limits and the start of a request say nothing either
// way; anything else is the session working.
func serviceSignalOf(event store.AgentSessionEvent) serviceSignal {
	switch event.Label {
	case store.ProcessLabelNotice:
		if strings.HasPrefix(event.Detail, "Reconnecting...") {
			return serviceUnreachable
		}
		return serviceNeutral
	case store.ProcessLabelModelRetry:
		if strings.HasPrefix(event.Detail, "HTTP 4") {
			return serviceNeutral
		}
		return serviceUnreachable
	case store.ProcessLabelRateLimited, store.ProcessLabelRequestingModel, store.ProcessLabelThinking:
		return serviceNeutral
	}
	return serviceProgress
}

// unreachableSince is when the session's current spell of failed
// attempts to reach its model service began, and the latest attempt's
// words, when its latest events are nothing but such attempts and
// notices.
func (s *Service) unreachableSince(ctx context.Context, sessionID string) (time.Time, string, bool) {
	events, _, err := s.store.AgentSessionEventWindow(ctx, sessionID, "", serviceEventWindow)
	if err != nil {
		return time.Time{}, "", false
	}
	var since time.Time
	latest := ""
	for index := len(events) - 1; index >= 0; index-- {
		signal := serviceSignalOf(events[index])
		if signal == serviceProgress {
			break
		}
		if signal == serviceUnreachable {
			if at, ok := parsePATime(events[index].At); ok {
				since = at
			}
			latest = cmp.Or(latest, events[index].Detail)
		}
	}
	return since, latest, !since.IsZero()
}
