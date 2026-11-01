package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
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
// are kept for it: a chat the person started. Issue executions report
// through their Issue; utility, verification and Agent-started sessions
// answer to whoever started them.
func (s *Server) pendingSession(ctx context.Context, sessionID string) (store.AgentSession, bool) {
	session, err := s.store.GetAgentSessionSummary(ctx, sessionID)
	if err != nil {
		return store.AgentSession{}, false
	}
	return session, pendingChat(session)
}

func pendingChat(session store.AgentSession) bool {
	return session.CreatedByUserID != "" && session.Role == "" &&
		(session.Source == "" || session.Source == "chat") && session.ArchivedAt == ""
}

func (r pendingReactions) sessionEventRecorded(ctx context.Context, event store.AgentSessionEvent) {
	if event.Label == steeredIntoTurnLabel {
		// The person steered a running turn: what they saw before is answered.
		if event.Metadata != nil && event.Metadata.SentBySessionID != "" {
			return
		}
		if _, kept := r.s.pendingSession(ctx, event.SessionID); kept {
			r.resolve(ctx, store.PendingResolution{SessionID: event.SessionID, Before: event.At, State: store.PendingReplied, Sources: []string{store.PendingSourceQuestion, store.PendingSourceTurnFailed, store.PendingSourceNeedsHands}})
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
	for _, item := range pendingItemsFromEvent(event, workspacePath) {
		item.UserID, item.WorkspaceID, item.SessionID = session.CreatedByUserID, session.WorkspaceID, session.ID
		if _, _, err := r.s.store.RecordPendingItem(ctx, item); err != nil {
			log.Printf("record pending item of %s: %v", event.ID, err)
		}
	}
}

func (r pendingReactions) sessionChanged(ctx context.Context, change sessionChange, session store.AgentSession) {
	if !pendingChat(session) {
		return
	}
	switch change {
	case sessionQueued:
		// A new message from the person (not a timer, not another session)
		// answers what the chat showed before it.
		input := session.Input
		if input.ID == "" || input.SentBySessionID != "" || input.TimerFire != nil {
			return
		}
		before := input.At
		if before == "" {
			before = formatPendingTime(time.Now())
		}
		r.resolve(ctx, store.PendingResolution{SessionID: session.ID, Before: before, State: store.PendingReplied, Sources: []string{store.PendingSourceQuestion, store.PendingSourceTurnFailed, store.PendingSourceNeedsHands}})
	case sessionCompleted:
		// A turn that completed makes an earlier failure moot.
		if session.Status == "completed" {
			r.resolve(ctx, store.PendingResolution{SessionID: session.ID, State: store.PendingSuperseded, Sources: []string{store.PendingSourceTurnFailed}})
		}
	}
}

func (r pendingReactions) issueUpdated(issue store.Issue) {
	if issue.CreatedByUserID == "" {
		return
	}
	ctx := context.Background()
	if question := issue.Question; question != nil && !pendingIssueClosed(issue.Status) {
		key := "issue:" + issue.ID + ":" + question.ID
		item := store.PendingItem{
			UserID: issue.CreatedByUserID, WorkspaceID: issue.WorkspaceID, SessionID: question.RunID, IssueID: issue.ID,
			EventID: question.ID, Source: store.PendingSourceIssueQuestion, Rule: question.Kind, Key: key,
			Title: pendingTitle(issue.Title), Excerpt: clip(question.Text, pendingExcerptLimit),
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
	case "Session failed":
		return event.Level == "error"
	case "Permission denied":
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
			items = append(items, store.PendingItem{
				EventID: event.ID, MessageID: message.ID, Source: store.PendingSourceQuestion,
				Key:   "question:" + event.SessionID + ":" + message.ID + ":" + strconv.Itoa(index),
				Title: pendingTitle(title), Excerpt: clip(title, pendingExcerptLimit), Context: answer,
				Options: question.Options, Recommendation: pendingRecommendation(question.Options),
			})
		}
		return items
	}
	switch event.Label {
	case "Session failed":
		detail := strings.TrimSpace(event.Detail)
		if detail == "" || strings.Contains(strings.ToLower(detail), "session was canceled") {
			return nil
		}
		return []store.PendingItem{{
			EventID: event.ID, Source: store.PendingSourceTurnFailed, Key: "failed:" + event.SessionID,
			Title: pendingTitle(firstLine(detail)), Excerpt: clip(detail, pendingExcerptLimit),
		}}
	case "Permission denied":
		detail := strings.TrimSpace(event.Detail)
		if detail == "" {
			return nil
		}
		return []store.PendingItem{{
			EventID: event.ID, Source: store.PendingSourceNeedsHands, Rule: "permission", Key: "hands:" + event.SessionID + ":permission",
			Title: pendingTitle(firstLine(detail)), Excerpt: clip(detail, pendingExcerptLimit),
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
		Title: pendingTitle(line), Excerpt: clip(excerpt, pendingExcerptLimit), Context: clip(command, pendingContextLimit),
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
	return clip(strings.TrimSpace(firstLine(text)), pendingTitleLimit)
}

func firstLine(text string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
	return strings.TrimSpace(line)
}

// clip cuts text to at most limit bytes on a rune boundary.
func clip(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && (text[cut]&0xC0) == 0x80 {
		cut--
	}
	return strings.TrimSpace(text[:cut]) + "…"
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
}

type pendingItemList struct {
	Items []pendingItemView `json:"items"`
	// Open counts the open items; BySession counts them per session.
	Open      int            `json:"open"`
	BySession map[string]int `json:"bySession"`
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
	items, err := s.store.ListPendingItems(ctx, user, []string{store.PendingOpen, store.PendingReplied, store.PendingSuperseded, store.PendingDone, store.PendingDismissed}, since, 300)
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
		}
		name, seen := workspaces[item.WorkspaceID]
		if !seen {
			if workspace, err := s.store.GetWorkspace(ctx, item.WorkspaceID); err == nil {
				name = workspace.Name
			}
			workspaces[item.WorkspaceID] = name
		}
		view.WorkspaceName = name
		if item.State == store.PendingOpen {
			result.Open++
			if item.SessionID != "" && item.Source != store.PendingSourceIssueQuestion {
				result.BySession[item.SessionID]++
			}
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
