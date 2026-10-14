package httpapi

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
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Supervision (docs/personal-agent.md §6): the server follows the sessions
// the assistant handed work to and tells the conversation that handed it
// off, as a server notice (personalagent.Notice, never the person's word),
// when one finishes, fails, ends with a question or waits for an answer,
// or goes quiet (TaskSilentAfter without any activity; running past the
// person's StuckAfterMinutes). Notices to one conversation within
// TaskEventCoalesce go as one. Nothing is told while the assistant is
// stopped, and the assistant's hourly turn limit applies to them as to any
// turn.

// assistantTaskReactions follows the sessions the assistant handed work to.
type assistantTaskReactions struct{ s *Server }

func (r assistantTaskReactions) sessionChanged(ctx context.Context, change sessionChange, session store.AgentSession) {
	if session.ParentSessionID == "" {
		return
	}
	switch change {
	case sessionCompleted, sessionBlocked, sessionStarted, sessionResumed:
		r.s.followAssistantTask(ctx, change, session)
	}
}

// assistantTaskOf is the person's assistant and its task following the
// session, when the assistant handed the session work. The task is the
// proof: the conversation that handed it off may since have moved with the
// assistant to another computer (§2), its workspace no longer the
// assistant's.
func (s *Server) assistantTaskOf(ctx context.Context, session store.AgentSession) (store.PersonalAgent, store.PersonalAgentTask, bool) {
	if session.ParentSessionID == "" || session.CreatedByUserID == "" {
		return store.PersonalAgent{}, store.PersonalAgentTask{}, false
	}
	agent, err := s.store.GetPersonalAgent(ctx, session.CreatedByUserID)
	if err != nil {
		return store.PersonalAgent{}, store.PersonalAgentTask{}, false
	}
	tasks, err := s.store.ListPersonalAgentTasks(ctx, agent.UserID, nil)
	if err != nil {
		log.Printf("personal agent %s: list tasks: %v", agent.UserID, err)
		return agent, store.PersonalAgentTask{}, false
	}
	for _, task := range tasks {
		if task.SessionID == session.ID {
			return agent, task, true
		}
	}
	return agent, store.PersonalAgentTask{}, false
}

// followAssistantTask brings the session's task up to date and tells its
// conversation what needs its attention.
func (s *Server) followAssistantTask(ctx context.Context, change sessionChange, session store.AgentSession) {
	agent, task, ok := s.assistantTaskOf(ctx, session)
	if !ok {
		return
	}
	now := time.Now()
	kind := ""
	switch change {
	case sessionCompleted:
		task.Status, task.EndedAt = taskStatusOf(session.Status), sessionEndedAt(session)
		switch {
		case session.Status == "failed":
			kind = store.PersonalAgentTaskEventFailed
		case session.Status == "completed" && endsWithQuestion(session.Response):
			kind, task.Status, task.EndedAt = store.PersonalAgentTaskEventAsked, store.PersonalAgentTaskAsking, ""
		case session.Status == "completed":
			kind = store.PersonalAgentTaskEventFinished
		}
	case sessionBlocked:
		kind, task.Status = store.PersonalAgentTaskEventAsked, store.PersonalAgentTaskAsking
	default:
		// It works again (the assistant passed the answer on).
		task.Status, task.EndedAt, task.StuckSince = store.PersonalAgentTaskRunning, "", ""
	}
	if kind != "" {
		task.LastEventAt = formatPATime(now)
	}
	if err := s.store.UpdatePersonalAgentTask(ctx, task); err != nil {
		log.Printf("personal agent %s: update task %s: %v", agent.UserID, task.ID, err)
	}
	if kind != "" {
		s.noticeAssistantTask(ctx, agent, task, session, kind, now)
	}
	if kind == store.PersonalAgentTaskEventFailed {
		s.noteHelperFailedOffline(ctx, agent, task, session)
	}
}

// endsWithQuestion reports whether a helper's answer ends by asking.
func endsWithQuestion(response string) bool {
	response = strings.TrimRight(strings.TrimSpace(response), "*_`\"')）」』 ")
	return strings.HasSuffix(response, "?") || strings.HasSuffix(response, "？")
}

// adoptAssistantTask makes the assistant conversation that just sent a
// helper more work the one the helper's task reports to: the conversation
// that first handed it off may be over (§7) or, after a move (§2), in a
// project that is no longer the assistant's, where nothing would read the
// helper's news.
func (s *Server) adoptAssistantTask(ctx context.Context, actor Actor, helper store.AgentSession) {
	if !actor.Agent() || actor.Identity.SessionID == "" {
		return
	}
	caller, err := s.store.GetAgentSessionSummary(ctx, actor.Identity.SessionID)
	if err != nil {
		return
	}
	agent, ok := s.assistantConversation(ctx, caller)
	if !ok {
		return
	}
	_, task, ok := s.assistantTaskOf(ctx, helper)
	if !ok || task.UserID != agent.UserID || task.ConversationSessionID == caller.ID {
		return
	}
	task.ConversationSessionID = caller.ID
	if err := s.store.UpdatePersonalAgentTask(ctx, task); err != nil {
		log.Printf("personal agent %s: move task %s to conversation %s: %v", agent.UserID, task.ID, caller.ID, err)
	}
}

// noticeAssistantTask tells the task's conversation of one event, unless
// the assistant is stopped.
func (s *Server) noticeAssistantTask(ctx context.Context, agent store.PersonalAgent, task store.PersonalAgentTask, session store.AgentSession, kind string, now time.Time) {
	if agent.State != store.PersonalAgentActive || task.ConversationSessionID == "" {
		return
	}
	line := s.assistantTaskLine(ctx, agent, task, session, kind)
	language := personalagent.LanguageOf(agent.Settings, s.accountLocale(ctx, agent.UserID))
	s.assistantNotices.add(task.ConversationSessionID, language, line, now, func(text string) {
		// The person may have pressed stop meanwhile.
		current, err := s.store.GetPersonalAgent(context.Background(), agent.UserID)
		if err != nil || current.State != store.PersonalAgentActive {
			return
		}
		s.tellAssistant(context.Background(), task.ConversationSessionID, text)
	})
}

// taskExcerptChars bounds the part of a helper's answer or error a notice
// quotes.
const taskExcerptChars = 600

// assistantTaskLine is one task event as the assistant reads it, in the
// person's language: its conversation shows it too.
func (s *Server) assistantTaskLine(ctx context.Context, agent store.PersonalAgent, task store.PersonalAgentTask, session store.AgentSession, kind string) string {
	say := func(key string, args ...any) string { return s.sayTask(ctx, agent, key, args...) }
	work := s.taskWork(ctx, agent, task, session)
	answer := cmp.Or(truncateRunes(strings.TrimSpace(session.Response), taskExcerptChars), say("none"))
	switch kind {
	case store.PersonalAgentTaskEventFinished:
		return say("finished", work, answer)
	case store.PersonalAgentTaskEventFailed:
		return say("failed", work, cmp.Or(truncateRunes(strings.TrimSpace(session.Error), taskExcerptChars), say("none")))
	case store.PersonalAgentTaskEventAsked:
		if session.Status == "blocked" {
			return say("blocked", work)
		}
		return say("asked", work, answer)
	}
	if task.StuckSince != "" {
		return say("stuck", personalagent.EffectiveLimits(agent.Settings.Limits).StuckAfterMinutes, work)
	}
	return say("silent", int(personalagent.TaskSilentAfter/time.Minute), work)
}

// taskWork names a task's work, its project and session, and the link
// that shows the person its progress.
func (s *Server) taskWork(ctx context.Context, agent store.PersonalAgent, task store.PersonalAgentTask, session store.AgentSession) string {
	project := task.WorkspaceID
	if workspace, err := s.store.GetWorkspace(ctx, task.WorkspaceID); err == nil && workspace.Name != "" {
		project = fmt.Sprintf("%q (%s)", workspace.Name, workspace.ID)
	}
	work := s.sayTask(ctx, agent, "work", cmp.Or(task.Title, session.Title), project, session.ID)
	if link := s.sessionURL(session); link != "" {
		work += s.sayTask(ctx, agent, "link", link)
	}
	return work
}

// sayTask is one of taskNoticeTexts in the person's language.
func (s *Server) sayTask(ctx context.Context, agent store.PersonalAgent, key string, args ...any) string {
	language := personalagent.LanguageOf(agent.Settings, s.accountLocale(ctx, agent.UserID))
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
	"work": {"“%s”（项目 %s，会话 %s）", "%q in %s, session %s"},
	"link": {"（给本人看进度与结果的链接：%s）", " (the link that shows the person its progress and result: %s)"},
	"none": {"（无）", "(none)"},
	"finished": {"完成了：%s。它的回答开头是：%s\n告诉本人做完之前，先核对证据（read_context：changes、summary、链接）。",
		"Finished: %s. Its answer begins: %s\nCheck its evidence (read_context: changes, summary, links) before you tell the person it is done."},
	"failed": {"失败了：%s。错误：%s\n带着具体错误在同一个助手里重试一次（send_message），或换个办法；再失败就告诉本人出了什么问题、你建议怎么做。",
		"Failed: %s. Error: %s\nRetry once in the same helper with the specific error (send_message), or try another way; if that fails too, tell the person what went wrong and what you suggest."},
	"blocked": {"在等回答或许可：%s。先看它问什么（get_session），用大白话问本人，再用 send_message 把回答传回去。",
		"Waiting for an answer or an approval: %s. Read what it asks (get_session), ask the person in plain words, and pass their answer back with send_message."},
	"asked": {"以提问结束：%s。它问：%s\n用大白话问本人，再用 send_message 把回答传回去。",
		"Ended with a question: %s. It asks: %s\nAsk the person in plain words and pass their answer back with send_message."},
	"stuck": {"已经跑了超过 %d 分钟、没人看过：%s。用 get_session 查看；卡住了就停掉，并告诉本人它可能卡住了。",
		"Still running after more than %d minutes and nobody looked at it: %s. Check it with get_session; stop it if it is stuck, and tell the person it may be stuck."},
	"silent": {"%d 分钟没有动静：%s。用 get_session 查看；卡住了就停掉，并说一声。",
		"No news for %d minutes: %s. Check it with get_session; stop it if it is stuck, and say so."},
	"batch": {"交出去的事有 %d 条更新：\n- %s", "%d updates on work you handed off:\n- %s"},
	"back": {"电脑“%s”重新上线了。之前在等它的事：\n- %s\n逐一看看现在怎样（get_session、list_tasks），还需要做的就接着做或重试，再用大白话告诉本人。",
		"The computer %q is back online. What waited for it:\n- %s\nCheck each one now (get_session, list_tasks), carry on with or retry what still needs doing, and tell the person in plain words."},
	"waited":         {"%s，在等这台电脑（现在：%s）", "%s waited for it (now %s)"},
	"refusedOffline": {"你当时因为它不在线没做成：%s", "You could not do this because it was offline: %s"},
	"failedOffline":  {"%s 因为它不在线而失败了", "%s failed because it was offline"},
}

// supervisionInterval is how often quiet and long-running tasks are looked
// for.
var supervisionInterval = time.Minute

// RunPersonalAgentSupervision looks, every supervisionInterval until ctx
// ends, for the assistant's tasks that went quiet or ran too long.
func (s *Server) RunPersonalAgentSupervision(ctx context.Context) {
	ticker := time.NewTicker(supervisionInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if err := s.superviseAssistantTasks(ctx, time.Now()); err != nil && ctx.Err() == nil {
			log.Printf("personal agent supervision: %v", err)
		}
	}
}

// superviseAssistantTasks tells the conversations of the running tasks
// whose session had no activity for TaskSilentAfter (once per such
// silence), or that run past the person's StuckAfterMinutes (once).
func (s *Server) superviseAssistantTasks(ctx context.Context, now time.Time) error {
	sessions, err := s.store.ActiveAgentSessions(ctx)
	if err != nil {
		return err
	}
	for _, session := range sessions {
		// A blocked one already asked for the person.
		if session.ParentSessionID == "" || session.Status != "running" {
			continue
		}
		lastActivity, ok := parsePATime(cmp.Or(session.LastActivityAt, session.StartedAt))
		silentFor := now.Sub(lastActivity)
		if !ok {
			continue
		}
		agent, task, ok := s.assistantTaskOf(ctx, session)
		if !ok || (task.Status != store.PersonalAgentTaskRunning && task.Status != store.PersonalAgentTaskQueued) {
			continue
		}
		started, _ := parsePATime(task.CreatedAt)
		stuckAfter := time.Duration(personalagent.EffectiveLimits(agent.Settings.Limits).StuckAfterMinutes) * time.Minute
		lastNotice, noticed := parsePATime(task.LastEventAt)
		switch {
		case task.StuckSince == "" && stuckAfter > 0 && !started.IsZero() && now.Sub(started) >= stuckAfter:
			task.StuckSince = formatPATime(now)
		case silentFor >= personalagent.TaskSilentAfter && (!noticed || lastNotice.Before(lastActivity.Add(personalagent.TaskSilentAfter))):
		default:
			continue
		}
		task.LastEventAt = formatPATime(now)
		if err := s.store.UpdatePersonalAgentTask(ctx, task); err != nil {
			return err
		}
		s.noticeAssistantTask(ctx, agent, task, session, store.PersonalAgentTaskEventSilent, now)
	}
	return nil
}

func parsePATime(value string) (time.Time, bool) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return parsed, err == nil
}

// assistantNotices gathers task events per assistant conversation: the
// first after a quiet spell goes at once, the ones within
// TaskEventCoalesce of it go together when that has passed.
type assistantNotices struct {
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

// coalesceNotices is TaskEventCoalesce; tests shorten it.
var coalesceNotices = personalagent.TaskEventCoalesce

// add hands line, or the lines gathered with it, to send, which marks them
// as Foundry's (tellAssistant).
func (n *assistantNotices) add(conversationID, language, line string, now time.Time, send func(text string)) {
	n.mu.Lock()
	if n.byConversation == nil {
		n.byConversation = map[string]*conversationNotices{}
	}
	for id, kept := range n.byConversation {
		if kept.timer == nil && now.Sub(kept.sentAt) >= coalesceNotices {
			delete(n.byConversation, id)
		}
	}
	notices := n.byConversation[conversationID]
	if notices == nil {
		notices = &conversationNotices{}
		n.byConversation[conversationID] = notices
	}
	notices.send, notices.language = send, language
	if notices.timer == nil && now.Sub(notices.sentAt) >= coalesceNotices {
		notices.sentAt = now
		n.mu.Unlock()
		// Not on the caller's goroutine: a steer waits for the device, whose
		// own report may be what called.
		go send(line)
		return
	}
	notices.pending = append(notices.pending, line)
	if notices.timer == nil {
		notices.timer = time.AfterFunc(notices.sentAt.Add(coalesceNotices).Sub(now), func() { n.flush(conversationID) })
	}
	n.mu.Unlock()
}

func (n *assistantNotices) flush(conversationID string) {
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

// sessionURL is the session's conversation on the web, "" without a known
// origin.
func (s *Server) sessionURL(session store.AgentSession) string {
	origin := strings.TrimRight(s.options.AllowedOrigin, "/")
	if origin == "" || session.ID == "" {
		return ""
	}
	return origin + "/chats/" + url.PathEscape(session.ID) + "?workspace=" + url.QueryEscape(session.WorkspaceID)
}
