package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// Pending items (DEV-079) are what waits for the person in their sessions,
// found in what the sessions already record: questions an Agent asked, an
// Issue's question, a turn that failed, and tool errors only the person can
// clear. Nothing here asks an Agent anything or changes what it is told; no
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

// pendingKept reports whether items are kept for session.
func (s *Server) pendingKept(ctx context.Context, session store.AgentSession) bool {
	if pendingChat(session) {
		return true
	}
	if session.ArchivedAt != "" || session.IssueID != "" || session.Source != store.SessionSourceAgent {
		return false
	}
	_, helper := s.assistant.HelperOf(ctx, session)
	return helper
}

// pendingAnswers reports whether an input to session answers what it showed
// before: a message from the person, or, for a helper, from the assistant
// conversation that started it; never a timer.
func pendingAnswers(session store.AgentSession, sentBySessionID string) bool {
	return sentBySessionID == "" || (session.ParentSessionID != "" && sentBySessionID == session.ParentSessionID)
}

// pendingAnswerable are the sources an answer to a session settles.
var pendingAnswerable = []string{store.PendingSourceQuestion, store.PendingSourceTurnFailed, store.PendingSourceNeedsHands, store.PendingSourceHelperStuck}

// pendingChat is a chat the person started and holds: not a session another
// session started (orchestration, scheduled work), which reports to it.
func pendingChat(session store.AgentSession) bool {
	return session.CreatedByUserID != "" && session.Role == "" && session.ParentSessionID == "" &&
		(session.Source == "" || session.Source == store.SessionSourceChat) && session.ArchivedAt == ""
}

func (r pendingReactions) SessionEventRecorded(ctx context.Context, event store.AgentSessionEvent) {
	if event.Label == store.EventLabelSteeredIntoTurn {
		// The person (or a helper's assistant) steered a running turn: what
		// it showed before is answered.
		session, kept := r.s.pendingSession(ctx, event.SessionID)
		sender := ""
		if event.Metadata != nil {
			sender = event.Metadata.SentBySessionID
		}
		if kept && pendingAnswers(session, sender) {
			r.resolve(ctx, store.PendingResolution{SessionID: event.SessionID, Before: event.At, State: store.PendingReplied, Sources: pendingAnswerable})
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
	workspacePath := ""
	if workspace, err := r.s.store.GetWorkspace(ctx, session.WorkspaceID); err == nil {
		workspacePath = workspace.LocalPath
	}
	handler := r.s.assistant.Handler(ctx, session)
	for _, item := range pendingItemsFromEvent(event, workspacePath) {
		item.UserID, item.WorkspaceID, item.SessionID = session.CreatedByUserID, session.WorkspaceID, session.ID
		item.Handler = handler
		if _, _, err := r.s.store.RecordPendingItem(ctx, item); err != nil {
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
		// that started it; never a timer) answers what it showed before.
		input := session.Input
		if input.ID == "" || !pendingAnswers(session, input.SentBySessionID) || input.TimerFire != nil {
			return
		}
		before := input.At
		if before == "" {
			before = formatPendingTime(time.Now())
		}
		r.resolve(ctx, store.PendingResolution{SessionID: session.ID, Before: before, State: store.PendingReplied, Sources: pendingAnswerable})
	case sessions.Completed:
		// A stuck helper's turn ended, however; a stopped session waits for
		// nothing.
		r.resolve(ctx, store.PendingResolution{SessionID: session.ID, State: store.PendingSuperseded, Sources: []string{store.PendingSourceHelperStuck}})
		if session.Status == "canceled" {
			r.resolve(ctx, store.PendingResolution{SessionID: session.ID, State: store.PendingSuperseded})
			return
		}
		// A question that held the turn waits no more once the turn ended,
		// however: answered, timed out, declined or interrupted.
		r.resolve(ctx, store.PendingResolution{SessionID: session.ID, State: store.PendingSuperseded, Sources: []string{store.PendingSourceQuestion}, Rule: store.PendingRuleHeld})
		// A turn that completed makes an earlier failure moot.
		if session.Status == "completed" {
			r.resolve(ctx, store.PendingResolution{SessionID: session.ID, State: store.PendingSuperseded, Sources: []string{store.PendingSourceTurnFailed}})
		}
	}
}

// observeQuestionSettled closes the person's item of a question or approval
// its worker reports settled without their answer (timed out, declined,
// interrupted, its process ended). It reports whether the event was that
// report, a receipt that is not transcript.
func (s *Server) observeQuestionSettled(ctx context.Context, event store.AgentSessionEvent) bool {
	if event.Label != store.EventLabelQuestionSettled {
		return false
	}
	messageID := strings.TrimSpace(event.Detail)
	if messageID == "" {
		return true
	}
	if _, kept := s.pendingSession(ctx, event.SessionID); kept {
		pendingReactions{s}.resolve(ctx, store.PendingResolution{SessionID: event.SessionID, MessageID: messageID, State: store.PendingSuperseded, Sources: []string{store.PendingSourceQuestion}})
	}
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
	r.resolve(ctx, store.PendingResolution{IssueID: issue.ID, State: store.PendingSuperseded})
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
// these events can hold an item.
func pendingCandidateEvent(event store.AgentSessionEvent) bool {
	if event.Message != nil && len(event.Message.Questions) > 0 {
		return true
	}
	switch event.Label {
	case store.ProcessLabelSessionFailed:
		return event.Level == "error"
	case store.ProcessLabelPermissionDenied:
		return true
	}
	return event.Message != nil && event.Message.Kind == "tool" &&
		(event.Level == "error" || event.Message.Status == "failed")
}

// pendingItemsFromEvent is what an event holds for the person, without the
// person and session it belongs to.
func pendingItemsFromEvent(event store.AgentSessionEvent, workspacePath string) []store.PendingItem {
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
			if message.Delivery == "" {
				rule = store.PendingRuleHeld
			}
			items = append(items, store.PendingItem{
				EventID: event.ID, MessageID: message.ID, Source: store.PendingSourceQuestion, Rule: rule,
				Key:   "question:" + event.SessionID + ":" + message.ID + ":" + strconv.Itoa(index),
				Title: pendingTitle(title), Excerpt: textcut.Excerpt(title, pendingExcerptLimit), Context: answer,
				Options: question.Options, Recommendation: pendingRecommendation(question.Options),
			})
		}
		return items
	}
	switch event.Label {
	case store.ProcessLabelSessionFailed:
		detail := strings.TrimSpace(event.Detail)
		if detail == "" || strings.Contains(strings.ToLower(detail), "session was canceled") {
			return nil
		}
		return []store.PendingItem{{
			EventID: event.ID, Source: store.PendingSourceTurnFailed, Key: "failed:" + event.SessionID,
			Title: pendingTitle(firstLine(detail)), Excerpt: textcut.Excerpt(detail, pendingExcerptLimit),
		}}
	case store.ProcessLabelPermissionDenied:
		detail := strings.TrimSpace(event.Detail)
		if detail == "" {
			return nil
		}
		return []store.PendingItem{{
			EventID: event.ID, Source: store.PendingSourceNeedsHands, Rule: "permission", Key: "hands:" + event.SessionID + ":permission",
			Title: pendingTitle(firstLine(detail)), Excerpt: textcut.Excerpt(detail, pendingExcerptLimit),
		}}
	}
	if message == nil || message.Kind != "tool" {
		return nil
	}
	rule, line, excerpt := needsHands(toolOutput(message.Text), workspacePath)
	if rule == "" {
		return nil
	}
	// The command, without the output the excerpt already shows.
	command, _, _ := strings.Cut(message.Text, "\n```\n")
	command = strings.TrimSpace(command)
	if command == "" {
		command = strings.TrimSpace(event.Detail)
	}
	return []store.PendingItem{{
		EventID: event.ID, MessageID: message.ID, Source: store.PendingSourceNeedsHands, Rule: rule,
		Key:   "hands:" + event.SessionID + ":" + rule,
		Title: pendingTitle(line), Excerpt: textcut.Excerpt(excerpt, pendingExcerptLimit), Context: textcut.Excerpt(command, pendingContextLimit),
	}}
}

// toolOutput is what a tool printed: a tool event's text is its command,
// then its output in a fenced block. Only the output is matched, so a
// command or a file that merely mentions an error matches nothing.
func toolOutput(text string) string {
	_, output, found := strings.Cut(text, "\n```\n")
	if !found {
		return ""
	}
	output = strings.TrimSuffix(strings.TrimSpace(output), "```")
	// Errors that stop a command print last.
	if len(output) > 4000 {
		output = output[len(output)-4000:]
	}
	return output
}

// needsHandsRules are the tool errors only the person can clear, matched
// line by line in a tool's output. They are deliberately narrow: an error
// an Agent can work around itself (a 404, a failing test, a file in its own
// workspace) is not the person's.
var needsHandsRules = []struct {
	rule    string
	pattern *regexp.Regexp
}{
	{"sudo", regexp.MustCompile(`(?i)^sudo: (a password is required|a terminal is required|no tty present)`)},
	// A GitHub scope the device's gh login lacks (DEV-136): Foundry's own
	// session gh refusing a login change, gh's missing-scope error, and
	// git refusing a workflow file. The person adds it in Connectors.
	{"github_scope", regexp.MustCompile("(?i)(^gh auth \\S+ is not available in a Foundry session|missing required scopes? \\[[^\\]]+\\]|without `workflow` scope)")},
	{"gateway", regexp.MustCompile(`Foundry gateway:`)},
	{"docker", regexp.MustCompile(`(?i)permission denied while trying to connect to the docker daemon socket`)},
	{"login", regexp.MustCompile(`(?i)("error"\s*:\s*"(token_expired|invalid_grant)"|refresh token (has )?expired|(login|session|authorization|credentials?) (has )?expired|re-?authori[sz]e (it )?in (foundry|connectors))`)},
	{"http_auth", regexp.MustCompile(`(?i)^(HTTP/[0-9.]+ (401|403)\b|.*\b(HTTP Error|status(Code)?)[ :=]*(401|403)\b.*(unauthori[sz]ed|forbidden))`)},
}

// permissionDenied finds a path a process may not open: Node's EACCES,
// Python's PermissionError and coreutils ("cat: /path: Permission denied")
// name it.
var permissionDenied = regexp.MustCompile(`(?:EACCES: permission denied, \w+ |\[Errno 13\] Permission denied: )'([^']+)'|^[\w.-]+: (?:cannot [a-z ]+? )?'?(/[^':]+)'?: Permission denied$`)

// needsHands returns the rule a tool's output matched, the line that
// matched and the lines around it, or "" when none did.
func needsHands(output, workspacePath string) (string, string, string) {
	if output == "" {
		return "", "", ""
	}
	lines := strings.Split(output, "\n")
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		for _, candidate := range needsHandsRules {
			if !candidate.pattern.MatchString(trimmed) {
				continue
			}
			if candidate.rule == "http_auth" && pendingLocalRequest(output) {
				continue
			}
			return candidate.rule, trimmed, surroundingLines(lines, index)
		}
		if match := permissionDenied.FindStringSubmatch(trimmed); match != nil && pendingOutsideWorkspace(match[1]+match[2], workspacePath) {
			return "permission", trimmed, surroundingLines(lines, index)
		}
	}
	return "", "", ""
}

// pendingLocalRequest is output of a request to this machine: a service the
// Agent runs or tests answers 401 on purpose.
func pendingLocalRequest(output string) bool {
	lower := strings.ToLower(output)
	return strings.Contains(lower, "localhost") || strings.Contains(lower, "127.0.0.1") || strings.Contains(lower, "0.0.0.0")
}

// pendingOutsideWorkspace is a path outside the session's workspace: one
// inside it, or a relative one, is the Agent's own to fix.
func pendingOutsideWorkspace(path, workspacePath string) bool {
	if !filepath.IsAbs(path) {
		return false
	}
	if workspacePath == "" {
		return true
	}
	relative, err := filepath.Rel(filepath.Clean(workspacePath), filepath.Clean(path))
	return err != nil || relative == ".." || strings.HasPrefix(relative, "../")
}

func surroundingLines(lines []string, index int) string {
	start, end := max(0, index-2), min(len(lines), index+3)
	return strings.TrimSpace(strings.Join(lines[start:end], "\n"))
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
	// DeviceID is the session's device: a github_scope item links to that
	// device's GitHub permissions (DEV-136).
	DeviceID string `json:"deviceId,omitempty"`
}

type pendingItemList struct {
	Items []pendingItemView `json:"items"`
	// Open counts the open items the person handles; BySession counts them
	// per session. AssistantOpen counts those their assistant handles.
	Open          int            `json:"open"`
	AssistantOpen int            `json:"assistantOpen"`
	BySession     map[string]int `json:"bySession"`
}

// handleListPendingItems lists the person's open items and those resolved
// in the last week. An item of a session since archived or deleted is left
// out.
func (s *Server) handleListPendingItems(w http.ResponseWriter, r *http.Request) {
	user := accountID(r)
	if user == "" {
		writeError(w, http.StatusForbidden, "pending items belong to a signed-in account")
		return
	}
	ctx := r.Context()
	since := formatPendingTime(time.Now().Add(-pendingResolvedWindow))
	states := []string{store.PendingOpen, store.PendingReplied, store.PendingSuperseded, store.PendingDone, store.PendingDismissed}
	items, err := s.store.ListPendingItems(ctx, user, states, since, 300)
	if err == nil && (s.reconcilePersonalPending(ctx, user, items) || s.handOverWhileAway(ctx, user, items)) {
		items, err = s.store.ListPendingItems(ctx, user, states, since, 300)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list pending items")
		return
	}
	sessions := map[string]*store.AgentSession{}
	workspaces := map[string]string{}
	result := pendingItemList{Items: []pendingItemView{}, BySession: map[string]int{}}
	for _, item := range items {
		view := pendingItemView{PendingItem: item}
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
			}
			if session == nil || session.ArchivedAt != "" {
				continue
			}
			view.SessionTitle = session.Title
			view.DeviceID = session.DeviceID
		}
		name, seen := workspaces[item.WorkspaceID]
		if !seen {
			if workspace, err := s.store.GetWorkspace(ctx, item.WorkspaceID); err == nil {
				name = workspace.Name
			}
			workspaces[item.WorkspaceID] = name
		}
		view.WorkspaceName = name
		if item.State == store.PendingOpen && store.PendingHandledBy(item) == store.PendingHandlerAssistant {
			result.AssistantOpen++
		} else if item.State == store.PendingOpen {
			result.Open++
			if item.SessionID != "" && item.Source != store.PendingSourceIssueQuestion {
				result.BySession[item.SessionID]++
			}
		}
		result.Items = append(result.Items, view)
	}
	writeJSON(w, http.StatusOK, result)
}

// handOverWhileAway hands the person the open items their assistant
// handles while it cannot take them (stopped, or its home computer
// offline): the person sees them at once, and they stay the person's until
// either side resolves them (§h). It reports whether it handed any.
func (s *Server) handOverWhileAway(ctx context.Context, user string, items []store.PendingItem) bool {
	if !slices.ContainsFunc(items, func(item store.PendingItem) bool {
		return item.State == store.PendingOpen && store.PendingHandledBy(item) == store.PendingHandlerAssistant
	}) {
		return false
	}
	agent, err := s.store.GetPersonalAgent(ctx, user)
	if err == nil && s.assistant.Takes(agent) {
		return false
	}
	reason := store.PendingHandedOffline
	if err != nil || agent.State != store.PersonalAgentActive {
		reason = store.PendingHandedStopped
	}
	return s.assistant.HandOverAll(ctx, user, reason) > 0
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
	item, err := s.store.SetPendingItemState(r.Context(), user, r.PathValue("id"), input.State)
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
