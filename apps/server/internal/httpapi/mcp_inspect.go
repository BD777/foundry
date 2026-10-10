package httpapi

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Session inspection for agents: a compact summary of any session or synced
// native chat the caller reaches, and a filtered, paged read of its events,
// named by id or by a Foundry chat link. A session can hold thousands of
// events and megabytes of text; these reads keep an agent's context small.

const (
	inspectAnswerLimit  = 1000
	inspectInputLimit   = 300
	inspectDetailLimit  = 300
	inspectBeforeLimit  = 160
	inspectDefaultLimit = 50
	inspectMaxLimit     = 500
	inspectMaxContext   = 5
	inspectMaxTasks     = 5
	inspectDefaultBytes = 12_000
)

// inspectedID turns what an agent was given, an id or a Foundry link to a
// chat (https://<host>/chats/<id>?workspace=…), into the id.
func inspectedID(raw string) string {
	value := strings.Trim(strings.TrimSpace(raw), "`'\"<>()[],.;")
	if !strings.Contains(value, "/") {
		return value
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return value
	}
	segments := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	for index := 0; index+1 < len(segments); index++ {
		if segments[index] != "chats" {
			continue
		}
		if id, err := url.PathUnescape(segments[index+1]); err == nil && strings.TrimSpace(id) != "" {
			return strings.TrimSpace(id)
		}
	}
	return value
}

// mcpSessionID reads a session argument given as an id or a Foundry link.
func mcpSessionID(args map[string]json.RawMessage, key string) string {
	return inspectedID(mcpArgString(args, key))
}

// mcpArgList reads a list argument sent as an array or a comma-separated
// string.
func mcpArgList(args map[string]json.RawMessage, key string) []string {
	raw, ok := args[key]
	if !ok {
		return nil
	}
	var values []string
	if json.Unmarshal(raw, &values) != nil {
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return nil
		}
		values = strings.Split(text, ",")
	}
	out := []string{}
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			out = append(out, value)
		}
	}
	return out
}

// inspectTarget is what an id names: a Foundry session or a native chat a
// device synced.
type inspectTarget struct {
	session *store.AgentSession
	chat    *store.ChatThread
}

func inspectNotFound(id string) error {
	return &mcpToolError{http.StatusNotFound, "no session or chat " + id + " that you can read (ids look like sess_…, native_claude_…, native_codex_…)"}
}

// resolveInspectTarget finds a session or native chat the actor may read.
// Missing and unreadable answer alike, so reach is not disclosed. withEvents
// loads a session's events.
func (s *Server) resolveInspectTarget(ctx context.Context, actor Actor, raw string, withEvents bool) (inspectTarget, error) {
	id := inspectedID(raw)
	if id == "" {
		return inspectTarget{}, &mcpToolError{http.StatusBadRequest, "sessionId is required: a session id (sess_…), a native chat id (native_claude_…, native_codex_…) or a Foundry chat link"}
	}
	if strings.HasPrefix(id, "native_") {
		chat, err := s.store.GetChat(ctx, id)
		switch {
		case err == nil:
			if !s.canReadNativeChat(ctx, actor, chat.WorkspaceID, chat.ID) {
				return inspectTarget{}, inspectNotFound(id)
			}
			return inspectTarget{chat: &chat}, nil
		case !errors.Is(err, store.ErrNotFound):
			return inspectTarget{}, err
		}
		// A native chat a Foundry session took over is read as that session.
		owner := ""
		if inspection, ok := s.store.(store.SessionInspectionStore); ok {
			provider, nativeID, _ := strings.Cut(strings.TrimPrefix(id, "native_"), "_")
			if owner, err = inspection.NativeSessionOwner(ctx, provider, nativeID); err != nil {
				return inspectTarget{}, err
			}
		}
		if owner == "" {
			return inspectTarget{}, inspectNotFound(id)
		}
		id = owner
	}
	load := s.store.GetAgentSessionSummary
	if withEvents {
		load = s.store.GetAgentSession
	}
	session, err := load(ctx, id)
	if errors.Is(err, store.ErrNotFound) || (err == nil && !s.canReadSession(ctx, actor, session)) {
		return inspectTarget{}, inspectNotFound(id)
	}
	if err != nil {
		return inspectTarget{}, err
	}
	return inspectTarget{session: &session}, nil
}

// inspectEvent is one session event or native transcript message, as an
// agent reads it.
type inspectEvent struct {
	id, at, level, label, detail, text string
	// message is the text of a transcript message the event carries.
	message  string
	when     time.Time
	metadata *store.AgentSessionEventMetadata
}

func (event inspectEvent) line(detailLimit int) string {
	fields := []string{inspectTime(event.at), event.level, event.label}
	if detail := oneLine(event.detail, detailLimit); detail != "" {
		fields = append(fields, detail)
	}
	return strings.Join(fields, " | ")
}

func (event inspectEvent) matches(text string) bool {
	return strings.Contains(strings.ToLower(event.label+"\n"+event.detail+"\n"+event.text), text)
}

// sessionInspectEvents are a session's events in order, without the ones
// the web does not show either (a model request's token report).
func sessionInspectEvents(events []store.AgentSessionEvent) []inspectEvent {
	out := make([]inspectEvent, 0, len(events))
	for _, event := range events {
		if event.Metadata != nil && event.Metadata.RequestUsage != nil {
			continue
		}
		item := inspectEvent{id: event.ID, at: event.At, level: event.Level, label: event.Label, detail: event.Detail, metadata: event.Metadata}
		if event.Message != nil {
			item.text = event.Message.Title + "\n" + event.Message.Text
			item.message = event.Message.Text
			if strings.TrimSpace(item.detail) == "" {
				item.detail = event.Message.Text
			}
		}
		if item.level == "" {
			item.level = "info"
		}
		item.when = parseInspectTime(event.At)
		out = append(out, item)
	}
	return out
}

// chatInspectEvents are a native chat's transcript messages as events: a
// failed tool call is an error.
func chatInspectEvents(chat store.ChatThread) []inspectEvent {
	out := make([]inspectEvent, 0, len(chat.Transcript))
	for _, message := range chat.Transcript {
		label := message.Kind
		if message.Title != "" {
			label += ": " + message.Title
		}
		level := "info"
		if message.Status == "failed" {
			level = "error"
		}
		out = append(out, inspectEvent{
			id: message.ID, at: message.At, level: level, label: label, detail: message.Text,
			when: parseInspectTime(message.At),
		})
	}
	return out
}

func (target inspectTarget) events() []inspectEvent {
	if target.chat != nil {
		return chatInspectEvents(*target.chat)
	}
	return sessionInspectEvents(target.session.Events)
}

func (target inspectTarget) id() string {
	if target.chat != nil {
		return target.chat.ID
	}
	return target.session.ID
}

type inspectPlace struct {
	ID     string `json:"id"`
	Name   string `json:"name,omitempty"`
	Online *bool  `json:"online,omitempty"`
}

type inspectEventRef struct {
	ID     string `json:"id"`
	At     string `json:"at"`
	Label  string `json:"label"`
	Detail string `json:"detail,omitempty"`
	// Before are the events just before it, one line each.
	Before []string `json:"before,omitempty"`
}

type inspectTask struct {
	ID          string `json:"id"`
	Kind        string `json:"kind,omitempty"`
	Description string `json:"description"`
	StartedAt   string `json:"startedAt,omitempty"`
}

type inspectCounts struct {
	Total    int `json:"total"`
	Errors   int `json:"errors"`
	Warnings int `json:"warnings"`
}

// sessionDigest is a session's current state in a few hundred bytes.
type sessionDigest struct {
	ID              string           `json:"id"`
	Kind            string           `json:"kind"`
	Title           string           `json:"title"`
	Status          string           `json:"status"`
	Error           string           `json:"error,omitempty"`
	Runtime         string           `json:"runtime,omitempty"`
	Profile         string           `json:"profile,omitempty"`
	Model           string           `json:"model,omitempty"`
	Device          *inspectPlace    `json:"device,omitempty"`
	Workspace       *inspectPlace    `json:"workspace,omitempty"`
	Source          string           `json:"source,omitempty"`
	Role            string           `json:"role,omitempty"`
	IssueID         string           `json:"issueId,omitempty"`
	ParentSessionID string           `json:"parentSessionId,omitempty"`
	Group           *inspectPlace    `json:"group,omitempty"`
	NativeSessionID string           `json:"nativeSessionId,omitempty"`
	CreatedAt       string           `json:"createdAt,omitempty"`
	StartedAt       string           `json:"startedAt,omitempty"`
	CompletedAt     string           `json:"completedAt,omitempty"`
	LastActivityAt  string           `json:"lastActivityAt,omitempty"`
	LastInput       string           `json:"lastInput,omitempty"`
	Events          inspectCounts    `json:"events"`
	LastAnswer      string           `json:"lastAnswer,omitempty"`
	LastError       *inspectEventRef `json:"lastError,omitempty"`
	// OpenBackgroundTasks were started in the latest turn and not reported
	// finished: what a turn that never ended may have been waiting on.
	OpenBackgroundTasks []inspectTask `json:"openBackgroundTasks,omitempty"`
	More                string        `json:"more"`
}

const inspectMoreHint = `read_context scope=events reads events: levels=["error","warning"] tail=20 (context=2 adds what led up to each), query="text" searches, after/before page with the cursors it prints; scope=thread or transcript only for the full conversation.`

func (s *Server) sessionDigestForMCP(ctx context.Context, actor Actor, raw string) (string, error) {
	target, err := s.resolveInspectTarget(ctx, actor, raw, true)
	if err != nil {
		return "", err
	}
	digest := s.digest(ctx, target)
	encoded, err := json.MarshalIndent(digest, "", "  ")
	return string(encoded), err
}

func (s *Server) digest(ctx context.Context, target inspectTarget) sessionDigest {
	events := target.events()
	digest := sessionDigest{ID: target.id(), More: inspectMoreHint}
	var workspaceID, deviceID string
	if chat := target.chat; chat != nil {
		digest.Kind = "native_chat"
		digest.Title, digest.Status = chat.Title, chat.Status
		digest.Runtime, digest.Profile, digest.NativeSessionID = chat.Provider, chat.ProfileLabel, chat.NativeSessionID
		digest.LastActivityAt = chat.UpdatedAt
		workspaceID = chat.WorkspaceID
		for index := len(events) - 1; index >= 0; index-- {
			kind, _, _ := strings.Cut(events[index].label, ":")
			if kind == "assistant" && digest.LastAnswer == "" {
				digest.LastAnswer = excerpt(events[index].detail, inspectAnswerLimit)
			}
			if kind == "user" && digest.LastInput == "" {
				digest.LastInput = excerpt(events[index].detail, inspectInputLimit)
			}
		}
	} else {
		session := target.session
		digest.Kind = "session"
		digest.Title, digest.Status, digest.Error = session.Title, session.Status, session.Error
		digest.Runtime, digest.Profile, digest.Model = session.Provider, session.ProfileLabel, session.Model
		digest.Source, digest.Role, digest.IssueID = session.Source, session.Role, session.IssueID
		digest.ParentSessionID, digest.NativeSessionID = session.ParentSessionID, session.NativeSessionID
		digest.StartedAt, digest.CompletedAt, digest.LastActivityAt = session.StartedAt, session.CompletedAt, session.LastActivityAt
		digest.LastInput = excerpt(session.Input.Prompt, inspectInputLimit)
		digest.LastAnswer = excerpt(session.Response, inspectAnswerLimit)
		if digest.LastAnswer == "" {
			// A turn that did not complete keeps what it streamed.
			for index := len(events) - 1; index >= 0; index-- {
				if event := events[index]; event.label == "Response stream" {
					digest.LastAnswer = excerpt(cmp.Or(event.message, event.detail), inspectAnswerLimit)
					break
				}
			}
		}
		if inspection, ok := s.store.(store.SessionInspectionStore); ok {
			digest.CreatedAt, _ = inspection.AgentSessionCreatedAt(ctx, session.ID)
		}
		digest.OpenBackgroundTasks = openBackgroundTasks(session.Events, parseInspectTime(session.StartedAt))
		workspaceID, deviceID = session.WorkspaceID, session.DeviceID
		if layout, err := s.store.GetChatLayout(ctx, workspaceID); err == nil {
			digest.Group = layoutGroup(layout, session.ID)
		}
	}
	digest.Events.Total = len(events)
	for index, event := range events {
		switch event.level {
		case "error":
			digest.Events.Errors++
			digest.LastError = &inspectEventRef{ID: event.id, At: event.at, Label: event.label, Detail: oneLine(event.detail, inspectDetailLimit)}
			digest.LastError.Before = []string{}
			for previous := max(0, index-3); previous < index; previous++ {
				digest.LastError.Before = append(digest.LastError.Before, events[previous].line(inspectBeforeLimit))
			}
		case "warning":
			digest.Events.Warnings++
		}
	}
	if workspaceID != "" {
		digest.Workspace = &inspectPlace{ID: workspaceID}
		if workspace, err := s.store.GetWorkspace(ctx, workspaceID); err == nil {
			digest.Workspace.Name = workspace.Name
			if deviceID == "" {
				deviceID = workspace.DeviceID
			}
		}
	}
	if deviceID != "" {
		online := s.hub.HasConnection(deviceID)
		digest.Device = &inspectPlace{ID: deviceID, Online: &online}
		if devices, err := s.store.ListDevices(ctx); err == nil {
			for _, device := range devices {
				if device.ID == deviceID {
					digest.Device.Name = device.Label
				}
			}
		}
	}
	return digest
}

func layoutGroup(layout store.ChatLayout, chatID string) *inspectPlace {
	for _, position := range layout.Positions {
		if position.ChatID != chatID || position.GroupID == "" {
			continue
		}
		group := &inspectPlace{ID: position.GroupID}
		for _, candidate := range layout.Groups {
			if candidate.ID == position.GroupID {
				group.Name = candidate.Name
			}
		}
		return group
	}
	return nil
}

// openBackgroundTasks are the background tasks started since the latest
// input and not reported finished. A worker that reports task snapshots is
// read from the latest one; older workers only report subtasks starting and
// ending.
func openBackgroundTasks(events []store.AgentSessionEvent, since time.Time) []inspectTask {
	for index := len(events) - 1; index >= 0; index-- {
		metadata := events[index].Metadata
		if metadata == nil || metadata.BackgroundTaskSnapshot == nil {
			continue
		}
		tasks := []inspectTask{}
		for _, task := range *metadata.BackgroundTaskSnapshot {
			if task.Status == "running" {
				tasks = append(tasks, inspectTask{ID: task.ID, Kind: task.Kind, Description: oneLine(task.Description, inspectBeforeLimit), StartedAt: task.StartedAt})
			}
		}
		return lastTasks(tasks)
	}
	open := map[string]int{}
	tasks := []inspectTask{}
	for _, event := range events {
		metadata := event.Metadata
		if metadata == nil || metadata.TaskID == "" {
			continue
		}
		switch event.Label {
		case "Starting subtask":
			if !since.IsZero() && parseInspectTime(event.At).Before(since) {
				continue
			}
			open[metadata.TaskID] = len(tasks)
			tasks = append(tasks, inspectTask{ID: metadata.TaskID, Kind: metadata.TaskType, Description: oneLine(event.Detail, inspectBeforeLimit), StartedAt: event.At})
		case "Subtask completed", "Subtask failed":
			if position, ok := open[metadata.TaskID]; ok {
				tasks[position].ID = ""
				delete(open, metadata.TaskID)
			}
		}
	}
	remaining := []inspectTask{}
	for _, task := range tasks {
		if task.ID != "" {
			remaining = append(remaining, task)
		}
	}
	return lastTasks(remaining)
}

func lastTasks(tasks []inspectTask) []inspectTask {
	if len(tasks) > inspectMaxTasks {
		tasks = tasks[len(tasks)-inspectMaxTasks:]
	}
	if len(tasks) == 0 {
		return nil
	}
	return tasks
}

// eventQuery is a read_context scope=events request.
type eventQuery struct {
	levels, labels map[string]bool
	query          string
	tail, limit    int
	context        int
	after, before  string
	maxBytes       int
}

func eventQueryFromArgs(args map[string]json.RawMessage) eventQuery {
	query := eventQuery{
		levels: map[string]bool{}, labels: map[string]bool{},
		query:    strings.ToLower(mcpArgString(args, "query")),
		tail:     mcpArgNumber(args, "tail", 0),
		limit:    min(mcpArgNumber(args, "limit", inspectDefaultLimit), inspectMaxLimit),
		context:  min(mcpArgNumber(args, "context", 0), inspectMaxContext),
		after:    mcpArgString(args, "after"),
		before:   mcpArgString(args, "before"),
		maxBytes: mcpArgNumber(args, "maxBytes", inspectDefaultBytes),
	}
	query.tail = min(query.tail, inspectMaxLimit)
	for _, level := range mcpArgList(args, "levels") {
		query.levels[strings.ToLower(level)] = true
	}
	for _, label := range mcpArgList(args, "labels") {
		query.labels[strings.ToLower(label)] = true
	}
	return query
}

func (query eventQuery) keeps(event inspectEvent) bool {
	if len(query.levels) > 0 && !query.levels[strings.ToLower(event.level)] {
		return false
	}
	if len(query.labels) > 0 && !query.labels[strings.ToLower(event.label)] {
		return false
	}
	return query.query == "" || event.matches(query.query)
}

func (query eventQuery) describe() string {
	parts := []string{}
	if len(query.levels) > 0 {
		parts = append(parts, "levels="+strings.Join(sortedKeys(query.levels), ","))
	}
	if len(query.labels) > 0 {
		parts = append(parts, "labels="+strings.Join(sortedKeys(query.labels), ","))
	}
	if query.query != "" {
		parts = append(parts, fmt.Sprintf("query=%q", query.query))
	}
	if query.after != "" {
		parts = append(parts, "after="+query.after)
	}
	if query.before != "" {
		parts = append(parts, "before="+query.before)
	}
	if len(parts) == 0 {
		return ""
	}
	return " (" + strings.Join(parts, " ") + ")"
}

// cursorIndex places a cursor, an event id or a time, in the events: the
// index of the first event after it.
func cursorIndex(events []inspectEvent, cursor string) (int, error) {
	for index, event := range events {
		if event.id == cursor {
			return index + 1, nil
		}
	}
	at := parseInspectTime(cursor)
	if at.IsZero() {
		return 0, &mcpToolError{http.StatusBadRequest, "unknown cursor " + cursor + ": use an event id this tool printed or a time such as 2026-10-09T20:40:00Z"}
	}
	for index, event := range events {
		if event.when.After(at) {
			return index, nil
		}
	}
	return len(events), nil
}

// readEvents renders the events a query selects, one line each, within its
// byte budget, with the cursors that continue the read.
func readEvents(id string, events []inspectEvent, query eventQuery) (string, error) {
	start, end := 0, len(events)
	var err error
	if query.after != "" {
		if start, err = cursorIndex(events, query.after); err != nil {
			return "", err
		}
	}
	if query.before != "" {
		if end, err = cursorIndex(events, query.before); err != nil {
			return "", err
		}
		// An event-id cursor excludes the event itself.
		if end > 0 && events[end-1].id == query.before {
			end--
		}
	}
	matches := []int{}
	for index := start; index < end; index++ {
		if query.keeps(events[index]) {
			matches = append(matches, index)
		}
	}
	tailMode := query.tail > 0
	selected := matches
	if tailMode && len(selected) > query.tail {
		selected = selected[len(selected)-query.tail:]
	} else if !tailMode && len(selected) > query.limit {
		selected = selected[:query.limit]
	}
	shown := map[int]bool{}
	for _, index := range selected {
		shown[index] = true
		for previous := max(start, index-query.context); previous < index; previous++ {
			shown[previous] = true
		}
	}
	indexes := sortedIndexes(shown)
	lines := make([]string, len(indexes))
	for position, index := range indexes {
		lines[position] = events[index].line(inspectDetailLimit)
	}
	// Keep the newest lines of a tail and the oldest of a page.
	budget := max(query.maxBytes, 1000)
	used, kept := 0, 0
	for kept < len(lines) {
		line := lines[kept]
		if tailMode {
			line = lines[len(lines)-1-kept]
		}
		if used+len(line)+1 > budget {
			break
		}
		used += len(line) + 1
		kept++
	}
	omitted := len(lines) - kept
	if tailMode {
		indexes, lines = indexes[omitted:], lines[omitted:]
	} else {
		indexes, lines = indexes[:kept], lines[:kept]
	}
	var out strings.Builder
	fmt.Fprintf(&out, "%s: %d of %d events match%s; showing %d", id, len(matches), len(events), query.describe(), len(lines))
	if query.context > 0 {
		fmt.Fprintf(&out, " with %d before each", query.context)
	}
	out.WriteString(".\n")
	if len(lines) > 0 {
		out.WriteString("time | level | label | detail\n")
		out.WriteString(strings.Join(lines, "\n"))
		out.WriteString("\n")
	}
	if omitted > 0 {
		fmt.Fprintf(&out, "…[%d lines left out at maxBytes %d]\n", omitted, budget)
	}
	// The cursors continue past this read's window too.
	if len(indexes) > 0 {
		first, last := indexes[0], indexes[len(indexes)-1]
		if slices.ContainsFunc(events[:first], query.keeps) {
			fmt.Fprintf(&out, "Earlier matches: before=%s\n", events[first].id)
		}
		if slices.ContainsFunc(events[last+1:], query.keeps) {
			fmt.Fprintf(&out, "Later matches: after=%s\n", events[last].id)
		}
	}
	return out.String(), nil
}

func (s *Server) sessionEventsForMCP(ctx context.Context, actor Actor, args map[string]json.RawMessage) (string, error) {
	target, err := s.resolveInspectTarget(ctx, actor, mcpArgString(args, "sessionId"), true)
	if err != nil {
		return "", err
	}
	return readEvents(target.id(), target.events(), eventQueryFromArgs(args))
}

func sortedKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func sortedIndexes(values map[int]bool) []int {
	indexes := make([]int, 0, len(values))
	for index := range values {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	return indexes
}

func parseInspectTime(value string) time.Time {
	at, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return time.Time{}
	}
	return at
}

// inspectTime prints an event time to the second, in UTC; "-" when it has
// none.
func inspectTime(value string) string {
	at := parseInspectTime(value)
	if at.IsZero() {
		return cmp.Or(strings.TrimSpace(value), "-")
	}
	return at.UTC().Format(time.RFC3339)
}

// oneLine collapses text to one line of at most limit characters.
func oneLine(text string, limit int) string {
	return excerpt(strings.Join(strings.Fields(text), " "), limit)
}

// excerpt keeps the first limit characters of a text, marking a cut.
func excerpt(text string, limit int) string {
	text = strings.TrimSpace(text)
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}
