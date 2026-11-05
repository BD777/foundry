package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/sessions"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Triage (DEV-125) reads the answer a person's chat ended a turn with for
// what it asks of them, on the model the person chose for it (their
// triage settings), and keeps those requests as pending items. It
// runs once the chat has been idle a moment, in a prompt-only utility
// session on the person's chosen device; nothing is asked of the chat's
// agent. A request it reports must quote the answer word for word.

// defaultTriageDelay is how long a chat stays idle after a turn before its
// answer is read: a chat that goes on at once is read when it stops.
const defaultTriageDelay = 20 * time.Second

// triageMinAnswer is the shortest answer worth reading, in characters.
const triageMinAnswer = 40

type triageScheduler struct {
	mu     sync.Mutex
	timers map[string]*time.Timer
}

// scheduleTriage reads the session's answer after the delay, unless the
// person writes first or the session goes on (the next answer is read then).
func (s *Server) scheduleTriage(sessionID string) {
	t := &s.triage
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.timers == nil {
		t.timers = map[string]*time.Timer{}
	}
	if timer := t.timers[sessionID]; timer != nil {
		timer.Stop()
	}
	delay := s.triageDelay
	if delay <= 0 {
		delay = defaultTriageDelay
	}
	t.timers[sessionID] = time.AfterFunc(delay, func() {
		t.mu.Lock()
		delete(t.timers, sessionID)
		t.mu.Unlock()
		s.hub.work.Go(func() {
			if err := s.startTriage(s.hub.work.ctx, sessionID); err != nil {
				log.Printf("triage of %s: %v", sessionID, err)
			}
		})
	})
}

func (s *Server) cancelTriage(sessionID string) {
	t := &s.triage
	t.mu.Lock()
	defer t.mu.Unlock()
	if timer := t.timers[sessionID]; timer != nil {
		timer.Stop()
		delete(t.timers, sessionID)
	}
}

// triageHeader names, in the triage's own prompt, what it reads: the chat,
// the message the answer is, and the answer's revision. Completion reads it
// back, so it holds across restarts.
var triageHeader = regexp.MustCompile(`^\[foundry-triage chat=(\S+) message=(\S*) revision=(\S*)\]`)

var triageAnswer = regexp.MustCompile(`(?s)<answer>\n(.*)\n</answer>`)

// startTriage reads the chat's latest answer if it still ends the chat,
// on the model the person chose (off until chosen), on their device.
func (s *Server) startTriage(ctx context.Context, sessionID string) error {
	session, err := s.store.GetAgentSession(ctx, sessionID)
	if err != nil {
		return err
	}
	answer := strings.TrimSpace(session.Response)
	if !pendingChat(session) || session.Status != "completed" || utf8.RuneCountInString(answer) < triageMinAnswer {
		return nil
	}
	settings, err := s.store.PendingTriageSettings(ctx, session.CreatedByUserID)
	if err != nil || !settings.Enabled || !s.hub.HasConnection(settings.DeviceID) {
		return err
	}
	workspaceID, err := s.triageWorkspace(ctx, session, settings.DeviceID)
	if err != nil || workspaceID == "" {
		return err
	}
	open, err := s.store.ListPendingItems(ctx, session.CreatedByUserID, []string{store.PendingOpen}, "", 300)
	if err != nil {
		return err
	}
	var chatOpen []store.PendingItem
	for _, item := range open {
		if item.SessionID == session.ID && (item.Source == store.PendingSourceAnswer || item.Source == store.PendingSourceQuestion) {
			chatOpen = append(chatOpen, item)
		}
	}
	personSaid := ""
	if session.Input.SentBySessionID == "" && session.Input.TimerFire == nil {
		personSaid = strings.TrimSpace(session.Input.Prompt)
	}
	messageID := triageMessageID(session)
	input := store.CreateAgentSessionInput{
		CreatedByUserID: session.CreatedByUserID, WorkspaceID: workspaceID, Source: store.SessionSourceTriage,
		Provider: settings.Runtime, ProfileID: settings.ProfileID, Model: settings.Model,
		Prompt:           triagePrompt(session.ID, messageID, session.AnswerRevision, answer, personSaid, chatOpen),
		InputID:          store.WorkRunInputID(session.ID, "triage:"+session.AnswerRevision+":"+messageID),
		Title:            "Triage: " + session.Title,
		CodexSandboxMode: "read-only", CodexApprovalPolicy: "never", ClaudePermissionMode: "dontAsk",
	}
	if settings.Runtime == "codex" {
		input.CodexReasoningEffort = settings.Effort
	} else {
		input.ClaudeEffort = settings.Effort
	}
	if err := s.sessionService.ResolveDevice(ctx, &input); err != nil {
		return err
	}
	_, err = s.sessionService.CreateAndDispatch(ctx, input, sessions.StartOptions{FailOffline: true, Resume: true})
	return err
}

// triageWorkspace is where a triage runs on the chosen device: the chat's
// own workspace when it is there, else one of the person's workspaces there.
// A triage reads only its prompt, so the workspace is only its place.
func (s *Server) triageWorkspace(ctx context.Context, chat store.AgentSession, deviceID string) (string, error) {
	workspaces, err := s.store.ListWorkspaces(ctx)
	if err != nil {
		return "", err
	}
	roles, err := s.store.WorkspaceRolesForUser(ctx, chat.CreatedByUserID)
	if err != nil {
		return "", err
	}
	chosen := ""
	for _, workspace := range workspaces {
		if workspace.DeviceID != deviceID || workspace.ArchivedAt != "" || !store.WorkspaceRoleAtLeast(roles[workspace.ID], store.WorkspaceRoleMember) {
			continue
		}
		if workspace.ID == chat.WorkspaceID {
			return workspace.ID, nil
		}
		if chosen == "" || workspace.ID < chosen {
			chosen = workspace.ID
		}
	}
	return chosen, nil
}

// triageMessageID is the transcript message the answer is, for the link an
// item opens: the last answer the session recorded.
func triageMessageID(session store.AgentSession) string {
	// As the transcript names the answer: its message's id, or, for an
	// answer streamed without one (Claude), its event's.
	for index := len(session.Events) - 1; index >= 0; index-- {
		event := session.Events[index]
		if event.Metadata != nil && event.Metadata.TaskID != "" {
			continue
		}
		if event.Message != nil {
			if event.Message.Kind == "assistant" && event.Message.ID != "" && len(event.Message.Questions) == 0 {
				return event.Message.ID
			}
			continue
		}
		if event.Label == store.EventLabelResponseStream && event.ID != "" {
			return event.ID
		}
	}
	return ""
}

func triagePrompt(chatID, messageID, revision, answer, personSaid string, open []store.PendingItem) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[foundry-triage chat=%s message=%s revision=%s]\n\n", chatID, messageID, revision)
	b.WriteString(`You read one answer an AI agent gave to its person. List what the answer asks the PERSON to do: a decision to make, an action only they can take (sign in, approve, grant access, review or accept something, run something on their side), or information to provide.

Rules:
- Only requests addressed to the person. Not what the agent will do itself, not status or results, not rhetorical questions, not questions the agent answers itself, not instructions the agent reports it gave to other sessions.
- A direct question waiting for the person's yes or no ("Shall I set it up?", "要不要我配上？") is kind "decision". A mere mention of something optional ("if you need X, I can…", "需要的话说一声") is kind "offer".
- Steps the person is to follow to accept or verify a delivery are one item, kind "action", quoting their heading or first step.
- An instruction to hold off ("don't do X yet", "先别…") is not an item.
- One item per separate request: a numbered list of decisions is several items.
- quote: the exact words from the answer that ask it (one sentence or one list item, copied verbatim, at most 300 characters).
- question: the request in one short sentence, in the answer's language.
- options: the choices the answer offers for it, if any. recommendation: the option the agent recommends, if it says.
- same: if the request is one of the open requests listed below, its id.
- closes: ids of open requests listed below that the person's message answered or that the answer shows are settled.
`)
	if len(open) > 0 {
		b.WriteString("\nOpen requests in this chat:\n")
		for _, item := range open {
			fmt.Fprintf(&b, "- %s: %s\n", item.ID, firstLine(item.Title))
		}
	}
	if personSaid != "" {
		fmt.Fprintf(&b, "\nThe person's message this answer replies to:\n<message>\n%s\n</message>\n", truncateRunes(personSaid, 4000))
	}
	b.WriteString(`
Answer with JSON only, no other text, and do not use any tools:
{"items":[{"kind":"decision|action|info|offer","quote":"...","question":"...","options":["..."],"recommendation":"...","same":""}],"closes":[]}
If the answer asks the person nothing, answer {"items":[],"closes":[]} (with any closes).

<answer>
`)
	b.WriteString(truncateRunes(answer, 24000))
	b.WriteString("\n</answer>\n")
	return b.String()
}

type triageResult struct {
	Items []struct {
		Kind           string   `json:"kind"`
		Quote          string   `json:"quote"`
		Question       string   `json:"question"`
		Options        []string `json:"options"`
		Recommendation string   `json:"recommendation"`
		Same           string   `json:"same"`
	} `json:"items"`
	Closes []string `json:"closes"`
}

// parseTriage reads the JSON a triage answered with, in a code fence or not.
func parseTriage(response string) (triageResult, bool) {
	text := strings.TrimSpace(response)
	start, end := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return triageResult{}, false
	}
	var result triageResult
	if err := json.Unmarshal([]byte(text[start:end+1]), &result); err != nil {
		return triageResult{}, false
	}
	return result, true
}

// triageMarks are what a model may drop or change when it quotes Markdown:
// spacing and formatting marks. A quote matches the answer without them.
var triageMarks = regexp.MustCompile("[\\s*`_#>|\\-]+")

func triageNormal(text string) string {
	return strings.ToLower(triageMarks.ReplaceAllString(text, ""))
}

// finishTriage keeps what a triage found: each request that quotes the
// answer, once (a request the answer repeats is the open item it names),
// and closes what it reports settled.
func (s *Server) finishTriage(ctx context.Context, triage store.AgentSession) {
	if triage.Status != "completed" {
		return
	}
	header := triageHeader.FindStringSubmatch(triage.Prompt)
	answerMatch := triageAnswer.FindStringSubmatch(triage.Prompt)
	result, ok := parseTriage(triage.Response)
	if header == nil || answerMatch == nil || !ok {
		log.Printf("triage %s: nothing to read (header %t, answer %t, json %t)", triage.ID, header != nil, answerMatch != nil, ok)
		return
	}
	chat, err := s.store.GetAgentSessionSummary(ctx, header[1])
	if err != nil || !pendingChat(chat) {
		return
	}
	answer := triageNormal(answerMatch[1])
	open, err := s.store.ListPendingItems(ctx, chat.CreatedByUserID, []string{store.PendingOpen}, "", 300)
	if err != nil {
		log.Printf("triage %s: list open items: %v", triage.ID, err)
		return
	}
	keys := map[string]string{}
	for _, item := range open {
		if item.SessionID == chat.ID {
			keys[item.ID] = item.Key
		}
	}
	for _, id := range result.Closes {
		if key := keys[strings.TrimSpace(id)]; key != "" {
			if _, err := s.store.ResolvePendingItems(ctx, store.PendingResolution{Key: key, State: store.PendingReplied}); err != nil {
				log.Printf("triage %s: close %s: %v", triage.ID, id, err)
			}
		}
	}
	for _, found := range result.Items {
		quote := strings.TrimSpace(found.Quote)
		if found.Kind == "offer" || quote == "" || !strings.Contains(answer, triageNormal(quote)) {
			continue
		}
		question := strings.TrimSpace(found.Question)
		if question == "" {
			question = quote
		}
		key := keys[strings.TrimSpace(found.Same)]
		if key == "" {
			sum := sha256.Sum256([]byte(triageNormal(quote)))
			key = "answer:" + chat.ID + ":" + hex.EncodeToString(sum[:8])
		}
		item := store.PendingItem{
			UserID: chat.CreatedByUserID, WorkspaceID: chat.WorkspaceID, SessionID: chat.ID,
			EventID: "answer:" + header[3] + ":" + header[2], MessageID: header[2],
			Source: store.PendingSourceAnswer, Rule: found.Kind, Key: key,
			Title: truncateRunes(question, 300), Excerpt: truncateRunes(quote, 600),
			Options: found.Options, Recommendation: strings.TrimSpace(found.Recommendation),
		}
		if _, _, err := s.store.RecordPendingItem(ctx, item); err != nil {
			log.Printf("triage %s: record: %v", triage.ID, err)
		}
	}
}

func truncateRunes(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	return string([]rune(text)[:limit])
}

var triageEfforts = map[string][]string{
	"claude": {"low", "medium", "high", "xhigh", "max"},
	"codex":  {"minimal", "low", "medium", "high", "xhigh"},
}

func (s *Server) handleGetPendingTriage(w http.ResponseWriter, r *http.Request) {
	user := accountID(r)
	if user == "" {
		writeError(w, http.StatusForbidden, "triage settings belong to a signed-in account")
		return
	}
	settings, err := s.store.PendingTriageSettings(r.Context(), user)
	writeResult(w, settings, err)
}

// handleSavePendingTriage keeps the person's choice: one of their devices
// and a connection there; off keeps the choice for when it is on again.
func (s *Server) handleSavePendingTriage(w http.ResponseWriter, r *http.Request) {
	user := accountID(r)
	if user == "" {
		writeError(w, http.StatusForbidden, "triage settings belong to a signed-in account")
		return
	}
	var input store.PendingTriageSettings
	if !decodeJSONRequest(w, r, &input) {
		return
	}
	for _, value := range []string{input.DeviceID, input.Runtime, input.ProfileID, input.Model, input.Effort} {
		if len(value) > 200 || strings.ContainsAny(value, "\r\n\t") {
			writeError(w, http.StatusBadRequest, "choices are short single-line values")
			return
		}
	}
	if input.Enabled {
		if input.DeviceID == "" || input.ProfileID == "" {
			writeError(w, http.StatusBadRequest, "choose a device and a connection to read answers with")
			return
		}
		efforts, known := triageEfforts[input.Runtime]
		if !known {
			writeError(w, http.StatusBadRequest, "runtime must be claude or codex")
			return
		}
		if input.Effort != "" && !slices.Contains(efforts, input.Effort) {
			writeError(w, http.StatusBadRequest, "effort must be one of "+strings.Join(efforts, ", "))
			return
		}
		owned, err := s.store.DevicesOwnedBy(r.Context(), user)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		if !slices.Contains(owned, input.DeviceID) {
			writeError(w, http.StatusForbidden, "answers are read on one of your own devices")
			return
		}
	}
	input.UpdatedAt = ""
	saved, err := s.store.SavePendingTriageSettings(r.Context(), user, input)
	writeResult(w, saved, err)
}
