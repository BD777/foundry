package httpapi

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent"
	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/flow"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The person's list (docs/personal-agent.md §6, store.PersonalAgentListItem):
// what the person told the assistant they plan to do, are doing or did. The
// assistant writes it with update_list, only from the person's own words
// in the conversation (the quote, as remember checks it), and reads it with
// read_list; each turn's context shows the open items. The person ticks,
// edits and deletes items on the home page. An open item with a time and
// remind set is a reminder: when it is due the server tells the assistant's
// latest conversation, which tells the person wherever they last talked to
// it (the web, or their Feishu direct chat). The daily digest, when the
// person turned it on, goes the same way at their time with the list and
// the work in progress.

// paListSpec is update_list's arguments.
type paListSpec struct {
	Op   string         `json:"op"`
	Item paListItemArgs `json:"item"`
}

// paListItemArgs is update_list's item: absent fields stay as they are.
type paListItemArgs struct {
	Revision  *int64                       `json:"revision,omitempty"`
	IntentKey string                       `json:"intentKey,omitempty"`
	Plan      *store.PersonalAgentItemPlan `json:"plan,omitempty"`
	ID        string                       `json:"id,omitempty"`
	Text      *string                      `json:"text,omitempty"`
	When      *string                      `json:"when,omitempty"`
	At        *string                      `json:"at,omitempty"`
	Remind    *bool                        `json:"remind,omitempty"`
	Status    *string                      `json:"status,omitempty"`
	TaskID    *string                      `json:"taskId,omitempty"`
	Quote     string                       `json:"quote,omitempty"`
}

const listNoteUngrounded = "not added: the quote is not in anything the person wrote in this conversation (a document, web page, file, helper's output or Foundry's own notice is not their words). The list holds only what the person told you; quote their exact words."

func (s *Server) updateListForMCP(call mcpCall) (string, error) {
	return s.assistantWrite(call, "update_list", (*Server).planUpdateList)
}

// planUpdateList adds or changes one item of the person's list. What it
// says of the person (text, when, time, reminder, status) must rest on
// their words in this conversation; linking the assistant's own task does
// not. Its audit keeps the op and the item id only.
func (s *Server) planUpdateList(ctx context.Context, scope paScope, args map[string]json.RawMessage) (paWrite, error) {
	var spec paListSpec
	if err := decodeArgs(args, &spec); err != nil {
		return paWrite{argsSummary: "update_list"}, err
	}
	id := strings.TrimSpace(spec.Item.ID)
	write := paWrite{argsSummary: strings.TrimSpace(spec.Op + " " + id),
		spec: map[string]any{"op": spec.Op, "item": map[string]string{"id": id}}}
	userID := scope.agent.UserID
	var item store.PersonalAgentListItem
	switch spec.Op {
	case "add":
		if id != "" {
			return write, invalid("add makes a new item and takes no item.id; to change one, use update")
		}
		if spec.Item.Text == nil {
			return write, invalid("item.text is required to add")
		}
		item = store.PersonalAgentListItem{UserID: userID, SourceSessionID: scope.sessionID, SourceInputID: scope.turn.ID, Status: store.PersonalAgentItemOpen}
		if inbox, err := s.assistantInboxStore(); err == nil {
			if source, err := inbox.PersonalAgentInboxByInput(ctx, userID, scope.turn.ID); err == nil {
				item.SourceInboxID = source.RootID
			}
		}
	case "update":
		existing, err := s.store.GetPersonalAgentItem(ctx, userID, id)
		if err != nil {
			return write, refuse(store.PersonalAgentRefusalInvalid, http.StatusNotFound, "no item %q on the person's list (read_list shows them)", id)
		}
		item = existing
		if spec.Item.Revision != nil && *spec.Item.Revision != item.Revision {
			return write, &statusError{http.StatusConflict, store.ErrPersonalAgentRevision}
		}
	default:
		return write, invalid("op must be add or update")
	}
	location := s.personLocation(ctx, scope.agent)
	personal := false
	if spec.Item.Plan != nil {
		if err := s.validateAssistantItemPlan(ctx, userID, item.ID, spec.Item.Plan); err != nil {
			return write, err
		}
		item.Plan, personal = spec.Item.Plan, true
	}
	if spec.Item.Text != nil {
		text, err := personalagent.ListItemText(*spec.Item.Text)
		if err != nil {
			return write, invalid("%v", err)
		}
		item.Text, personal = text, true
	}
	if spec.Item.When != nil {
		when, err := personalagent.ListItemWhen(*spec.Item.When)
		if err != nil {
			return write, invalid("%v", err)
		}
		item.When, personal = when, true
	}
	atChanged := false
	if spec.Item.At != nil {
		at, err := personalagent.ListItemAt(*spec.Item.At, location)
		if err != nil {
			return write, invalid("%v", err)
		}
		atChanged, item.At, personal = at != item.At, at, true
	}
	remindSet := false
	if spec.Item.Remind != nil {
		remindSet, item.Remind, personal = *spec.Item.Remind && !item.Remind, *spec.Item.Remind, true
	}
	if spec.Item.Status != nil {
		if err := personalagent.ListItemStatus(*spec.Item.Status); err != nil {
			return write, invalid("%v", err)
		}
		item.Status, personal = *spec.Item.Status, true
	}
	if spec.Item.TaskID != nil {
		taskID := strings.TrimSpace(*spec.Item.TaskID)
		if taskID != "" && !s.assistantHasTask(ctx, userID, taskID) {
			return write, invalid("no task %q of yours: item.taskId is the id list_tasks or the turn's context shows", taskID)
		}
		item.TaskID = taskID
	} else if !personal {
		return write, invalid("nothing to change: give the fields to set")
	}
	if item.Remind && item.At == "" {
		return write, invalid("remind needs item.at, the time to remind the person; if you do not know it, ask them once")
	}
	if at, err := time.Parse(time.RFC3339, item.At); err == nil && item.Remind && item.Status == store.PersonalAgentItemOpen &&
		(atChanged || remindSet) && !at.After(time.Now()) {
		return write, invalid("item.at is already past (now %s): a reminder needs a time to come", time.Now().In(location).Format("2006-01-02 15:04 MST"))
	}

	if personal {
		quote := strings.TrimSpace(spec.Item.Quote)
		if quote == "" {
			return write, invalid("item.quote is required: copy the person's own words this rests on from their messages in this conversation")
		}
		said, err := s.personSaid(ctx, scope.sessionID, scope.turn)
		if err != nil {
			return write, err
		}
		if !personalagent.QuoteGrounded(quote, said) {
			return write, invalid("%s", listNoteUngrounded)
		}
		if item.Quote == "" {
			item.Quote = quote
		}
	}
	if item.Status == store.PersonalAgentItemDone && (item.Plan == nil || len(item.Plan.Evidence) == 0) {
		// Recording something the person says they already did is different from
		// claiming our execution succeeded. Preserve their current words as the
		// self-report; an agent-generated completion needs result evidence.
		words, current := personalagent.PersonWords(scope.turn)
		if spec.Op != "add" || !current || !personalagent.QuoteGrounded(spec.Item.Quote, []string{words}) {
			return write, invalid("record completion evidence before marking an existing item done; a session ending alone does not prove its goal")
		}
		if item.Plan == nil {
			item.Plan = &store.PersonalAgentItemPlan{Mode: "record", Progress: "review"}
		}
		item.Plan.Evidence = []store.PersonalAgentCompletionEvidence{{Kind: "user", Ref: "session:" + scope.sessionID + "/event/evt_" + scope.turn.ID, Summary: spec.Item.Quote, ObservedAt: scope.turn.At}}
	}
	write.apply = func(ctx context.Context) (any, error) {
		var saved store.PersonalAgentListItem
		var err error
		if spec.Op == "add" {
			intentKey := strings.TrimSpace(spec.Item.IntentKey)
			if len(intentKey) > 100 {
				return nil, invalid("intentKey must be at most 100 bytes")
			}
			if intentKey == "" {
				intentKey = flow.Key("intent", item.Text)
			}
			sourceID := scope.turn.ID
			if item.SourceInboxID != "" {
				sourceID = item.SourceInboxID
			}
			item.CaptureKey = flow.Key("item", userID, sourceID, intentKey)
			item.CaptureHash, err = flow.Fingerprint(struct {
				Text, When, At, Status, Quote string
				Remind                        bool
				Plan                          *store.PersonalAgentItemPlan
			}{item.Text, item.When, item.At, item.Status, item.Quote, item.Remind, item.Plan})
			if err != nil {
				return nil, err
			}
			saved, err = s.store.AddPersonalAgentItem(ctx, item)
		} else {
			saved, err = s.store.SavePersonalAgentItem(ctx, item)
		}
		if err != nil {
			if errors.Is(err, store.ErrIdempotencyConflict) || errors.Is(err, store.ErrPersonalAgentRevision) {
				return nil, &statusError{http.StatusConflict, err}
			}
			return nil, err
		}
		if saved.Text == "" {
			return map[string]string{"status": "already_removed", "id": saved.ID, "note": "The person removed this item. Replaying its original input does not add it again."}, nil
		}
		answer := map[string]any{"status": "applied", "item": saved}
		if note := reminderNote(saved, location); note != "" {
			answer["note"] = note
		}
		return answer, nil
	}
	return write, nil
}

// reminderNote tells the assistant when Foundry reminds it of the item.
func reminderNote(item store.PersonalAgentListItem, location *time.Location) string {
	at, err := time.Parse(time.RFC3339, item.At)
	if err != nil || !item.Remind || item.Status != store.PersonalAgentItemOpen || item.RemindedAt != "" {
		return ""
	}
	return fmt.Sprintf("Foundry will remind you of it at %s (%s); then remind the person in a sentence.",
		at.In(location).Format("2006-01-02 15:04"), location.String())
}

func (s *Server) assistantHasTask(ctx context.Context, userID, taskID string) bool {
	tasks, err := s.store.ListPersonalAgentTasks(ctx, userID, nil)
	if err != nil {
		return false
	}
	for _, task := range tasks {
		if task.ID == taskID {
			return true
		}
	}
	return false
}

// readListForMCP answers the person's open items and those closed since
// closedSince (a date or time; the start of the person's today by
// default), with the time now in their zone.
func (s *Server) readListForMCP(call mcpCall) (string, error) {
	ctx := call.r.Context()
	scope, err := s.paScope(ctx, call.actor)
	if err != nil {
		return "", err
	}
	location := s.personLocation(ctx, scope.agent)
	now := time.Now().In(location)
	since := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, location)
	if value := strings.TrimSpace(mcpArgString(call.args, "closedSince")); value != "" {
		if day, err := time.ParseInLocation(time.DateOnly, value, location); err == nil {
			since = day
		} else if at, err := time.Parse(time.RFC3339, value); err == nil {
			since = at
		} else {
			return "", &statusError{http.StatusBadRequest, errors.New("closedSince is a date (2026-10-15) or a time (RFC 3339)")}
		}
	}
	items, err := s.store.ListPersonalAgentItems(ctx, scope.agent.UserID, formatPATime(since))
	if err != nil {
		return "", err
	}
	items, err = s.includeItemDependencies(ctx, scope.agent.UserID, items)
	if err != nil {
		return "", err
	}
	operations := []store.PersonalAgentOperation{}
	if backing, err := s.assistantOperationStore(); err == nil {
		operations, err = backing.ListPersonalAgentOperations(ctx, scope.agent.UserID)
		if err != nil {
			return "", err
		}
	}
	return encodeJSON(map[string]any{"now": now.Format("2006-01-02 15:04 MST"), "items": items, "operations": operations})
}

// handleListPersonalAgentItems answers the person's open items and those
// closed since ?closedSince (none without it).
func (s *Server) handleListPersonalAgentItems(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	since := ""
	if value := strings.TrimSpace(r.URL.Query().Get("closedSince")); value != "" {
		at, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			writeError(w, http.StatusBadRequest, "closedSince must be an RFC 3339 time")
			return
		}
		since = formatPATime(at)
	}
	items, err := s.store.ListPersonalAgentItems(r.Context(), agent.UserID, since)
	if err == nil {
		items, err = s.includeItemDependencies(r.Context(), agent.UserID, items)
	}
	writeResult(w, items, err)
}

// handleEditPersonalAgentItem is the person's own edit: their words, so no
// quote. Changing when clears the time and the reminder, which no longer
// match it.
func (s *Server) handleEditPersonalAgentItem(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	var input store.PersonalAgentListItemInput
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	item, err := s.store.GetPersonalAgentItem(r.Context(), agent.UserID, r.PathValue("id"))
	if err != nil {
		writeResult(w, nil, err)
		return
	}
	bad := func(err error) { writeError(w, http.StatusBadRequest, err.Error()) }
	if input.Revision != nil && *input.Revision != item.Revision {
		writeError(w, http.StatusConflict, store.ErrPersonalAgentRevision.Error())
		return
	}
	if input.Plan != nil {
		if err := s.validateAssistantItemPlan(r.Context(), agent.UserID, item.ID, input.Plan); err != nil {
			writeResult(w, nil, err)
			return
		}
		item.Plan = input.Plan
	}
	if input.Text != nil {
		if item.Text, err = personalagent.ListItemText(*input.Text); err != nil {
			bad(err)
			return
		}
	}
	if input.When != nil {
		when, err := personalagent.ListItemWhen(*input.When)
		if err != nil {
			bad(err)
			return
		}
		if when != item.When {
			item.When, item.At, item.Remind = when, "", false
		}
	}
	if input.Status != nil {
		if err := personalagent.ListItemStatus(*input.Status); err != nil {
			bad(err)
			return
		}
		item.Status = *input.Status
		if item.Status == store.PersonalAgentItemDone {
			if item.Plan == nil {
				item.Plan = &store.PersonalAgentItemPlan{Mode: "record", Progress: "review"}
			}
			item.Plan.Evidence = append(item.Plan.Evidence, store.PersonalAgentCompletionEvidence{Kind: "user", Ref: "person:" + agent.UserID, Summary: "Marked complete by the person", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)})
			if len(item.Plan.Evidence) > 32 {
				item.Plan.Evidence = item.Plan.Evidence[len(item.Plan.Evidence)-32:]
			}
		}
	}
	saved, err := s.store.SavePersonalAgentItem(r.Context(), item)
	if errors.Is(err, store.ErrPersonalAgentRevision) {
		err = &statusError{http.StatusConflict, err}
	}
	writeResult(w, saved, err)
}

func (s *Server) handleDeletePersonalAgentItem(w http.ResponseWriter, r *http.Request) {
	agent, ok := s.personalAgentOf(w, r)
	if !ok {
		return
	}
	if err := s.store.DeletePersonalAgentItem(r.Context(), agent.UserID, r.PathValue("id")); err != nil {
		writeResult(w, nil, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// latestAssistantConversation is the assistant conversation the person
// last talked in: where a reminder or the digest reaches them. "" when
// there is none.
func (s *Server) latestAssistantConversation(ctx context.Context, agent store.PersonalAgent) string {
	sessions, err := s.store.ListAgentSessionSummaries(ctx, agent.WorkspaceID)
	if err != nil {
		log.Printf("personal agent %s: list conversations: %v", agent.UserID, err)
		return ""
	}
	latest, latestAt := "", ""
	for _, session := range sessions {
		if _, ok := s.assistantConversation(ctx, session); !ok {
			continue
		}
		if at := cmp.Or(session.ActivityAt, session.LastActivityAt, session.StartedAt); latest == "" || at > latestAt {
			latest, latestAt = session.ID, at
		}
	}
	return latest
}

// listNoticeTexts are the reminder's and the digest's notices, [Chinese,
// English]: the conversation shows them too.
var listNoticeTexts = map[string][2]string{
	"reminder": {"到点提醒（本人清单上的事，%s）：“%s”（本人说的时间：%s）。用一两句大白话提醒本人这件事，只提醒，不要替本人联系任何人。本人说做完了，再用 update_list 标记（条目 %s）。",
		"Reminder due (an item on the person's list, %s): %q (when they said: %s). Remind the person of it in a sentence or two, nothing more, and contact no one for them. When they say it is done, mark it with update_list (item %s)."},
	"digest": {"每日小结时间到了（%s）。下面是 Foundry 记下的事实：\n%s\n用几句大白话给本人写今天的小结：先说做完了的，再说还要做的计划（有时间的带上时间），最后一句说你在跟进的事。只用上面的内容，不要编，不要提议联系别人。",
		"Time for the daily digest (%s). What Foundry has on record:\n%s\nWrite the person a short digest in plain words: what got done, then the plans still open (with their times), then one line on the work you follow up. Use only what is above, invent nothing, and suggest contacting no one."},
	"open":       {"清单上还没做的：", "Open on the person's list:"},
	"closed":     {"过去一天做完的：", "Done in the last day:"},
	"dropped":    {"（不做了）", " (dropped)"},
	"tasks":      {"你交出去、还在跟进的事：", "Work you handed off and follow up:"},
	"tasksEnded": {"你交出去、过去一天结束的事：", "Work you handed off that ended in the last day:"},
	"noWhen":     {"没说", "not said"},
	"when":       {"（%s）", " (%s)"},
}

func (s *Server) sayList(ctx context.Context, agent store.PersonalAgent, key string, args ...any) string {
	language := personalagent.LanguageOf(agent.Settings, s.accountLocale(ctx, agent.UserID))
	text := listNoticeTexts[key][languageIndex(language)]
	if len(args) == 0 {
		return text
	}
	return fmt.Sprintf(text, args...)
}

// reminderInterval is how often due reminders and digests are looked for.
var reminderInterval = time.Minute

// RunPersonalAgentReminders sends, every reminderInterval until ctx ends,
// the reminders and daily digests that are due.
func (s *Server) RunPersonalAgentReminders(ctx context.Context) {
	ticker := time.NewTicker(reminderInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		now := time.Now()
		if err := s.sendAssistantReminders(ctx, now); err != nil && ctx.Err() == nil {
			log.Printf("personal agent reminders: %v", err)
		}
		if err := s.sendAssistantDigests(ctx, now); err != nil && ctx.Err() == nil {
			log.Printf("personal agent digests: %v", err)
		}
	}
}

// sendAssistantReminders tells the assistant of each item whose reminder
// is due, once, unless the assistant is stopped (it is then not sent).
func (s *Server) sendAssistantReminders(ctx context.Context, now time.Time) error {
	due, err := s.store.DuePersonalAgentReminders(ctx, now.UTC().Format(time.RFC3339))
	if err != nil {
		return err
	}
	for _, item := range due {
		agent, err := s.store.GetPersonalAgent(ctx, item.UserID)
		if err != nil || agent.State != store.PersonalAgentActive {
			continue
		}
		conversation := cmp.Or(s.latestAssistantConversation(ctx, agent), item.SourceSessionID)
		if conversation == "" {
			continue
		}
		if claimed, err := s.store.ClaimPersonalAgentReminder(ctx, item.UserID, item.ID, item.At); err != nil || !claimed {
			continue
		}
		location := s.personLocation(ctx, agent)
		at, _ := time.Parse(time.RFC3339, item.At)
		text := s.sayList(ctx, agent, "reminder", at.In(location).Format("15:04"), item.Text,
			cmp.Or(item.When, s.sayList(ctx, agent, "noWhen")), item.ID)
		s.tellAssistant(ctx, conversation, text)
	}
	return nil
}

// digestWindow is how long after the person's digest time a digest still
// goes out (the server was down at the time); turned on later in the day,
// the first one goes out the next day.
const digestWindow = 2 * time.Hour

// sendAssistantDigests sends each active assistant whose person turned the
// daily digest on, once a day at their time, the facts for it: their list
// and the work it follows up. With nothing on record, nothing is sent.
func (s *Server) sendAssistantDigests(ctx context.Context, now time.Time) error {
	agents, err := s.store.ListPersonalAgents(ctx)
	if err != nil {
		return err
	}
	for _, agent := range agents {
		if !agent.Settings.DailyDigest || agent.State != store.PersonalAgentActive {
			continue
		}
		location := s.personLocation(ctx, agent)
		local := now.In(location)
		clock, err := time.ParseInLocation("15:04", cmp.Or(agent.Settings.DailyDigestTime, "09:00"), location)
		if err != nil {
			continue
		}
		due := time.Date(local.Year(), local.Month(), local.Day(), clock.Hour(), clock.Minute(), 0, 0, location)
		if local.Before(due) || !local.Before(due.Add(digestWindow)) {
			continue
		}
		facts, err := s.assistantDigestFacts(ctx, agent, now)
		if err != nil {
			log.Printf("personal agent %s: digest facts: %v", agent.UserID, err)
			continue
		}
		if claimed, err := s.store.ClaimPersonalAgentDigest(ctx, agent.UserID, local.Format(time.DateOnly)); err != nil || !claimed || facts == "" {
			continue
		}
		conversation := s.latestAssistantConversation(ctx, agent)
		if conversation == "" {
			continue
		}
		s.tellAssistant(ctx, conversation, s.sayList(ctx, agent, "digest", local.Format("2006-01-02 15:04"), facts))
	}
	return nil
}

// assistantDigestFacts lists, for the digest, the person's open items, the
// items closed and the tasks open or ended in the last day; "" when there
// is none.
func (s *Server) assistantDigestFacts(ctx context.Context, agent store.PersonalAgent, now time.Time) (string, error) {
	dayAgo := formatPATime(now.Add(-24 * time.Hour))
	items, err := s.store.ListPersonalAgentItems(ctx, agent.UserID, dayAgo)
	if err != nil {
		return "", err
	}
	s.refreshAssistantTasks(ctx, agent.UserID)
	tasks, err := s.store.ListPersonalAgentTasks(ctx, agent.UserID, nil)
	if err != nil {
		return "", err
	}
	location := s.personLocation(ctx, agent)
	var open, closed, running, ended []string
	for _, item := range items {
		line := item.Text
		if item.When != "" {
			line += s.sayList(ctx, agent, "when", item.When)
		}
		if at, err := time.Parse(time.RFC3339, item.At); err == nil {
			line += " " + at.In(location).Format("01-02 15:04")
		}
		switch item.Status {
		case store.PersonalAgentItemOpen:
			open = append(open, line)
		case store.PersonalAgentItemDropped:
			closed = append(closed, line+s.sayList(ctx, agent, "dropped"))
		default:
			closed = append(closed, line)
		}
	}
	for _, task := range tasks {
		switch {
		case task.Status == store.PersonalAgentTaskQueued || task.Status == store.PersonalAgentTaskRunning || task.Status == store.PersonalAgentTaskAsking:
			running = append(running, task.Title)
		case task.EndedAt >= dayAgo:
			ended = append(ended, task.Title+" ("+task.Status+")")
		}
	}
	var out strings.Builder
	for _, group := range []struct {
		key   string
		lines []string
	}{{"open", open}, {"closed", closed}, {"tasks", running}, {"tasksEnded", ended}} {
		if len(group.lines) == 0 {
			continue
		}
		out.WriteString(s.sayList(ctx, agent, group.key) + "\n- " + strings.Join(group.lines, "\n- ") + "\n")
	}
	return strings.TrimRight(out.String(), "\n"), nil
}

// Closed prerequisites may predate today's list. Return their current state as
// well so the UI and router never mistake a missing display row for unfinished work.
func (s *Server) includeItemDependencies(ctx context.Context, user string, items []store.PersonalAgentListItem) ([]store.PersonalAgentListItem, error) {
	seen := map[string]bool{}
	for _, item := range items {
		seen[item.ID] = true
	}
	added := 0
	for i := 0; i < len(items); i++ {
		if items[i].Plan == nil {
			continue
		}
		for _, id := range items[i].Plan.Dependencies {
			if seen[id] {
				continue
			}
			if added >= 256 {
				return nil, invalid("dependency view exceeds the supported graph size")
			}
			item, e := s.store.GetPersonalAgentItem(ctx, user, id)
			if e != nil {
				return nil, e
			}
			seen[id] = true
			items = append(items, item)
			added++
		}
	}
	return items, nil
}
