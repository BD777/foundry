package httpapi

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/sessionprogress"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// What a child's report carries beside its answer: facts from Foundry's log
// of the turn, so its parent sees what the turn did, not only what it said.
// They are the files its tools wrote, the tool calls it made with how each
// ended and how long it ran, and the background commands it started with
// their exit codes, each list short and naming the read_context scope that
// has all of it. Which part of the answer the facts bear out is the
// parent's to judge.

const (
	// childFactsEventWindow is how many of the child's newest events the
	// facts are read from.
	childFactsEventWindow = 2000
	childFactsFileCount   = 8
	// childFactsFailedCount failed calls are listed, then the newest
	// childFactsCallCount others.
	childFactsFailedCount = 3
	childFactsCallCount   = 3
	childFactsTaskCount   = 3
	childFactsLineLimit   = 160
)

// childTurnFacts is the facts block of the child's report, "" when the turn
// recorded nothing to state.
func (s *Server) childTurnFacts(ctx context.Context, child store.AgentSession) string {
	started, err := time.Parse(time.RFC3339Nano, child.Input.At)
	if err != nil {
		return ""
	}
	events, _, err := s.store.AgentSessionEventWindow(ctx, child.ID, "", childFactsEventWindow)
	if err != nil {
		return ""
	}
	partial := len(events) == childFactsEventWindow
	turn := events[:0:0]
	for _, event := range events {
		if at, err := time.Parse(time.RFC3339Nano, event.At); err == nil && !at.Before(started) {
			turn = append(turn, event)
		}
	}
	partial = partial && len(turn) == len(events)
	var builder strings.Builder
	writeTurnFiles(&builder, child, events)
	writeTurnCalls(&builder, child, sessionprogress.ToolCalls(turn))
	writeTurnTasks(&builder, turn, started)
	if builder.Len() == 0 {
		return ""
	}
	heading := "\nFrom Foundry's log of this turn:\n"
	if partial {
		heading = fmt.Sprintf("\nFrom Foundry's log of this turn (its newest %d events):\n", childFactsEventWindow)
	}
	return heading + builder.String()
}

// writeTurnFiles states the files the turn's tools wrote: the session-file
// records of its input, merged per path as scope=changes merges them.
func writeTurnFiles(builder *strings.Builder, child store.AgentSession, events []store.AgentSessionEvent) {
	type turnFile struct {
		path, change   string
		added, removed *int
	}
	var files []turnFile
	index := map[string]int{}
	for _, event := range events {
		record := (*store.SessionFileRecord)(nil)
		if event.Metadata != nil {
			record = event.Metadata.SessionFile
		}
		if record == nil || record.Path == "" || record.InputID != child.Input.ID || record.Origin == "reference" || record.Op == "referenced" {
			continue
		}
		at, known := index[record.Path]
		if !known {
			index[record.Path] = len(files)
			files = append(files, turnFile{path: record.Path, change: record.Op})
			at = len(files) - 1
		}
		file := &files[at]
		file.change = mergedFileChange(file.change, record.Op)
		if record.Added != nil && record.Removed != nil {
			file.added, file.removed = record.Added, record.Removed
		}
		if record.WorkspacePath != "" {
			file.path = record.WorkspacePath
		}
	}
	if len(files) == 0 {
		return
	}
	slices.SortFunc(files, func(a, b turnFile) int { return strings.Compare(a.path, b.path) })
	fmt.Fprintf(builder, "Files its tools wrote: %d", len(files))
	if len(files) > childFactsFileCount {
		fmt.Fprintf(builder, " (the first %d; read_context scope=changes on %s lists all)", childFactsFileCount, child.ID)
	}
	builder.WriteString("\n")
	for _, file := range files[:min(len(files), childFactsFileCount)] {
		line := file.change + " " + file.path
		if file.added != nil {
			line += fmt.Sprintf(" +%d -%d", *file.added, *file.removed)
		}
		fmt.Fprintf(builder, "- %s\n", textcut.Excerpt(line, childFactsLineLimit))
	}
	fmt.Fprintf(builder, "read_context scope=changes on %s with path and inputId=%s reads one file's diff of this turn.\n", child.ID, child.Input.ID)
}

// writeTurnCalls states the turn's tool calls: how many and how many
// failed, the failed ones, and the newest others.
func writeTurnCalls(builder *strings.Builder, child store.AgentSession, calls []sessionprogress.ToolCall) {
	if len(calls) == 0 {
		return
	}
	var failed, shown []int
	for index, call := range calls {
		if call.Status == "failed" {
			failed = append(failed, index)
		}
	}
	shown = append(shown, failed[:min(len(failed), childFactsFailedCount)]...)
	for index, others := len(calls)-1, 0; index >= 0 && others < childFactsCallCount; index-- {
		if calls[index].Status != "failed" {
			shown = append(shown, index)
			others++
		}
	}
	slices.Sort(shown)
	fmt.Fprintf(builder, "Tool calls: %d, %d failed (read_context scope=progress on %s pages them all, at most %d a page); status, duration, tool: detail\n",
		len(calls), len(failed), child.ID, progressMaxCalls)
	for _, index := range shown {
		call := calls[index]
		duration := "-"
		if call.DurationMs != nil {
			duration = (time.Duration(*call.DurationMs) * time.Millisecond).Round(100 * time.Millisecond).String()
		}
		line := fmt.Sprintf("%s %s %s", call.Status, duration, call.Tool)
		if call.Detail != "" {
			line += ": " + oneLine(call.Detail, childFactsLineLimit)
		}
		fmt.Fprintf(builder, "- %s\n", textcut.Excerpt(line, childFactsLineLimit))
	}
}

// writeTurnTasks states the background commands the turn started, from
// the newest snapshot of them: how each ended and its exit code.
func writeTurnTasks(builder *strings.Builder, turn []store.AgentSessionEvent, started time.Time) {
	var tasks []store.AgentBackgroundTask
	for index := len(turn) - 1; index >= 0; index-- {
		if metadata := turn[index].Metadata; metadata != nil && metadata.BackgroundTaskSnapshot != nil {
			for _, task := range *metadata.BackgroundTaskSnapshot {
				if at, err := time.Parse(time.RFC3339Nano, task.StartedAt); err == nil && !at.Before(started) {
					tasks = append(tasks, task)
				}
			}
			break
		}
	}
	if len(tasks) == 0 {
		return
	}
	fmt.Fprintf(builder, "Background commands it started: %d\n", len(tasks))
	for _, task := range tasks[max(len(tasks)-childFactsTaskCount, 0):] {
		line := task.Status
		if task.ExitCode != nil {
			line += fmt.Sprintf(" exit %d", *task.ExitCode)
		}
		line += " " + task.Kind + ": " + oneLine(task.Description, childFactsLineLimit)
		fmt.Fprintf(builder, "- %s %s\n", task.ID, textcut.Excerpt(line, childFactsLineLimit))
	}
}
