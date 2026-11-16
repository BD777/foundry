package assistant

import (
	"cmp"
	"context"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Supervision (docs/personal-agent.md §6): the server follows the sessions
// the assistant handed work to. A turn that ends is reported once, by the
// generic child report (turn_end), so it carries its own status, answer and
// error. The server adds facts the generic path does not produce, as server
// notices (personalagent.Notice, never the person's word): a helper gone
// quiet (TaskSilentAfter without any activity), running past the person's
// StuckAfterMinutes, or unable to reach its model service
// (ServiceUnreachableAfter of nothing but failed attempts; it is told, not
// stopped). Notices to one conversation within TaskEventCoalesce go as one.
// Nothing is told while the assistant is stopped, and the assistant's
// hourly turn limit applies to them as to any turn.

// taskReactions follows the sessions the assistant handed work to.
type taskReactions struct{ s *Service }

func (r taskReactions) SessionChanged(ctx context.Context, change sessions.Change, session store.AgentSession) {
	switch change {
	case sessions.Completed, sessions.Blocked, sessions.Started, sessions.Resumed, sessions.Queued:
		r.s.followTask(ctx, change, session)
	}
}

// TaskOf is the person's assistant and its task following the
// session, when the assistant handed the session work. The task is the
// proof: the conversation that handed it off may since have moved with the
// assistant to another computer (§2), its workspace no longer the
// assistant's.
func (s *Service) TaskOf(ctx context.Context, session store.AgentSession) (store.PersonalAgent, store.PersonalAgentTask, bool) {
	if session.CreatedByUserID == "" {
		return store.PersonalAgent{}, store.PersonalAgentTask{}, false
	}
	agents, err := s.store.ListAssistants(ctx, session.CreatedByUserID)
	if err != nil || len(agents) == 0 {
		return store.PersonalAgent{}, store.PersonalAgentTask{}, false
	}
	for _, agent := range agents {
		tasks, err := s.store.ListPersonalAgentTasks(ctx, agent.ID, nil)
		if err != nil {
			log.Printf("assistant %s: list tasks: %v", agent.ID, err)
			continue
		}
		for _, task := range tasks {
			if task.SessionID == session.ID {
				return agent, task, true
			}
		}
	}
	return agents[0], store.PersonalAgentTask{}, false
}

// followTask brings the session's task up to date. An ended turn is its own
// report (turn_end); supervision adds no second notice for it.
func (s *Service) followTask(ctx context.Context, change sessions.Change, session store.AgentSession) {
	// One waiting on its model service retrying waits for no one:
	// supervision follows whether it reaches the service.
	if change == sessions.Blocked && retryBlocked(session) {
		return
	}
	agent, task, ok := s.TaskOf(ctx, session)
	if !ok {
		return
	}
	switch change {
	case sessions.Completed:
		task.Status, task.EndedAt = taskStatusOf(session.Status), sessionEndedAt(session)
		if err := s.store.UpdatePersonalAgentTask(ctx, store.PersonalAgentActorFoundry, task); err != nil {
			log.Printf("personal agent %s: update task %s: %v", agent.UserID, task.ID, err)
		}
		if session.Status == "failed" || session.Status == "canceled" {
			s.noteHelperFailedOffline(ctx, agent, task, session)
		}
	default:
		// It works again (the assistant passed the answer on).
		task.Status, task.EndedAt, task.StuckSince = store.PersonalAgentTaskRunning, "", ""
		if err := s.store.UpdatePersonalAgentTask(ctx, store.PersonalAgentActorFoundry, task); err != nil {
			log.Printf("personal agent %s: update task %s: %v", agent.UserID, task.ID, err)
		}
	}
}

// AdoptTask makes the assistant conversation that just sent a
// helper more work the one the helper's task reports to: the conversation
// that first handed it off may be over (§7) or, after a move (§2), in a
// project that is no longer the assistant's, where nothing would read the
// helper's news.
func (s *Service) AdoptTask(ctx context.Context, callerSessionID string, helper store.AgentSession) {
	if callerSessionID == "" {
		return
	}
	caller, err := s.store.GetAgentSessionSummary(ctx, callerSessionID)
	if err != nil {
		return
	}
	agent, ok := s.Conversation(ctx, caller)
	if !ok {
		return
	}
	_, task, ok := s.TaskOf(ctx, helper)
	if !ok || task.UserID != agent.UserID || task.ConversationSessionID == caller.ID {
		return
	}
	task.ConversationSessionID = caller.ID
	if err := s.store.UpdatePersonalAgentTask(ctx, store.PersonalAgentActorAssistant, task); err != nil {
		log.Printf("personal agent %s: move task %s to conversation %s: %v", agent.UserID, task.ID, caller.ID, err)
	}
}

// noticeTask tells the task's conversation of one event, unless
// the assistant is stopped.
func (s *Service) noticeTask(ctx context.Context, agent store.PersonalAgent, task store.PersonalAgentTask, session store.AgentSession, kind string, now time.Time) {
	if agent.State != store.PersonalAgentActive || task.ConversationSessionID == "" {
		return
	}
	line := s.taskLine(ctx, agent, task, session, kind, now)
	language := personalagent.LanguageOf(agent.Settings, s.AccountLocale(ctx, agent.UserID))
	s.notices.add(task.ConversationSessionID, language, line, now, func(text string) {
		// The person may have pressed stop meanwhile.
		current, err := s.store.GetAssistant(context.Background(), agent.ID)
		if err != nil || current.State != store.PersonalAgentActive {
			return
		}
		s.tell(context.Background(), task.ConversationSessionID, store.NoticeKindSupervision, text)
	})
}

// taskLine is one task event as the assistant reads it, in the
// person's language: its conversation shows it too.
func (s *Service) taskLine(ctx context.Context, agent store.PersonalAgent, task store.PersonalAgentTask, session store.AgentSession, kind string, now time.Time) string {
	say := func(key string, args ...any) string { return s.sayTask(ctx, agent, key, args...) }
	work := s.taskWork(ctx, agent, task, session)
	switch kind {
	case assistantTaskEventUnreachable:
		since, latest, _ := s.unreachableSince(ctx, session.ID)
		minutes := max(int(now.Sub(since)/time.Minute), int(ServiceUnreachableAfter/time.Minute))
		return say("stuckUnreachable", work, minutes, latest) + "\n" + reasonTag(helperUnreachable, session) + "\n" + s.retryAdvice(ctx, agent, session, true)
	}
	if task.StuckSince != "" {
		return say("stuck", personalagent.EffectiveLimits(agent.Settings.Limits).StuckAfterMinutes, work)
	}
	return say("silent", int(personalagent.TaskSilentAfter/time.Minute), work)
}

// taskWork names a task's work, its project and session, and the link
// that shows the person its progress.
func (s *Service) taskWork(ctx context.Context, agent store.PersonalAgent, task store.PersonalAgentTask, session store.AgentSession) string {
	project := task.WorkspaceID
	if workspace, err := s.store.GetWorkspace(ctx, task.WorkspaceID); err == nil && workspace.Name != "" {
		project = fmt.Sprintf("%q (%s)", workspace.Name, workspace.ID)
	}
	work := s.sayTask(ctx, agent, "work", cmp.Or(task.Title, session.Title), project, session.ID)
	if link := s.SessionURL(session); link != "" {
		work += s.sayTask(ctx, agent, "link", link)
	}
	return work
}

// sayTask is one of taskNoticeTexts in the person's language.
func (s *Service) sayTask(ctx context.Context, agent store.PersonalAgent, key string, args ...any) string {
	language := personalagent.LanguageOf(agent.Settings, s.AccountLocale(ctx, agent.UserID))
	return fmt.Sprintf(taskNoticeTexts[key][languageIndex(language)], args...)
}

// languageIndex picks a [zh, en] pair's text for LanguageOf's language.
func languageIndex(language string) int {
	if language == "en" {
		return 1
	}
	return 0
}

// taskNoticeTexts are the task events' texts, [Chinese, English].
var taskNoticeTexts = map[string][2]string{
	"work":   {"“%s”（项目 %s，会话 %s）", "%q in %s, session %s"},
	"link":   {"（给本人看进度与结果的链接：%s）", " (the link that shows the person its progress and result: %s)"},
	"stuck":  {"已经跑了超过 %d 分钟、没人看过：%s。", "Still running after more than %d minutes and nobody looked at it: %s."},
	"silent": {"%d 分钟没有动静：%s。", "No news for %d minutes: %s."},
	"stuckUnreachable": {"卡住了，连不上它的模型服务：%s 已经 %d 分钟没连上（最近一次：%s）。它还在自己重试，没有被停掉。",
		"Stuck, can't reach its service: %s has not reached its model service for %d minutes (latest: %s). It keeps retrying and was not stopped."},
	helperUnreachable: {"它用的账号“%s”连不上模型服务", "its account %q cannot reach its model service"},
	"retryElsewhere": {"那台电脑上能用的其他账号（可用性观察，不是切换许可；只有角色设置允许的 fallback 可以用）：%s",
		"Other accounts usable on that computer (availability only, not permission to switch; only a fallback the role configuration allows may be used): %s"},
	"stopAndRetryElsewhere": {"它还在运行。那台电脑上能用的其他账号（可用性观察，不是切换许可；只有角色设置允许的 fallback 可以用）：%s",
		"It is still running. Other accounts usable on that computer (availability only, not permission to switch; only a fallback the role configuration allows may be used): %s"},
	"noOtherAccount":      {"那台电脑上没有别的能用的账号。", "No other account works on that computer."},
	"noOtherAccountStuck": {"那台电脑上没有别的能用的账号；它仍在自己重试。", "No other account works on that computer; it keeps retrying by itself."},
	"opQueued": {"排队中：派发步骤 %s 从 %s 起在等项目 %s：会话 %s 从 %s 起一直在运行，这一步等它结束后才开始。",
		"Queued: dispatched step %s has waited since %s for project %s: session %s has been running there since %s; the step starts once it ends."},
	"opQueuedUnsettled": {"排队中：派发步骤 %s 从 %s 起在等项目 %s：之前交过去的一条输入还没确认结束，这一步等它确认后才开始。",
		"Queued: dispatched step %s has waited since %s for project %s: an earlier input sent there has no confirmed end yet; the step starts once it has."},
	"opStarted": {"开始了：派发步骤 %s（从 %s 起排队）现在在会话 %s 里运行。", "Started: dispatched step %s (queued since %s) now runs in session %s."},
	"batch":     {"交出去的事有 %d 条更新：\n- %s", "%d updates on work you handed off:\n- %s"},
	"back": {"电脑“%s”重新上线了。之前在等它的事：\n- %s\n排队等它的事会自己开始，不要重发。",
		"The computer %q is back online. What waited for it:\n- %s\nWork queued for it starts by itself; do not send it again."},
	"waited":         {"%s，在等这台电脑（现在：%s）", "%s waited for it (now %s)"},
	"startsNow":      {"%s，排队等这台电脑，现在自己开始了", "%s was queued for it and is starting by itself now"},
	"refusedOffline": {"你当时因为它不在线没做成：%s", "You could not do this because it was offline: %s"},
	"failedOffline":  {"%s 在它不在线时失败了", "%s failed while it was offline"},
}

// supervisionInterval is how often quiet, long-running and unreachable
// tasks are looked for: often enough that a helper that cannot reach its
// service is told within ServiceUnreachableAfter and half a minute.
var supervisionInterval = 30 * time.Second

// taskSilentMaxGap caps how long a silent helper's reminders may space out.
// After the first, the gap is half the silence so far (doubling: 30m, 1h,
// 2h, ...), so a helper silent for a day is still followed up.
const taskSilentMaxGap = 6 * time.Hour

// superviseNow looks for the assistant's tasks that went quiet
// or ran too long.
func (s *Service) superviseNow(ctx context.Context) {
	if err := s.Supervise(ctx, time.Now()); err != nil && ctx.Err() == nil {
		log.Printf("personal agent supervision: %v", err)
	}
}

// Supervise tells the conversations of the running tasks
// whose session had no activity for TaskSilentAfter (once per such
// silence), or that run past the person's StuckAfterMinutes (once).
func (s *Service) Supervise(ctx context.Context, now time.Time) error {
	sessions, err := s.store.ActiveAgentSessions(ctx)
	if err != nil {
		return err
	}
	for _, session := range sessions {
		// A blocked one already asked for the person, unless it waits on
		// its model service retrying.
		if session.ParentSessionID == "" || (session.Status != "running" && !retryBlocked(session)) {
			continue
		}
		lastActivity, ok := parsePATime(cmp.Or(session.LastActivityAt, session.StartedAt))
		silentFor := now.Sub(lastActivity)
		if !ok {
			continue
		}
		agent, task, ok := s.TaskOf(ctx, session)
		if !ok || (task.Status != store.PersonalAgentTaskRunning && task.Status != store.PersonalAgentTaskQueued) {
			continue
		}
		started, _ := parsePATime(task.CreatedAt)
		stuckAfter := time.Duration(personalagent.EffectiveLimits(agent.Settings.Limits).StuckAfterMinutes) * time.Minute
		lastNotice, noticed := parsePATime(task.LastEventAt)
		// Told once per spell of failed attempts.
		unreachable := func() bool {
			since, _, ok := s.unreachableSince(ctx, session.ID)
			return ok && now.Sub(since) >= ServiceUnreachableAfter && (!noticed || lastNotice.Before(since))
		}
		kind := store.PersonalAgentTaskEventSilent
		switch {
		case task.StuckSince == "" && stuckAfter > 0 && !started.IsZero() && now.Sub(started) >= stuckAfter:
			task.StuckSince = formatPATime(now)
		case unreachable():
			kind = assistantTaskEventUnreachable
		case silentFor >= personalagent.TaskSilentAfter &&
			(!noticed || lastNotice.Before(lastActivity.Add(personalagent.TaskSilentAfter)) ||
				now.Sub(lastNotice) >= min(silentFor/2, taskSilentMaxGap)):
		default:
			continue
		}
		task.LastEventAt = formatPATime(now)
		if err := s.store.UpdatePersonalAgentTask(ctx, store.PersonalAgentActorFoundry, task); err != nil {
			return err
		}
		if kind == assistantTaskEventUnreachable || task.StuckSince == formatPATime(now) {
			s.recordHelperStuck(ctx, agent, task, session, s.taskLine(ctx, agent, task, session, kind, now))
		}
		s.noticeTask(ctx, agent, task, session, kind, now)
	}
	return nil
}

// notices gathers task events per assistant conversation: the
// first after a quiet spell goes at once, the ones within
// TaskEventCoalesce of it go together when that has passed.
type notices struct {
	mu             sync.Mutex
	byConversation map[string]*conversationNotices
}

type conversationNotices struct {
	sentAt   time.Time
	pending  []string
	language string
	send     func(string)
	timer    *time.Timer
}

// CoalesceNotices is TaskEventCoalesce; tests shorten it.
var CoalesceNotices = personalagent.TaskEventCoalesce

// add hands line, or the lines gathered with it, to send, which marks them
// as Foundry's (tell).
func (n *notices) add(conversationID, language, line string, now time.Time, send func(text string)) {
	n.mu.Lock()
	if n.byConversation == nil {
		n.byConversation = map[string]*conversationNotices{}
	}
	for id, kept := range n.byConversation {
		if kept.timer == nil && now.Sub(kept.sentAt) >= CoalesceNotices {
			delete(n.byConversation, id)
		}
	}
	notices := n.byConversation[conversationID]
	if notices == nil {
		notices = &conversationNotices{}
		n.byConversation[conversationID] = notices
	}
	notices.send, notices.language = send, language
	if notices.timer == nil && now.Sub(notices.sentAt) >= CoalesceNotices {
		notices.sentAt = now
		n.mu.Unlock()
		// Not on the caller's goroutine: a steer waits for the device, whose
		// own report may be what called.
		go send(line)
		return
	}
	notices.pending = append(notices.pending, line)
	if notices.timer == nil {
		notices.timer = time.AfterFunc(notices.sentAt.Add(CoalesceNotices).Sub(now), func() { n.flush(conversationID) })
	}
	n.mu.Unlock()
}

func (n *notices) flush(conversationID string) {
	n.mu.Lock()
	notices := n.byConversation[conversationID]
	if notices == nil || len(notices.pending) == 0 {
		n.mu.Unlock()
		return
	}
	lines, send, language := notices.pending, notices.send, notices.language
	notices.pending, notices.timer, notices.sentAt = nil, nil, time.Now()
	n.mu.Unlock()
	text := lines[0]
	if len(lines) > 1 {
		text = fmt.Sprintf(taskNoticeTexts["batch"][languageIndex(language)], len(lines), strings.Join(lines, "\n- "))
	}
	send(text)
}

// SessionURL is the session's conversation on the web, "" without a known
// origin.
func (s *Service) SessionURL(session store.AgentSession) string {
	origin := strings.TrimRight(s.origin, "/")
	if origin == "" || session.ID == "" {
		return ""
	}
	return origin + "/chats/" + url.PathEscape(session.ID) + "?workspace=" + url.QueryEscape(session.WorkspaceID)
}

// ListTasks is list_tasks: the person's tasks in statuses (the unfinished
// ones by default), brought up to date.
func (s *Service) ListTasks(ctx context.Context, scope Scope, statuses []string) ([]store.PersonalAgentTask, error) {
	if len(statuses) == 0 {
		statuses = []string{store.PersonalAgentTaskQueued, store.PersonalAgentTaskRunning, store.PersonalAgentTaskAsking}
	}
	s.RefreshTasks(ctx, scope.Agent)
	tasks, err := s.store.ListPersonalAgentTasks(ctx, scope.Agent.ID, statuses)
	if err != nil {
		return nil, err
	}
	return s.WithTaskWaits(ctx, tasks), nil
}
