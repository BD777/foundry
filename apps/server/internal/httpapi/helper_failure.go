package httpapi

import (
	"cmp"
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Why a helper the assistant handed work to failed or is stuck, as a
// category its notice carries (reasonTag) so the assistant can start the
// work again under an account that works without asking the person.

const (
	helperNotSignedIn   = accountNotSignedIn
	helperNotReady      = accountNotReady
	helperUnreachable   = "unreachable"
	helperRateLimited   = "rate_limited"
	helperDeviceOffline = "device_offline"
	helperTaskError     = "task_error"

	// assistantTaskEventUnreachable is a helper that cannot reach its model
	// service (unreachableSince).
	assistantTaskEventUnreachable = "unreachable"
)

// serviceUnreachableAfter is how long a helper's latest events may be
// nothing but failed attempts to reach its model service before its
// conversation is told.
var serviceUnreachableAfter = 2 * time.Minute

// serviceEventWindow bounds the latest events unreachableSince reads.
const serviceEventWindow = 50

var (
	signedOutPattern   = regexp.MustCompile(`(?i)not logged in|/login\b|not signed in|codex login|login required|unauthori[sz]ed|\b401\b|invalid (x-)?api[ -]key|authentication (failed|error)`)
	rateLimitedPattern = regexp.MustCompile(`(?i)\b429\b|rate[ -]limit|usage limit|quota|too many requests`)
	unreachablePattern = regexp.MustCompile(`(?i)connection (error|failed|refused|reset|closed)|error sending request|timed out|econnrefused|econnreset|enotfound|eai_again|etimedout|network|stream disconnected|unreachable|fetch failed|socket hang up|could not resolve|dns`)
)

// helperFailureReason is the category of a helper's failure: what its
// error says, else what its device reports of its account.
func (s *Server) helperFailureReason(session store.AgentSession, account workspaceAccount, known bool) string {
	text := session.Error
	switch {
	case signedOutPattern.MatchString(text):
		return helperNotSignedIn
	case rateLimitedPattern.MatchString(text):
		return helperRateLimited
	case unreachablePattern.MatchString(text):
		return helperUnreachable
	case strings.Contains(text, ErrLocalDaemonNotConnected.Error()) || strings.Contains(strings.ToLower(text), "offline"):
		return helperDeviceOffline
	case known && !account.Usable:
		return account.Problem
	}
	return helperTaskError
}

// helperAccount is the account the session ran under, as its device
// reports it now.
func (s *Server) helperAccount(ctx context.Context, session store.AgentSession) (workspaceAccount, bool) {
	workspace, err := s.store.GetWorkspace(ctx, session.WorkspaceID)
	if err != nil {
		return workspaceAccount{}, false
	}
	accounts, err := s.workspaceAccounts(ctx, workspace, "")
	if err != nil {
		return workspaceAccount{}, false
	}
	index := slices.IndexFunc(accounts, func(account workspaceAccount) bool {
		return session.ProfileID != "" && account.ProfileID == session.ProfileID
	})
	if index < 0 {
		return workspaceAccount{}, false
	}
	return accounts[index], true
}

// reasonTag is a failure's category in a form the assistant reads the
// same in every language.
func reasonTag(reason string, session store.AgentSession) string {
	return fmt.Sprintf("[reason=%s profileId=%s runtime=%s]", reason, session.ProfileID, session.Provider)
}

// failedTaskLine tells of a failed helper: its error, its reason
// category and, when its account is what failed, the accounts that work
// there instead.
func (s *Server) failedTaskLine(ctx context.Context, agent store.PersonalAgent, session store.AgentSession, work string) string {
	say := func(key string, args ...any) string { return s.sayTask(ctx, agent, key, args...) }
	excerpt := cmp.Or(truncateRunes(strings.TrimSpace(session.Error), taskExcerptChars), say("none"))
	account, known := s.helperAccount(ctx, session)
	reason := s.helperFailureReason(session, account, known)
	switch reason {
	case helperNotSignedIn, helperNotReady, helperUnreachable, helperRateLimited:
		name := cmp.Or(account.Name, session.ProfileLabel, session.ProfileID)
		return say("failedAccount", work, excerpt, say(reason, name)) + "\n" + reasonTag(reason, session) + "\n" + s.retryAdvice(ctx, agent, session, false)
	}
	return say("failed", work, excerpt) + "\n" + reasonTag(reason, session)
}

// retryAdvice names the other accounts that work where the helper runs,
// the one create_session would choose first; running: the helper is
// still going and is stopped first.
func (s *Server) retryAdvice(ctx context.Context, agent store.PersonalAgent, session store.AgentSession, running bool) string {
	var others []workspaceAccount
	if workspace, err := s.store.GetWorkspace(ctx, session.WorkspaceID); err == nil {
		if accounts, err := s.workspaceAccounts(ctx, workspace, session.CreatedByUserID); err == nil {
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
	first, _ := pickAccount(others, "", s.defaultAccountOf(ctx, agent.UserID))
	listed := []string{first.describe()}
	for _, account := range others {
		if account.ProfileID != first.ProfileID {
			listed = append(listed, account.describe())
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
	case labelModelRetry, labelRateLimited:
		return true
	}
	return false
}

// The worker's process labels (packages/protocol/src/process-labels.ts)
// the service signals read.
const (
	labelNotice      = "Notice"
	labelModelRetry  = "Model request retry"
	labelRateLimited = "Rate limited, waiting to retry"
	labelRequesting  = "Requesting model"
	labelThinking    = "Thinking"
)

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
	case labelNotice:
		if strings.HasPrefix(event.Detail, "Reconnecting...") {
			return serviceUnreachable
		}
		return serviceNeutral
	case labelModelRetry:
		if strings.HasPrefix(event.Detail, "HTTP 4") {
			return serviceNeutral
		}
		return serviceUnreachable
	case labelRateLimited, labelRequesting, labelThinking:
		return serviceNeutral
	}
	return serviceProgress
}

// unreachableSince is when the session's current spell of failed
// attempts to reach its model service began, and the latest attempt's
// words, when its latest events are nothing but such attempts and
// notices.
func (s *Server) unreachableSince(ctx context.Context, sessionID string) (time.Time, string, bool) {
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
