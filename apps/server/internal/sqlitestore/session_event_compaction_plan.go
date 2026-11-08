package sqlitestore

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// What a turn's compaction removes, decided on its events alone. Each rule
// names the web transcript code it follows; the rules are conservative: a
// row stays whenever the transcript might read it differently. The events
// the side panel reads stay whatever these rules say (compactTurn).

// planTurnCompaction marks the turn's removable events (turn[0] is its
// input) and gives the steps they leave the usage those carried.
func planTurnCompaction(turn []*compactionRow) {
	foldRequestUsage(turn)
	dropContextReports(turn)
	dropSupersededSteps(turn)
}

// transparent is an event the transcript reads nothing from where it
// stands: it adds no step, holds back or releases no answer, and gives no
// step usage (sessionTranscriptEntries). It may still feed the side
// panel, which reads it wherever it is.
func transparent(event store.AgentSessionEvent) bool {
	if event.Message != nil || event.Label == store.EventLabelResponseStream {
		return false
	}
	if m := event.Metadata; m != nil {
		if m.TurnUsage != nil || m.RequestUsage != nil || m.ToolFrame != nil || len(m.FileReferences) > 0 ||
			m.TimerFire != nil || (m.ContextUsage != nil && m.ContextUsage.Compaction != nil) {
			return false
		}
		if m.ContextUsage != nil || m.SessionFile != nil || m.TimerSnapshot != nil || m.GoalSnapshot != nil || m.BackgroundTaskSnapshot != nil {
			return true
		}
	}
	label := strings.TrimSpace(event.Label)
	return store.TranscriptHiddenProcessLabels[label] || (event.Level == "info" && store.IsTurnEndLabel(label))
}

// entryMetadataOnly reports metadata that leaves a message event a step
// of its own in the transcript: none of what makes the web read the event
// as something else (usage, files, frames, a timer's fire). With
// timerFire allowed, an input that a timer fired still starts its turn.
func entryMetadataOnly(metadata *store.AgentSessionEventMetadata, timerFire bool) bool {
	if metadata == nil {
		return true
	}
	return metadata.TurnUsage == nil && len(metadata.FileReferences) == 0 && metadata.ContextUsage == nil &&
		metadata.SessionFile == nil && metadata.ToolFrame == nil && metadata.RequestUsage == nil &&
		(timerFire || metadata.TimerFire == nil)
}

// transcriptStep is a message event the web adds as a step of its own (an
// answer it holds back until the next step instead).
func transcriptStep(event store.AgentSessionEvent) bool {
	return event.Message != nil && event.Message.Kind != "assistant" && entryMetadataOnly(event.Metadata, false)
}

// processStep is a step a process group shows (transcript-projection.ts,
// processKinds): a new row for every event, unlike commentary.
func processStep(event store.AgentSessionEvent) bool {
	if !transcriptStep(event) {
		return false
	}
	switch event.Message.Kind {
	case "reasoning", "tool", "context", "status":
		return true
	}
	return false
}

// answerEvent is an answer the web holds back until the next step.
func answerEvent(event store.AgentSessionEvent) bool {
	if event.Message != nil {
		return event.Message.Kind == "assistant"
	}
	return event.Label == store.EventLabelResponseStream
}

// requestUsageReport is a model request's usage report and nothing else.
func requestUsageReport(event store.AgentSessionEvent) bool {
	return event.Message == nil && metadataHolds(event.Metadata, "requestUsage")
}

// contextReport is a context usage report, not a compaction, and nothing
// else.
func contextReport(event store.AgentSessionEvent) bool {
	return event.Message == nil && metadataHolds(event.Metadata, "contextUsage") && event.Metadata.ContextUsage.Compaction == nil
}

// backgroundSnapshotOnly is a background task snapshot and nothing else.
func backgroundSnapshotOnly(event store.AgentSessionEvent) bool {
	return event.Message == nil && metadataHolds(event.Metadata, "backgroundTaskSnapshot")
}

// metadataHolds reports metadata holding exactly the given fields (by
// their JSON names).
func metadataHolds(metadata *store.AgentSessionEventMetadata, fields ...string) bool {
	if metadata == nil {
		return false
	}
	held := jsonFields(metadata)
	if len(held) != len(fields) {
		return false
	}
	for _, field := range fields {
		if !held[field] {
			return false
		}
	}
	return true
}

// jsonFields are the fields value encodes (those not left out as empty).
func jsonFields(value any) map[string]bool {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(encoded, &fields) != nil {
		return nil
	}
	held := make(map[string]bool, len(fields))
	for field := range fields {
		held[field] = true
	}
	return held
}

// foldRequestUsage removes the usage reports of model requests whose
// tokens their steps can carry instead (transcript-adapters.ts,
// applyRequestUsage). The web gives a report's tokens to every step before
// it that names its request, the report's prompt counts replacing the step's
// (laterRequestUsage); when none does, and no answer is held back, to the
// latest step if that is a process step without usage of its own. Other reports stay.
func foldRequestUsage(turn []*compactionRow) {
	named := map[string][]*compactionRow{}
	requests := map[string]bool{}
	for index, row := range turn {
		event := row.event
		if event.Message != nil && event.Message.RequestUsage != nil {
			requests[event.Message.RequestUsage.RequestID] = true
		}
		if transcriptStep(event) && event.Message.RequestUsage != nil {
			id := event.Message.RequestUsage.RequestID
			named[id] = append(named[id], row)
			continue
		}
		if !requestUsageReport(event) {
			continue
		}
		usage := *event.Metadata.RequestUsage
		if steps := named[usage.RequestID]; len(steps) > 0 {
			for _, step := range steps {
				step.setRequestUsage(laterRequestUsage(*step.event.Message.RequestUsage, usage))
			}
			row.removed = true
			continue
		}
		// No entry names the request (an answer that did is not a step
		// here, so any message naming it keeps the report).
		if requests[usage.RequestID] {
			continue
		}
		latest := latestBefore(turn, index)
		if latest == nil || !processStep(latest.event) || latest.event.Message.RequestUsage != nil {
			continue
		}
		latest.setRequestUsage(usage)
		named[usage.RequestID] = append(named[usage.RequestID], latest)
		row.removed = true
	}
}

// latestBefore is the event the web read last before turn[index], past
// transparent ones and those removed; nil at the turn's start.
func latestBefore(turn []*compactionRow, index int) *compactionRow {
	for index--; index > 0; index-- {
		if row := turn[index]; !row.removed && !transparent(row.event) {
			return row
		}
	}
	return nil
}

func (row *compactionRow) setRequestUsage(usage store.ModelRequestUsage) {
	if held := row.event.Message.RequestUsage; held != nil && *held == usage {
		return
	}
	message := *row.event.Message
	message.RequestUsage = &usage
	row.event.Message = &message
	row.changed = true
}

// laterRequestUsage is the web's merge of two reports of one request,
// later reported after earlier (transcript-projection.ts,
// laterRequestUsage): the later prompt counts replace the earlier ones, which
// repeat what the request's start estimated; output only grows.
func laterRequestUsage(earlier, later store.ModelRequestUsage) store.ModelRequestUsage {
	later.OutputTokens = max(earlier.OutputTokens, later.OutputTokens)
	return later
}

// dropContextReports removes the turn's context reports but those the
// transcript takes something from (transcript-adapters.ts): the first with
// a token count at the turn's start and after each compaction (a compaction
// that did not say what it left takes that count, in this turn or a later
// one).
func dropContextReports(turn []*compactionRow) {
	keep := map[int]bool{}
	resolve := true
	for index, row := range turn {
		var usage *store.AgentContextUsage
		if row.event.Metadata != nil {
			usage = row.event.Metadata.ContextUsage
		}
		switch {
		case usage == nil:
		case usage.Compaction != nil:
			resolve = true
		case resolve && usage.InputTokens != nil && *usage.InputTokens != 0:
			keep[index] = true
			resolve = false
		}
	}
	for index, row := range turn {
		if !keep[index] && contextReport(row.event) {
			row.removed = true
		}
	}
}

// dropSupersededSteps removes a step's earlier snapshot E where its next
// snapshot N (same message id and kind) shows in its place: the web
// merges both into N's row (chat-process-display.ts, processDisplayRows;
// commentary updates in place) and nothing it shows lies between them, so
// the step keeps its place, its process group and the group's start. N
// takes any request usage E named.
func dropSupersededSteps(turn []*compactionRow) {
	next := make([]int, len(turn))
	lastOf := map[string]int{}
	callItems := map[string]map[string]bool{}
	for index := len(turn) - 1; index >= 0; index-- {
		next[index] = -1
		event := turn[index].event
		if turn[index].removed || !transcriptStep(event) || event.Message.ID == "" {
			continue
		}
		if later, ok := lastOf[event.Message.ID]; ok {
			next[index] = later
		}
		lastOf[event.Message.ID] = index
		if callID := event.Message.CallID; callID != "" {
			if callItems[callID] == nil {
				callItems[callID] = map[string]bool{}
			}
			callItems[callID][event.Message.ID] = true
		}
	}
	// latest is the latest time any message before index carries: a
	// group's start is its first step's time unless the message before it
	// is later (transcript-projection.ts, projectTranscript). Commentary
	// and answers stand where they began with the time of their last
	// snapshot (sessionTranscriptEntries, normalizeAgentEvents).
	finalAt := map[string]time.Time{}
	for _, row := range turn {
		if key := mergedKey(row.event); key != "" {
			finalAt[key] = laterTime(finalAt[key], row.event)
		}
	}
	latest := make([]time.Time, len(turn))
	var seen time.Time
	for index, row := range turn {
		latest[index] = seen
		seen = laterTime(seen, row.event)
		if key := mergedKey(row.event); key != "" && finalAt[key].After(seen) {
			seen = finalAt[key]
		}
	}
	for index, e := range turn {
		if next[index] < 0 {
			continue
		}
		n := turn[next[index]]
		if !supersedes(e.event, n.event, callItems) || !allTransparent(turn[index+1:next[index]]) {
			continue
		}
		// Commentary stands where its first snapshot stood, with its last
		// one's time; a process step that starts its group sets the
		// group's start.
		if processStep(e.event) && startsGroup(turn, index) {
			eAt, eErr := time.Parse(time.RFC3339Nano, entryAt(e.event))
			nAt, nErr := time.Parse(time.RFC3339Nano, entryAt(n.event))
			if eErr != nil || nErr != nil || eAt.Before(latest[index]) || nAt.Before(eAt) {
				continue
			}
		}
		if usage := e.event.Message.RequestUsage; usage != nil {
			switch held := n.event.Message.RequestUsage; {
			case held != nil && held.RequestID == usage.RequestID:
				n.setRequestUsage(laterRequestUsage(*usage, *held))
			case held == nil && !usageMayFallTo(turn, next[index]):
				n.setRequestUsage(*usage)
			default:
				continue
			}
		}
		e.removed = true
	}
}

// startsGroup reports whether turn[index] may be the first step of its
// process group: no process step that stays comes right before it, past
// what the transcript does not read.
func startsGroup(turn []*compactionRow, index int) bool {
	for index--; index >= 0; index-- {
		row := turn[index]
		switch {
		case row.removed, transparent(row.event):
		case processStep(row.event):
			return false
		default:
			return true
		}
	}
	return true
}

// usageMayFallTo reports whether a usage report no step names could reach
// turn[index] as the latest step (foldRequestUsage): one that stays after
// it before the next step or answer, or the turn ends first.
func usageMayFallTo(turn []*compactionRow, index int) bool {
	for _, row := range turn[index+1:] {
		switch {
		case row.removed:
		case requestUsageReport(row.event):
			return true
		case transcriptStep(row.event), answerEvent(row.event):
			return false
		}
	}
	return true
}

// supersedes reports a snapshot n that the web shows in e's place. A
// snapshot with an in-progress label (store.CompletedProcessLabels) is
// read by nothing once the turn ended; readers of other labels (a
// failure's, a loaded workspace's) find the last snapshot only if it has
// e's label.
func supersedes(e, n store.AgentSessionEvent, callItems map[string]map[string]bool) bool {
	em, nm := e.Message, n.Message
	if e.Metadata != nil || n.Metadata != nil || em.Kind != nm.Kind || e.Level != n.Level ||
		(e.Label != n.Label && store.CompletedProcessLabels[e.Label] == "") || store.SessionStateKey(e) != "" ||
		store.HeartbeatProcessLabels[strings.TrimSpace(em.Title)] || store.HeartbeatProcessLabels[strings.TrimSpace(nm.Title)] {
		return false
	}
	switch em.Kind {
	case "commentary":
		// The web updates the step in place, keeping whatever field only
		// the earlier snapshot had, and finds it by the request it named.
		if em.RequestUsage != nil && (nm.RequestUsage == nil || nm.RequestUsage.RequestID != em.RequestUsage.RequestID) {
			return false
		}
		later := jsonFields(nm)
		for field := range jsonFields(em) {
			if !later[field] {
				return false
			}
		}
		return true
	case "reasoning", "tool", "context", "status":
	default:
		return false
	}
	// A process row merges the steps of one call, or of one item with a
	// status. A call another item also reports shows both items' details.
	if em.CallID != "" || nm.CallID != "" {
		return em.CallID == nm.CallID && len(callItems[em.CallID]) == 1
	}
	return em.Status != "" && nm.Status != ""
}

func allTransparent(rows []*compactionRow) bool {
	for _, row := range rows {
		if !row.removed && !transparent(row.event) {
			return false
		}
	}
	return true
}

// mergedKey names the item whose snapshots the web shows as one, where
// the first stands, with the last one's time: commentary and answers by
// message id, and (with legacy streams continuing whichever came first)
// every answer without a message as one.
func mergedKey(event store.AgentSessionEvent) string {
	switch {
	case event.Message != nil && (event.Message.Kind == "commentary" || event.Message.Kind == "assistant"):
		return event.Message.Kind + ":" + event.Message.ID
	case event.Message == nil && event.Label == store.EventLabelResponseStream:
		return "stream"
	}
	return ""
}

// laterTime is the later of seen and the times event carries.
func laterTime(seen time.Time, event store.AgentSessionEvent) time.Time {
	for _, value := range []string{event.At, messageAt(event)} {
		if at, err := time.Parse(time.RFC3339Nano, value); err == nil && at.After(seen) {
			seen = at
		}
	}
	return seen
}

// entryAt is the time the web gives a step: its message's, else the
// event's.
func entryAt(event store.AgentSessionEvent) string {
	if at := messageAt(event); at != "" {
		return at
	}
	return event.At
}

func messageAt(event store.AgentSessionEvent) string {
	if event.Message != nil {
		return event.Message.At
	}
	return ""
}
