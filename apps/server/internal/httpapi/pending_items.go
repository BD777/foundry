package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/personalagent/assistant"
	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// Pending items (DEV-079) are what waits for the person in their sessions,
// found in what the sessions already record: questions an Agent asked, an
// Issue's question, a turn that failed, and a permission its runtime refused. Nothing here asks an Agent anything or changes what it is told; no
// model reads anything.

// pendingReactions finds items as sessions and Issues record them, and
// resolves them when the person answers or a later turn makes them moot.
type pendingReactions struct{ s *Server }

// Limits on the words an item keeps: enough to decide without opening the
// chat, never a whole transcript.
const (
	pendingExcerptLimit = 2000
	pendingContextLimit = 1200
	pendingTitleLimit   = 200
	// pendingResolvedWindow is how long resolved items stay listed.
	pendingResolvedWindow = 7 * 24 * time.Hour
)

// pendingSession is the session an event or change belongs to, when items
// are kept for it: a chat the person started, or a helper the person's
// assistant handed work to (docs/assistant-orchestration.md §h). Issue
// executions report through their Issue; utility, verification and other
// Agent-started sessions answer to whoever started them.
func (s *Server) pendingSession(ctx context.Context, sessionID string) (store.AgentSession, bool) {
	session, err := s.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil {
		return store.AgentSession{}, false
	}
	return session, s.pendingKept(ctx, session)
}

// pendingKept reports whether items are kept for session: a chat the person
// started, or a helper its assistant answers for.
func (s *Server) pendingKept(ctx context.Context, session store.AgentSession) bool {
	if pendingChat(session) {
		return true
	}
	if session.ArchivedAt != "" || session.IssueID != "" || session.Source != store.SessionSourceAgent {
		return false
	}
	return s.assistant.ResponsibleFor(ctx, session).Party == assistant.ResponsibleAssistant
}

// pendingAnswers reports whether an input to session answers what it showed
// before: a message from the person, or, for a helper, from the assistant
// conversation that started it; never a timer.
func pendingAnswers(session store.AgentSession, sentBySessionID string) bool {
	return sentBySessionID == "" || (session.ParentSessionID != "" && sentBySessionID == session.ParentSessionID)
}

// pendingChannelPersonMessage reports whether a queued channel turn carries
// the person's own words. A batch with no origin is a direct message and
// counts as before. In a channel batch only a message with
// "sender is the person: yes" that Foundry did not write itself answers.
func pendingChannelPersonMessage(origin *store.MessageChannelOrigin) bool {
	if origin == nil {
		return true
	}
	for _, message := range origin.Messages {
		if message.Sender.IsSelf && !message.Sender.IsOwnWrite {
			return true
		}
	}
	return false
}

// answerTextOf is the answer a message delivers: the answers in a question's
// reply envelope (what the answer card and an assistant's answer send), or the
// message itself.
func answerTextOf(message string) string {
	text := strings.TrimSpace(message)
	open := strings.Index(text, agentQuestionReplyOpen)
	if open < 0 {
		return text
	}
	body := text[open+len(agentQuestionReplyOpen):]
	if end := strings.Index(body, agentQuestionReplyClose); end >= 0 {
		body = body[:end]
	}
	var entries []struct {
		Answer string `json:"answer"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(body)), &entries); err != nil {
		return text
	}
	answers := make([]string, 0, len(entries))
	for _, entry := range entries {
		if answer := strings.TrimSpace(entry.Answer); answer != "" {
			answers = append(answers, answer)
		}
	}
	return strings.Join(answers, "\n")
}

// itemAnswer is the answer an answer envelope gives one question item.
type itemAnswer struct {
	itemID string
	text   string
}

// answersByItem is what each question item an answer envelope names is
// answered with: its entries' answers, in order. named is false for a message
// without a reply envelope (a plain steer), which answers the session's items.
func answersByItem(message string) (answers []itemAnswer, named bool) {
	text := strings.TrimSpace(message)
	open := strings.Index(text, agentQuestionReplyOpen)
	if open < 0 {
		return nil, false
	}
	body := text[open+len(agentQuestionReplyOpen):]
	if end := strings.Index(body, agentQuestionReplyClose); end >= 0 {
		body = body[:end]
	}
	var entries []struct {
		QuestionItemID string `json:"questionItemId"`
		Answer         string `json:"answer"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(body)), &entries); err != nil {
		return nil, false
	}
	byItem := map[string][]string{}
	var order []string
	for _, entry := range entries {
		itemID := replyItemID(entry.QuestionItemID)
		answer := strings.TrimSpace(entry.Answer)
		if itemID == "" || answer == "" {
			continue
		}
		if _, seen := byItem[itemID]; !seen {
			order = append(order, itemID)
		}
		byItem[itemID] = append(byItem[itemID], answer)
	}
	for _, itemID := range order {
		answers = append(answers, itemAnswer{itemID: itemID, text: strings.Join(byItem[itemID], "\n")})
	}
	return answers, true
}

// replyItemID is the runtime's question item an envelope entry names: the second
// element of its questionItemId array, ["request_user_input_async", "<call id>", <index>].
func replyItemID(questionItemID string) string {
	var target []any
	if json.Unmarshal([]byte(questionItemID), &target) != nil || len(target) < 2 {
		return ""
	}
	itemID, _ := target[1].(string)
	return itemID
}

// pendingAnswerable are the sources an answer to a session settles.
var pendingAnswerable = []string{store.PendingSourceQuestion, store.PendingSourceTurnFailed, store.PendingSourceNeedsHands, store.PendingSourceHelperStuck}

// pendingSettledByNextMessage are the sources the person's next plain message
// in an assistant's conversation settles: everything answerable but its questions.
var pendingSettledByNextMessage = []string{store.PendingSourceTurnFailed, store.PendingSourceNeedsHands, store.PendingSourceHelperStuck}

// pendingChat is a chat the person started and holds: not a session another
// session started (orchestration, scheduled work), which reports to it.
func pendingChat(session store.AgentSession) bool {
	return session.CreatedByUserID != "" && session.Role == "" && session.ParentSessionID == "" &&
		(session.Source == "" || session.Source == store.SessionSourceChat) && session.ArchivedAt == ""
}

func (r pendingReactions) SessionEventRecorded(ctx context.Context, event store.AgentSessionEvent) {
	if event.Label == store.EventLabelSteeredIntoTurn {
		if event.Metadata != nil && isAssistantQuestionAnswer(event.Metadata.InputSource) {
			return
		}
		// The person (or a helper's assistant) steered a running turn: what
		// it showed before is answered.
		session, kept := r.s.pendingSession(ctx, event.SessionID)
		sender := ""
		if event.Metadata != nil {
			sender = event.Metadata.SentBySessionID
		}
		if kept && pendingAnswers(session, sender) {
			r.answeredBy(ctx, session, sender, event.At, event.Detail)
		}
		return
	}
	if !pendingCandidateEvent(event) {
		return
	}
	session, kept := r.s.pendingSession(ctx, event.SessionID)
	if !kept {
		return
	}
	responsible := r.s.assistant.ResponsibleFor(ctx, session)
	handler, assistantID := responsible.Handler()
	holdsTurn := responsible.Party == assistant.ResponsiblePerson
	for _, item := range pendingItemsFromEvent(event, holdsTurn) {
		item.UserID, item.WorkspaceID, item.SessionID = session.CreatedByUserID, session.WorkspaceID, session.ID
		item.Handler, item.AssistantID = handler, assistantID
		if _, _, err := r.s.recordPendingItem(ctx, item); err != nil {
			log.Printf("record pending item of %s: %v", event.ID, err)
		}
	}
}

func (r pendingReactions) SessionChanged(ctx context.Context, change sessions.Change, session store.AgentSession) {
	if !r.s.pendingKept(ctx, session) {
		return
	}
	switch change {
	case sessions.Queued:
		// A new message from the person (a helper's: also from the assistant
		// that started it; never a timer) answers what it showed before. A
		// channel turn only counts when it carries the person's own words:
		// an echo of the assistant's write, or another person's message,
		// answers nothing.
		input := session.Input
		if input.ID == "" || !pendingAnswers(session, input.SentBySessionID) || input.TimerFire != nil ||
			!pendingChannelPersonMessage(input.ChannelOrigin) || isAssistantQuestionAnswer(input.InputSource) {
			return
		}
		before := input.At
		if before == "" {
			before = formatPendingTime(time.Now())
		}
		r.answeredBy(ctx, session, input.SentBySessionID, before, input.Prompt)
	case sessions.Completed:
		// A stuck helper's turn ended, however; a stopped session waits for
		// nothing.
		r.resolve(ctx, store.PendingResolution{SessionID: session.ID, State: store.PendingSuperseded, Sources: []string{store.PendingSourceHelperStuck}})
		if session.Status == "canceled" {
			r.resolve(ctx, store.PendingResolution{SessionID: session.ID, State: store.PendingSuperseded})
			return
		}
		// A question that held the turn stays open after its turn ends: the
		// person may answer it later, and the answer is the chat's next
		// message. Their next message in the chat closes it.
		// A turn that completed makes an earlier failure moot.
		if session.Status == "completed" {
			r.closePreviousTurnFailures(ctx, session)
		}
	}
}

// answeredBy settles what a message to session answers, sent at at by
// sender (the person, or the assistant that started a helper). A reply
// envelope (a question card's answer) answers the items it names, each with
// its own answers; the other open items stay open. A plain message answers
// the session's open items, except the questions of an assistant's own
// conversation: there the person hands over one unrelated thing after
// another, and whether a message answers a question is the assistant's
// judgement, not Foundry's. Those close on their card's answer or when the
// assistant withdraws them (needs_you resolve).
func (r pendingReactions) answeredBy(ctx context.Context, session store.AgentSession, sender, at, message string) {
	outcome, by := store.PendingOutcomePersonAnswered, store.PendingAnsweredByPerson
	acknowledgedAt := ""
	if session.ParentSessionID != "" && sender == session.ParentSessionID {
		outcome, by, acknowledgedAt = store.PendingOutcomeAssistantAnswered, store.PendingAnsweredByAssistant, at
	}
	resolution := store.PendingResolution{
		SessionID: session.ID, Before: at, State: store.PendingReplied,
		Sources: pendingAnswerable, Outcome: outcome, AcknowledgedAt: acknowledgedAt,
	}
	if answers, named := answersByItem(message); named {
		for _, answer := range answers {
			resolution.MessageID = answer.itemID
			resolution.Answer = store.PendingAnswer{Text: answer.text, By: by}
			r.resolve(ctx, resolution)
		}
		return
	}
	if _, conversation := r.s.assistant.Conversation(ctx, session); conversation {
		resolution.Sources = pendingSettledByNextMessage
	}
	resolution.Answer = store.PendingAnswer{Text: answerTextOf(message), By: by}
	r.resolve(ctx, resolution)
}

// observeQuestionSettled closes the item of a question or approval its worker
// reports settled without an answer (timed out, declined, interrupted, its
// process ended). A question that held the person's own chat is kept open: the
// runtime stopped waiting, the person did not, and their later answer reaches
// the chat as its next message. It reports whether the event was that report,
// a receipt that is not transcript.
func (s *Server) observeQuestionSettled(ctx context.Context, event store.AgentSessionEvent) bool {
	if event.Label != store.EventLabelQuestionSettled {
		return false
	}
	messageID := strings.TrimSpace(event.Detail)
	if messageID == "" {
		return true
	}
	session, kept := s.pendingSession(ctx, event.SessionID)
	if !kept || s.assistant.ResponsibleFor(ctx, session).Party == assistant.ResponsiblePerson {
		return true
	}
	pendingReactions{s}.resolve(ctx, store.PendingResolution{SessionID: event.SessionID, MessageID: messageID, State: store.PendingSuperseded, Sources: []string{store.PendingSourceQuestion}})
	return true
}

func (r pendingReactions) IssueUpdated(issue store.Issue) {
	if issue.CreatedByUserID == "" {
		return
	}
	ctx := context.Background()
	if question := issue.Question; question != nil && !pendingIssueClosed(issue.Status) {
		key := "issue:" + issue.ID + ":" + question.ID
		item := store.PendingItem{
			UserID: issue.CreatedByUserID, WorkspaceID: issue.WorkspaceID, SessionID: question.RunID, IssueID: issue.ID,
			EventID: question.ID, Source: store.PendingSourceIssueQuestion, Rule: question.Kind, Key: key,
			Title: pendingTitle(issue.Title), Excerpt: textcut.Excerpt(question.Text, pendingExcerptLimit),
			Options: question.Options, Recommendation: pendingRecommendation(question.Options),
		}
		if _, _, err := r.s.store.RecordPendingItem(ctx, item); err != nil {
			log.Printf("record pending question of %s: %v", issue.ID, err)
		}
		r.resolve(ctx, store.PendingResolution{IssueID: issue.ID, ExceptKey: key, State: store.PendingSuperseded})
		return
	}
	outcome := store.PendingOutcomePersonAnswered
	if pendingIssueClosed(issue.Status) {
		outcome = store.PendingOutcomeAutoResolved
	}
	r.resolve(ctx, store.PendingResolution{IssueID: issue.ID, State: store.PendingSuperseded, Outcome: outcome})
}

func (r pendingReactions) resolve(ctx context.Context, resolution store.PendingResolution) {
	if _, err := r.s.store.ResolvePendingItems(ctx, resolution); err != nil {
		log.Printf("resolve pending items: %v", err)
	}
}

func pendingIssueClosed(status string) bool {
	switch status {
	case "done", "closed", "canceled", "cancelled", "accepted", "rejected":
		return true
	}
	return false
}

// pendingCandidateEvent is a cheap test before anything is read: only
// these events can hold an item. A tool's output is never scanned for one.
func pendingCandidateEvent(event store.AgentSessionEvent) bool {
	if event.Message != nil && len(event.Message.Questions) > 0 {
		return true
	}
	return event.Label == store.ProcessLabelPermissionDenied
}

// pendingItemsFromEvent is what an event holds for the person, without the
// person and session it belongs to. holdsTurn says the question waits in the
// person's own chat: only then is it held by its turn. A question a helper
// raised waits for its responsible party's answer, not the turn.
func pendingItemsFromEvent(event store.AgentSessionEvent, holdsTurn bool) []store.PendingItem {
	message := event.Message
	if message != nil && len(message.Questions) > 0 {
		items := make([]store.PendingItem, 0, len(message.Questions))
		answer := pendingAnswerContext(message.Text)
		for index, question := range message.Questions {
			title := strings.TrimSpace(question.Title)
			if title == "" {
				continue
			}
			rule := ""
			if holdsTurn && message.Delivery == "" {
				rule = store.PendingRuleHeld
			}
			items = append(items, store.PendingItem{
				EventID: event.ID, MessageID: message.ID, Source: store.PendingSourceQuestion, Rule: rule,
				Key:   "question:" + event.SessionID + ":" + message.ID + ":" + strconv.Itoa(index),
				Title: pendingTitle(title), Excerpt: textcut.Excerpt(title, pendingExcerptLimit), Context: answer,
				Options: question.Options, Recommendation: pendingRecommendation(question.Options), Approval: question.Approval,
				Detail: approvalDetail(question),
			})
		}
		return items
	}
	// A permission its runtime refused is a structured fact (the native
	// permission_denied event); a tool's output is never read for one.
	if event.Label == store.ProcessLabelPermissionDenied {
		detail := strings.TrimSpace(event.Detail)
		if detail == "" {
			return nil
		}
		return []store.PendingItem{{
			EventID: event.ID, Source: store.PendingSourceNeedsHands, Rule: "permission", Key: "hands:" + event.SessionID + ":permission",
			Title: pendingTitle(firstLine(detail)), Excerpt: textcut.Excerpt(detail, pendingExcerptLimit),
		}}
	}
	return nil
}

// approvalDetail is what an approval asks about (its command, or the changes),
// kept on the item so the list shows it after the prompt is gone.
func approvalDetail(question store.AgentQuestion) string {
	if !question.Approval {
		return ""
	}
	return textcut.Excerpt(strings.TrimSpace(question.Detail), pendingContextLimit)
}

// pendingAnswerContext is the end of the answer that asked: the paragraphs
// right before its questions, cut at a paragraph boundary.
func pendingAnswerContext(text string) string {
	text = strings.TrimSpace(text)
	if len(text) <= pendingContextLimit {
		return text
	}
	tail := text[len(text)-pendingContextLimit:]
	if cut := strings.Index(tail, "\n\n"); cut >= 0 && cut < len(tail)-1 {
		tail = tail[cut+2:]
	}
	return strings.TrimSpace(tail)
}

// pendingRecommendation is the option its Agent marked recommended.
func pendingRecommendation(options []string) string {
	for _, option := range options {
		lower := strings.ToLower(option)
		if strings.Contains(lower, "(recommended)") || strings.Contains(option, "（推荐）") || strings.Contains(option, "(推荐)") {
			return option
		}
	}
	return ""
}

func pendingTitle(text string) string {
	return textcut.Excerpt(firstLine(text), pendingTitleLimit)
}

func firstLine(text string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
	return strings.TrimSpace(line)
}

func formatPendingTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

// pendingItemView is an item as the person reads it: with the title of its
// session and the name of its workspace.
type pendingItemView struct {
	store.PendingItem
	SessionTitle  string `json:"sessionTitle,omitempty"`
	WorkspaceName string `json:"workspaceName,omitempty"`
	AssistantName string `json:"assistantName,omitempty"`
	// MessageAt is when an unprocessed assistant message was sent: its inbox
	// entry's time, which the item (recorded later) does not carry (DEV-254).
	MessageAt string `json:"messageAt,omitempty"`
	// ItemID, ItemAssistantID and ItemText name the open item the entry is
	// stuck on (openItemsBySession), when its session works on one.
	ItemID          string `json:"itemId,omitempty"`
	ItemAssistantID string `json:"itemAssistantId,omitempty"`
	ItemText        string `json:"itemText,omitempty"`
	// ConversationAssistant is the assistant whose own conversation the
	// entry's session is: the page names that assistant, not the
	// conversation's title, which its first message gave it.
	ConversationAssistant *pendingAssistantView `json:"conversationAssistant,omitempty"`
	// Notice is what became of an open request's notice to the person: its
	// state, or why it has none. Absent for an item that never gets one.
	Notice *pendingNoticeView `json:"notice,omitempty"`
}

type pendingAssistantView struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	IsDefault bool   `json:"isDefault"`
}

type pendingItemList struct {
	Items []pendingItemView `json:"items"`
	// Assistants are all of the person's assistants, for the page's filter.
	Assistants []pendingAssistantView `json:"assistants"`
	// Open counts the open requests the person handles (waitsOnPerson);
	// BySession counts them per session. AssistantOpen counts those their
	// assistant handles, NoticeOpen the open notes the assistant told the
	// person, which ask for nothing and are not counted as requests.
	Open          int            `json:"open"`
	AssistantOpen int            `json:"assistantOpen"`
	NoticeOpen    int            `json:"noticeOpen"`
	BySession     map[string]int `json:"bySession"`
}

// handleListPendingItems lists the person's open items and those resolved
// in the last week, each with the open item it is stuck on. An item of a
// session since archived or deleted is left out.
func (s *Server) handleListPendingItems(w http.ResponseWriter, r *http.Request) {
	user := accountID(r)
	if user == "" {
		writeError(w, http.StatusForbidden, "pending items belong to a signed-in account")
		return
	}
	ctx := r.Context()
	assistants, err := s.store.ListAssistants(ctx, user)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list assistants for pending items")
		return
	}
	assistantNames := make(map[string]string, len(assistants))
	result := pendingItemList{
		Items:      []pendingItemView{},
		Assistants: make([]pendingAssistantView, 0, len(assistants)),
		BySession:  map[string]int{},
	}
	for _, assistant := range assistants {
		assistantNames[assistant.ID] = assistant.Name
		result.Assistants = append(result.Assistants, pendingAssistantView{
			ID: assistant.ID, Name: assistant.Name, IsDefault: assistant.IsDefault,
		})
	}
	since := formatPendingTime(time.Now().Add(-pendingResolvedWindow))
	states := []string{store.PendingOpen, store.PendingReplied, store.PendingSuperseded, store.PendingDone, store.PendingDismissed}
	// The same visible set the assistant's card counts: an item whose
	// conversation was archived or deleted is not shown here either, so the
	// card's count and "All" can never disagree.
	s.reconcileItemWaits(ctx, user)
	items, err := s.store.ListVisiblePendingItems(ctx, user, states, since, 300)
	if err == nil {
		changed := s.reconcilePersonalPending(ctx, user, items)
		if s.reconcileInboxPending(ctx, user, inboxOpenKeys(items)) {
			changed = true
		}
		if s.reconcileConnectorWritePending(ctx, user, connectorWriteOpenKeys(items)) {
			changed = true
		}
		if changed {
			items, err = s.store.ListVisiblePendingItems(ctx, user, states, since, 300)
		}
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list pending items")
		return
	}
	links, err := s.openItemsBySession(ctx, user)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read the items pending items are stuck on")
		return
	}
	sessions := map[string]*store.AgentSession{}
	conversations := map[string]*pendingAssistantView{}
	workspaces := map[string]string{}
	bot := s.cachedNoticeBot()
	for _, item := range items {
		view := pendingItemView{PendingItem: item, AssistantName: assistantNames[item.AssistantID]}
		if item.Source == store.PendingSourceAssistantInbox {
			view.MessageAt = s.inboxMessageAt(ctx, user, item)
		}
		if item.WaitItemID != "" {
			view.ItemID, view.ItemAssistantID, view.ItemText = item.WaitItemID, item.AssistantID, item.Context
		}
		if item.SessionID != "" {
			session, seen := sessions[item.SessionID]
			if !seen {
				if found, err := s.store.GetAgentSessionSummary(ctx, item.SessionID); err == nil {
					session = &found
				} else if !errors.Is(err, store.ErrNotFound) {
					writeError(w, http.StatusInternalServerError, "read pending item session")
					return
				}
				sessions[item.SessionID] = session
				if session != nil && s.assistant != nil {
					if agent, ok := s.assistant.Conversation(ctx, *session); ok {
						conversations[item.SessionID] = &pendingAssistantView{ID: agent.ID, Name: agent.Name, IsDefault: agent.IsDefault}
					}
				}
			}
			if session == nil || session.ArchivedAt != "" {
				continue
			}
			view.SessionTitle = session.Title
			view.ConversationAssistant = conversations[item.SessionID]
			if link, linked := links[item.SessionID]; linked {
				view.ItemID, view.ItemAssistantID, view.ItemText = link.ItemID, link.AssistantID, link.Text
			}
		}
		name, seen := workspaces[item.WorkspaceID]
		if !seen {
			if workspace, err := s.store.GetWorkspace(ctx, item.WorkspaceID); err == nil {
				name = workspace.Name
			}
			workspaces[item.WorkspaceID] = name
		}
		view.WorkspaceName = name
		switch {
		case item.State != store.PendingOpen:
		case store.PendingHandledBy(item) == store.PendingHandlerAssistant:
			result.AssistantOpen++
		case item.Source == store.PendingSourceNotice:
			result.NoticeOpen++
		default:
			result.Open++
			if item.SessionID != "" && item.Source != store.PendingSourceIssueQuestion {
				result.BySession[item.SessionID]++
			}
		}
		if view.Notice, err = s.noticeViewOf(ctx, item, bot); err != nil {
			writeError(w, http.StatusInternalServerError, "read pending item notice")
			return
		}
		result.Items = append(result.Items, view)
	}
	writeJSON(w, http.StatusOK, result)
}

// handleSetPendingItemState marks one of the person's items done or
// dismissed, or opens it again.
func (s *Server) handleSetPendingItemState(w http.ResponseWriter, r *http.Request) {
	var input struct {
		State string `json:"state"`
	}
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	user := accountID(r)
	if user == "" {
		writeError(w, http.StatusForbidden, "pending items belong to a signed-in account")
		return
	}
	ctx := r.Context()
	current, err := s.store.GetPendingItem(ctx, user, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "pending item not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read pending item")
		return
	}
	// An unprocessed assistant message is retried or dismissed, never
	// "done": its item may only close together with the message it stands
	// for (DEV-254).
	if current.Source == store.PendingSourceAssistantInbox {
		switch input.State {
		case store.PendingDismissed:
			if err := s.dismissInboxItem(ctx, user, current); err != nil {
				writeResult(w, nil, err)
				return
			}
		case store.PendingOpen, store.PendingDone:
			writeError(w, http.StatusConflict, "an unprocessed assistant message is retried or dismissed")
			return
		}
	}
	item, err := s.store.SetPendingItemState(ctx, user, current.ID, input.State)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "pending item not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, item)
}
