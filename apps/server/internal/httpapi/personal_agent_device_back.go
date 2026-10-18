package httpapi

import (
	"cmp"
	"context"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A computer coming back (docs/personal-agent.md §6): when one of the
// person's computers connects again after being away, the assistant
// conversations with something that waited for it hear so, as a server
// notice merged with the task events (assistantNotices) and never while
// the assistant is stopped: the helpers queued for it, which start by
// themselves now (work sent to an offline computer waits for it,
// session_device_wait.go), the helpers on it still running or waiting, the
// helpers that failed while it was offline (one that waited past
// offlineWaitLimit) and the writes the assistant was refused for that
// reason. A connection that drops for less than deviceBackAfter and comes
// back tells nothing about the helpers; a refused write is told whatever
// the absence. What this follows lives in memory: after a server restart
// nothing was away.

// deviceBackAfter is how long a computer is away before the helpers on it
// are said to have waited for it.
var deviceBackAfter = time.Minute

// offlineRefusalsMax bounds the refused writes kept per computer.
const offlineRefusalsMax = 20

// offlineRefusal is what the assistant could not do because the computer
// was offline (a write refused, a helper that failed), for the
// conversation that tried, as the back notice lists it.
type offlineRefusal struct {
	userID, conversationID, line string
}

// assistantDeviceWaits keeps the refused writes per computer until it
// comes back, and the drop each computer's return was last told for.
type assistantDeviceWaits struct {
	mu       sync.Mutex
	refusals map[string][]offlineRefusal
	told     map[string]string
}

func (w *assistantDeviceWaits) refused(deviceID string, refusal offlineRefusal) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.refusals == nil {
		w.refusals = map[string][]offlineRefusal{}
	}
	kept := append(w.refusals[deviceID], refusal)
	if len(kept) > offlineRefusalsMax {
		kept = kept[len(kept)-offlineRefusalsMax:]
	}
	w.refusals[deviceID] = kept
}

// back takes the computer's refused writes, and reports whether its drop
// (dropID) is news: a hello sent again on the same connection is not.
func (w *assistantDeviceWaits) back(deviceID, dropID string) ([]offlineRefusal, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	refusals := w.refusals[deviceID]
	delete(w.refusals, deviceID)
	if w.told == nil {
		w.told = map[string]string{}
	}
	news := dropID != "" && w.told[deviceID] != dropID
	if dropID != "" {
		w.told[deviceID] = dropID
	}
	return refusals, news
}

// noteOfflineRefusal keeps a write refused because its computer is offline
// for when that computer is back.
func (s *Server) noteOfflineRefusal(ctx context.Context, scope paScope, tool string, write paWrite, err error) {
	if !errors.Is(err, ErrLocalDaemonNotConnected) {
		return
	}
	deviceID := write.deviceID
	if deviceID == "" && write.workspaceID != "" {
		if workspace, err := s.store.GetWorkspace(ctx, write.workspaceID); err == nil {
			deviceID = workspace.DeviceID
		}
	}
	if deviceID == "" || scope.sessionID == "" {
		return
	}
	s.assistantDeviceWaits.refused(deviceID, offlineRefusal{
		userID: scope.agent.UserID, conversationID: scope.sessionID,
		line: s.sayTask(ctx, scope.agent, "refusedOffline", strings.TrimSpace(tool+": "+cutSummary(write.argsSummary))),
	})
}

// awayFor is how long the computer was away before its current connection,
// from its last drop as the server saw it or, later, as its worker
// reported it; ok is false when no drop is known. The drop's id tells one
// absence from another.
func (h *DaemonHub) awayFor(deviceID string, now time.Time) (away time.Duration, dropID string, ok bool) {
	entry, known := h.disconnects.lookup(deviceID)
	if !known {
		return 0, "", false
	}
	dropped, parsed := parsePATime(entry.At)
	if entry.Worker != nil {
		if closed, ok := parsePATime(entry.Worker.ClosedAt); ok && (!parsed || closed.After(dropped)) {
			dropped, parsed = closed, true
		}
	}
	if !parsed {
		return 0, "", false
	}
	return now.Sub(dropped), dropped.UTC().Format(time.RFC3339Nano), true
}

// assistantDeviceBack tells each assistant conversation what waited for
// the computer that just connected.
func (s *Server) assistantDeviceBack(ctx context.Context, deviceID string) {
	now := time.Now()
	away, dropID, known := s.hub.awayFor(deviceID, now)
	refusals, news := s.assistantDeviceWaits.back(deviceID, dropID)
	type conversation struct {
		userID string
		lines  []string
	}
	conversations := map[string]*conversation{}
	order := []string{}
	add := func(userID, conversationID, line string) {
		if conversationID == "" {
			return
		}
		if conversations[conversationID] == nil {
			conversations[conversationID] = &conversation{userID: userID}
			order = append(order, conversationID)
		}
		conversations[conversationID].lines = append(conversations[conversationID].lines, line)
	}
	if known && news && away >= deviceBackAfter {
		sessions, err := s.store.UnsettledAgentSessionsOnDevice(ctx, deviceID)
		if err != nil {
			log.Printf("personal agent: helpers on %s that waited for it: %v", deviceID, err)
		}
		for _, session := range sessions {
			agent, task, ok := s.assistantTaskOf(ctx, session)
			if !ok || (task.Status != store.PersonalAgentTaskQueued && task.Status != store.PersonalAgentTaskRunning && task.Status != store.PersonalAgentTaskAsking) {
				continue
			}
			add(agent.UserID, task.ConversationSessionID, s.assistantWaitLine(ctx, agent, task, session))
		}
	}
	for _, refusal := range refusals {
		add(refusal.userID, refusal.conversationID, refusal.line)
	}
	if len(order) == 0 {
		return
	}
	label := cmp.Or(s.deviceLabels(ctx)[deviceID], deviceID)
	for _, conversationID := range order {
		waited := conversations[conversationID]
		agent, err := s.store.GetPersonalAgent(ctx, waited.userID)
		if err != nil || agent.State != store.PersonalAgentActive {
			continue
		}
		language := personalagent.LanguageOf(agent.Settings, s.accountLocale(ctx, agent.UserID))
		text := s.sayTask(ctx, agent, "back", label, strings.Join(waited.lines, "\n- "))
		s.assistantNotices.add(conversationID, language, text, now, func(text string) {
			// The person may have pressed stop meanwhile.
			current, err := s.store.GetPersonalAgent(context.Background(), agent.UserID)
			if err != nil || current.State != store.PersonalAgentActive {
				return
			}
			s.tellAssistant(context.Background(), conversationID, text)
		})
	}
}

// assistantWaitLine is a helper that waited for its computer, as the
// back notice lists it: one still queued is being started.
func (s *Server) assistantWaitLine(ctx context.Context, agent store.PersonalAgent, task store.PersonalAgentTask, session store.AgentSession) string {
	if session.Status == "queued" {
		return s.sayTask(ctx, agent, "startsNow", s.taskWork(ctx, agent, task, session))
	}
	return s.sayTask(ctx, agent, "waited", s.taskWork(ctx, agent, task, session), session.Status)
}

// noteHelperFailedOffline keeps a helper that failed while its computer
// was offline (it waited for it too long, or stopped reporting) for when
// that computer is back.
func (s *Server) noteHelperFailedOffline(ctx context.Context, agent store.PersonalAgent, task store.PersonalAgentTask, session store.AgentSession) {
	if session.DeviceID == "" || task.ConversationSessionID == "" || s.hub.HasConnection(session.DeviceID) {
		return
	}
	s.assistantDeviceWaits.refused(session.DeviceID, offlineRefusal{
		userID: agent.UserID, conversationID: task.ConversationSessionID,
		line: s.sayTask(ctx, agent, "failedOffline", s.taskWork(ctx, agent, task, session)),
	})
}
