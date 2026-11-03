package store

import (
	"cmp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// AgentSessionPanel is what a chat's side panel shows of a session
// (packages/protocol/src/session-panel.ts). DeriveSessionPanel is its one
// definition; readers render it.
type AgentSessionPanel struct {
	Usage           AgentSessionPanelUsage            `json:"usage"`
	Focus           bool                              `json:"focus"`
	Subagents       []AgentSessionPanelSubagent       `json:"subagents"`
	Background      []AgentSessionPanelBackgroundTask `json:"background"`
	Timers          []AgentSessionPanelTimer          `json:"timers"`
	TimerSnapshotAt string                            `json:"timerSnapshotAt,omitempty"`
	TimerWakes      []AgentSessionPanelTimerWake      `json:"timerWakes"`
	FailedTimerRun  *AgentSessionPanelTimerRun        `json:"failedTimerRun,omitempty"`
	Busy            bool                              `json:"busy"`
	Files           []AgentSessionPanelFile           `json:"files"`
	Previews        []AgentSessionPanelLink           `json:"previews"`
	Sources         []AgentSessionPanelLink           `json:"sources"`
	Screen          *SessionToolFrame                 `json:"screen,omitempty"`
}

// AgentSessionPanelUsage is how full the context is and what the
// session's turns used.
type AgentSessionPanelUsage struct {
	Model              string                       `json:"model,omitempty"`
	UsedTokens         *int64                       `json:"usedTokens,omitempty"`
	ContextWindow      *int64                       `json:"contextWindow,omitempty"`
	Configured         *ConfiguredContextWindow     `json:"configured,omitempty"`
	Turns              int                          `json:"turns"`
	Totals             AgentSessionPanelTotals      `json:"totals"`
	LastTurnDurationMs *int64                       `json:"lastTurnDurationMs,omitempty"`
	Compactions        int                          `json:"compactions"`
	LastCompaction     *AgentSessionPanelCompaction `json:"lastCompaction,omitempty"`
}

type AgentSessionPanelTotals struct {
	InputTokens      int64    `json:"inputTokens"`
	CacheReadTokens  int64    `json:"cacheReadTokens"`
	CacheWriteTokens int64    `json:"cacheWriteTokens"`
	OutputTokens     int64    `json:"outputTokens"`
	CostUSD          *float64 `json:"costUsd,omitempty"`
	CostTurns        int      `json:"costTurns"`
}

// AgentSessionPanelCompaction is the latest compaction and its divider in
// the transcript.
type AgentSessionPanelCompaction struct {
	At        string `json:"at"`
	MessageID string `json:"messageId"`
}

type AgentSessionPanelSubagent struct {
	ID        string         `json:"id"`
	TaskID    string         `json:"taskId"`
	ToolUseID string         `json:"toolUseId,omitempty"`
	Detail    string         `json:"detail,omitempty"`
	Status    string         `json:"status"`
	Usage     *SubagentUsage `json:"usage,omitempty"`
}

type AgentSessionPanelBackgroundTask struct {
	Task  AgentBackgroundTask `json:"task"`
	Owner string              `json:"owner,omitempty"`
}

type AgentSessionPanelTimer struct {
	Task    AgentScheduledTask           `json:"task"`
	Runs    []*AgentSessionPanelTimerRun `json:"runs"`
	Running *AgentSessionPanelTimerRun   `json:"running,omitempty"`
}

// AgentSessionPanelTimerRun is a timer's run as the panel shows it.
type AgentSessionPanelTimerRun struct {
	ID             string `json:"id,omitempty"`
	Origin         string `json:"origin"`
	Prompt         string `json:"prompt"`
	Response       string `json:"response,omitempty"`
	StartedAt      string `json:"startedAt,omitempty"`
	CompletedAt    string `json:"completedAt"`
	AnswerUnloaded bool   `json:"answerUnloaded,omitempty"`
	Failed         bool   `json:"failed,omitempty"`
}

type AgentSessionPanelTimerWake struct {
	ID      string `json:"id"`
	FiredAt string `json:"firedAt"`
}

type AgentSessionPanelFile struct {
	Path            string                                  `json:"path"`
	WorkspacePath   string                                  `json:"workspacePath,omitempty"`
	Origin          string                                  `json:"origin"`
	Op              string                                  `json:"op"`
	InGitRepo       bool                                    `json:"inGitRepo"`
	TurnIDs         []string                                `json:"turnIds"`
	Bytes           *int64                                  `json:"bytes,omitempty"`
	LineChanges     *AgentSessionPanelLineChanges           `json:"lineChanges,omitempty"`
	TurnLineChanges map[string]AgentSessionPanelLineChanges `json:"turnLineChanges,omitempty"`
	Diff            string                                  `json:"diff,omitempty"`
	TurnDiff        map[string]string                       `json:"turnDiff,omitempty"`
}

type AgentSessionPanelLineChanges struct {
	Added   int `json:"added"`
	Removed int `json:"removed"`
}

// AgentSessionPanelLink is a preview address or a loaded workspace, by the
// event that named it.
type AgentSessionPanelLink struct {
	ID     string `json:"id"`
	Target string `json:"target"`
}

// DeriveSessionPanel is the side panel of a session from its state events
// (AgentSessionStateEvents, oldest first): the one place it is derived.
// What a panel shows depends on nothing else a reader loaded, so a reader
// with any window of the transcript, and a session read before and after
// its events were compacted, show the same panel.
func DeriveSessionPanel(session AgentSession, events []AgentSessionEvent) AgentSessionPanel {
	runs := deriveTimerRuns(session, events)
	background := latestBackground(events)
	panel := AgentSessionPanel{
		Usage:      deriveUsage(events),
		Subagents:  deriveSubagents(session, events),
		Background: backgroundRows(session, background),
		Timers:     []AgentSessionPanelTimer{},
		TimerWakes: []AgentSessionPanelTimerWake{},
		Files:      deriveFiles(session, events),
		Previews:   derivePreviews(session, events),
		Sources:    deriveSources(events),
	}
	panel.Busy = IsActiveSessionStatus(session.Status) || runs.running != nil ||
		slices.ContainsFunc(background, func(task AgentBackgroundTask) bool { return task.Status == "running" })
	timers, snapshotAt := latestTimers(events)
	if len(timers) > 0 {
		panel.TimerSnapshotAt = snapshotAt
		for _, task := range timers {
			timer := AgentSessionPanelTimer{Task: task, Runs: []*AgentSessionPanelTimerRun{}}
			for _, run := range runs.fires {
				if run.ID == task.ID {
					timer.Runs = append(timer.Runs, run)
				}
			}
			if runs.running != nil && (runs.running.ID == "" || runs.running.ID == task.ID) {
				timer.Running = runs.running
			}
			panel.Timers = append(panel.Timers, timer)
		}
	}
	firstSeen := map[string]string{}
	ids := []string{}
	for _, task := range timers {
		ids = append(ids, task.ID)
	}
	if session.Scheduled != nil {
		held := map[string]bool{}
		for _, timer := range session.Scheduled.Timers {
			firstSeen[timer.ID] = timer.FirstSeenAt
			held[timer.ID] = true
			if !slices.Contains(ids, timer.ID) {
				ids = append(ids, timer.ID)
			}
		}
		// Newest first: the first ended run of a timer the session holds.
		for _, run := range runs.fires {
			if run.CompletedAt != "" && (run.ID == "" || held[run.ID]) {
				if run.Failed {
					panel.FailedTimerRun = run
				}
				break
			}
		}
	}
	for _, id := range ids {
		if firedAt := runs.wake(id, firstSeen[id]); firedAt != "" {
			panel.TimerWakes = append(panel.TimerWakes, AgentSessionPanelTimerWake{ID: id, FiredAt: firedAt})
		}
	}
	for index := len(events) - 1; index >= 0; index-- {
		if frame := events[index].Metadata; frame != nil && frame.ToolFrame != nil {
			panel.Screen = frame.ToolFrame
			break
		}
	}
	panel.Focus = len(panel.Subagents) > 0 || len(panel.Files) > 0 || len(panel.Previews) > 0 ||
		len(timers) > 0 || len(background) > 0 || webURL.MatchString(session.Response)
	return panel
}

func deriveUsage(events []AgentSessionEvent) AgentSessionPanelUsage {
	var (
		usage         AgentSessionPanelUsage
		context       *AgentContextUsage
		window        *AgentContextUsage
		requestTokens *int64
	)
	for _, event := range events {
		metadata := event.Metadata
		if metadata == nil {
			continue
		}
		if reported := metadata.ContextUsage; reported != nil {
			context = reported
			if reported.Compaction != nil {
				usage.Compactions++
				usage.LastCompaction = &AgentSessionPanelCompaction{At: event.At, MessageID: event.ID + ":compaction"}
			}
			if reported.ConfiguredWindow != nil {
				usage.Configured = reported.ConfiguredWindow
			}
			if reported.ContextWindow != nil && *reported.ContextWindow != 0 {
				window = reported
			}
		} else if metadata.RequestUsage != nil {
			tokens := metadata.RequestUsage.InputTokens
			requestTokens = &tokens
		}
		if turn := metadata.TurnUsage; turn != nil {
			usage.Turns++
			usage.Totals.InputTokens += turn.InputTokens
			usage.Totals.CacheReadTokens += turn.CacheReadTokens
			usage.Totals.CacheWriteTokens += turn.CacheWriteTokens
			usage.Totals.OutputTokens += turn.OutputTokens
			if turn.CostUSD != nil {
				cost := *turn.CostUSD
				if usage.Totals.CostUSD != nil {
					cost += *usage.Totals.CostUSD
				}
				usage.Totals.CostUSD = &cost
				usage.Totals.CostTurns++
			}
			duration := turn.DurationMs
			usage.LastTurnDurationMs = &duration
		}
	}
	if context != nil {
		usage.Model = context.Model
		usage.UsedTokens = context.InputTokens
	} else {
		usage.UsedTokens = requestTokens
	}
	// A report made before its model's window was known takes the one a
	// later report of the same model named; before the runtime names a
	// window, the one Foundry set stands in.
	switch {
	case context != nil && context.ContextWindow != nil:
		if *context.ContextWindow != 0 {
			usage.ContextWindow = context.ContextWindow
		}
	case window != nil && (context == nil || context.Model == "" || window.Model == context.Model):
		usage.ContextWindow = window.ContextWindow
	case usage.Configured != nil:
		tokens := usage.Configured.Tokens
		usage.ContextWindow = &tokens
	}
	return usage
}

func deriveSubagents(session AgentSession, events []AgentSessionEvent) []AgentSessionPanelSubagent {
	subagents := []AgentSessionPanelSubagent{}
	find := func(taskID string) int {
		return slices.IndexFunc(subagents, func(subagent AgentSessionPanelSubagent) bool { return subagent.TaskID == taskID })
	}
	for _, event := range events {
		phase := SubtaskEventPhase(event)
		if phase == NotSubtask {
			continue
		}
		metadata := event.Metadata
		detail := strings.TrimSpace(event.Detail)
		if phase == SubtaskStarted {
			if metadata.TaskType == SubagentTaskType {
				subagents = append(subagents, AgentSessionPanelSubagent{ID: event.ID, TaskID: metadata.TaskID, ToolUseID: metadata.ToolUseID, Detail: detail, Status: "running"})
			}
			continue
		}
		index := find(metadata.TaskID)
		if index < 0 {
			continue
		}
		// Its progress and end carry its reply as their detail: that stays
		// with the transcript.
		subagent := &subagents[index]
		if metadata.SubagentUsage != nil {
			subagent.Usage = metadata.SubagentUsage
		}
		switch phase {
		case SubtaskCompleted:
			subagent.Status = "completed"
		case SubtaskFailed:
			subagent.Status = "failed"
		}
	}
	// A subagent its session left running ended with it.
	if session.Status == "failed" || session.Status == "canceled" {
		for index := range subagents {
			if subagents[index].Status == "running" {
				subagents[index].Status = session.Status
			}
		}
	}
	return subagents
}

func latestBackground(events []AgentSessionEvent) []AgentBackgroundTask {
	var snapshot []AgentBackgroundTask
	for _, event := range events {
		if event.Metadata != nil && event.Metadata.BackgroundTaskSnapshot != nil {
			snapshot = *event.Metadata.BackgroundTaskSnapshot
		}
	}
	return snapshot
}

// backgroundRows are the snapshot's commands, monitors and workflows:
// running ones by start, then the most recently finished. Only Claude
// reports background work.
func backgroundRows(session AgentSession, snapshot []AgentBackgroundTask) []AgentSessionPanelBackgroundTask {
	rows := []AgentSessionPanelBackgroundTask{}
	if session.Provider != "claude" {
		return rows
	}
	subagents := map[string]string{}
	for _, task := range snapshot {
		if task.Kind == "subagent" {
			subagents[task.ID] = task.Description
		}
	}
	for _, task := range snapshot {
		if task.Kind != "subagent" {
			rows = append(rows, AgentSessionPanelBackgroundTask{Task: task, Owner: subagents[task.OwnerSubagentTaskID]})
		}
	}
	recency := func(task AgentBackgroundTask) string { return cmp.Or(task.EndedAt, task.StartedAt) }
	slices.SortStableFunc(rows, func(left, right AgentSessionPanelBackgroundTask) int {
		leftRunning, rightRunning := left.Task.Status == "running", right.Task.Status == "running"
		switch {
		case leftRunning != rightRunning && leftRunning:
			return -1
		case leftRunning != rightRunning:
			return 1
		case leftRunning:
			return strings.Compare(left.Task.StartedAt, right.Task.StartedAt)
		}
		return strings.Compare(recency(right.Task), recency(left.Task))
	})
	return rows
}

func latestTimers(events []AgentSessionEvent) ([]AgentScheduledTask, string) {
	var tasks []AgentScheduledTask
	var at string
	for _, event := range events {
		if event.Metadata != nil && event.Metadata.TimerSnapshot != nil {
			tasks, at = *event.Metadata.TimerSnapshot, event.At
		}
	}
	return tasks, at
}

// timerRuns are a session's timer runs.
type timerRuns struct {
	// fires are every timer's runs, newest first.
	fires []*AgentSessionPanelTimerRun
	// running is the run Claude started on its own and has not ended.
	running *AgentSessionPanelTimerRun
	// resumedAt is when a Claude process last started for the session.
	resumedAt string
}

// deriveTimerRuns reads the session's timer runs. A run Claude starts on
// its own is published as it fires and again with its answer, both under
// its start time; a run the device sent is a session input, answered by
// that input's turn. A run still open when a new input or process comes
// ended unanswered. Only the latest input's answer is the session's own; an
// earlier one is in the transcript.
func deriveTimerRuns(session AgentSession, events []AgentSessionEvent) timerRuns {
	var result timerRuns
	byStart := map[string]*AgentSessionPanelTimerRun{}
	byInput := map[string]*AgentSessionPanelTimerRun{}
	var answering *AgentSessionPanelTimerRun
	for _, event := range events {
		input := event.Label == EventLabelUserMessage
		if input {
			answering = nil
		}
		if input || event.Label == EventLabelClaudeProcessStarted {
			result.running = nil
		}
		if event.Label == EventLabelClaudeProcessStarted {
			result.resumedAt = event.At
		}
		var fire *AgentSessionTimerFire
		if event.Metadata != nil {
			fire = event.Metadata.TimerFire
		}
		if fire == nil {
			if answering != nil && event.Metadata != nil && event.Metadata.TurnUsage != nil {
				answering.CompletedAt = event.At
				answering = nil
			}
			continue
		}
		key := ""
		if fire.Origin == "scheduled" && fire.StartedAt != "" && !input {
			key = fire.ID + "|" + fire.StartedAt
		}
		record := byStart[key]
		if record == nil || key == "" {
			record = &AgentSessionPanelTimerRun{}
			result.fires = append(result.fires, record)
			if key != "" {
				byStart[key] = record
			}
		}
		record.ID, record.Origin, record.Prompt = fire.ID, fire.Origin, fire.Prompt
		record.StartedAt, record.CompletedAt = fire.StartedAt, fire.CompletedAt
		if fire.Response != "" {
			record.Response = fire.Response
		}
		if fire.CompletedAt != "" && event.Level == "error" {
			record.Failed = true
		}
		if input {
			record.AnswerUnloaded = record.Response == ""
			inputKey := record.StartedAt
			if event.Message != nil {
				inputKey = event.Message.ID
			}
			byInput[inputKey] = record
		}
		switch {
		case record.CompletedAt == "" && input:
			answering = record
		case record.CompletedAt == "":
			result.running = record
		case result.running == record:
			result.running = nil
		}
	}
	latest := byInput[session.Input.ID]
	if latest == nil && session.Input.TimerFire != nil && session.Input.TimerFire.StartedAt != "" {
		latest = byInput[session.Input.TimerFire.StartedAt]
	}
	if latest != nil && (session.Status == "completed" || session.Status == "failed") {
		if latest.CompletedAt == "" {
			latest.CompletedAt = session.CompletedAt
		}
		if session.Status == "failed" {
			latest.Failed = true
		}
		if response := strings.TrimSpace(session.Response); latest.Response == "" && response != "" {
			latest.Response = response
			latest.AnswerUnloaded = false
		}
	}
	slices.Reverse(result.fires)
	return result
}

// wake is what the runs say of a timer's last wake: its last fire, or the
// last start of a process that brought it back (one started before the
// timer existed did not), whichever is later. Claude Code (2.1.291 and
// later) brings a timer back as fired when it resumes the session.
func (runs timerRuns) wake(id, firstSeenAt string) string {
	var latest string
	var latestAt time.Time
	consider := func(value string) {
		if at, err := time.Parse(time.RFC3339Nano, value); err == nil && (latest == "" || at.After(latestAt)) {
			latest, latestAt = value, at
		}
	}
	for _, run := range runs.fires {
		if run.ID == id && run.StartedAt != "" {
			consider(run.StartedAt)
			break
		}
	}
	if resumed, err := time.Parse(time.RFC3339Nano, runs.resumedAt); err == nil {
		created, err := time.Parse(time.RFC3339Nano, firstSeenAt)
		if err != nil || created.Before(resumed) {
			consider(runs.resumedAt)
		}
	}
	return latest
}

// deriveFiles is one row per path the session's tools wrote or its answers
// named, with the turns that recorded it.
func deriveFiles(session AgentSession, events []AgentSessionEvent) []AgentSessionPanelFile {
	files := map[string]*AgentSessionPanelFile{}
	for _, event := range events {
		if event.Metadata == nil || event.Metadata.SessionFile == nil || event.Metadata.SessionFile.Path == "" {
			continue
		}
		record := event.Metadata.SessionFile
		turnID := cmp.Or(record.InputID, session.ID)
		var turnCounts, totalCounts *AgentSessionPanelLineChanges
		if record.Added != nil && record.Removed != nil {
			turnCounts = &AgentSessionPanelLineChanges{Added: *record.Added, Removed: *record.Removed}
		}
		switch {
		case record.TotalAdded != nil && record.TotalRemoved != nil:
			totalCounts = &AgentSessionPanelLineChanges{Added: *record.TotalAdded, Removed: *record.TotalRemoved}
		case turnCounts != nil && record.InputID == "":
			totalCounts = turnCounts
		}
		file := files[record.Path]
		if file == nil {
			file = &AgentSessionPanelFile{Path: record.Path, WorkspacePath: record.WorkspacePath, Origin: record.Origin, Op: record.Op,
				InGitRepo: record.InGitRepo, TurnIDs: []string{turnID}, Bytes: record.Bytes, LineChanges: totalCounts, Diff: record.TotalDiff}
			files[record.Path] = file
		} else {
			if totalCounts != nil {
				file.LineChanges = totalCounts
			}
			if record.TotalDiff != "" {
				file.Diff = record.TotalDiff
			}
			file.Op = mergedFileOp(file.Op, record.Op)
			if record.Origin == "tool" {
				file.Origin = "tool"
			}
			file.InGitRepo = record.InGitRepo
			file.WorkspacePath = cmp.Or(record.WorkspacePath, file.WorkspacePath)
			if record.Bytes != nil {
				file.Bytes = record.Bytes
			}
			if !slices.Contains(file.TurnIDs, turnID) {
				file.TurnIDs = append(file.TurnIDs, turnID)
			}
		}
		if turnCounts != nil {
			if file.TurnLineChanges == nil {
				file.TurnLineChanges = map[string]AgentSessionPanelLineChanges{}
			}
			file.TurnLineChanges[turnID] = *turnCounts
		}
		if record.Diff != "" {
			if file.TurnDiff == nil {
				file.TurnDiff = map[string]string{}
			}
			file.TurnDiff[turnID] = record.Diff
		}
	}
	rows := make([]AgentSessionPanelFile, 0, len(files))
	for _, file := range files {
		rows = append(rows, *file)
	}
	slices.SortFunc(rows, func(left, right AgentSessionPanelFile) int { return strings.Compare(left.Path, right.Path) })
	return rows
}

// mergedFileOp is the op a later turn leaves: a file the session created
// stays created.
func mergedFileOp(earlier, later string) string {
	switch {
	case later == "referenced":
		return earlier
	case later == "deleted" || earlier == "referenced":
		return later
	case earlier == "created":
		return "created"
	}
	return later
}

// derivePreviews are the local addresses the session's runs named, newest
// first, then those its answer names; each once.
func derivePreviews(session AgentSession, events []AgentSessionEvent) []AgentSessionPanelLink {
	links := []AgentSessionPanelLink{}
	seen := map[string]bool{}
	add := func(id, target string) {
		if !seen[target] {
			seen[target] = true
			links = append(links, AgentSessionPanelLink{ID: id, Target: target})
		}
	}
	for index := len(events) - 1; index >= 0; index-- {
		if event := events[index]; isPreview(event, strings.TrimSpace(event.Label)) {
			add(event.ID, previewURLs(event.Detail)[0])
		}
	}
	for index, target := range previewURLs(session.Response) {
		add(session.ID+"_web_"+strconv.Itoa(index), target)
	}
	return links
}

// deriveSources are the workspaces the session loaded, each once.
func deriveSources(events []AgentSessionEvent) []AgentSessionPanelLink {
	links := []AgentSessionPanelLink{}
	seen := map[string]bool{}
	for _, event := range events {
		target := strings.TrimSpace(event.Detail)
		if strings.TrimSpace(event.Label) != ProcessLabelLoadedWorkspace || target == "" || seen[target] {
			continue
		}
		seen[target] = true
		links = append(links, AgentSessionPanelLink{ID: event.ID, Target: target})
	}
	return links
}
