package store

import "strings"

// The labels of transcript events and the ids that tie events to inputs.
// They mirror packages/protocol/src/session-events.ts (EventLabel<Key> is
// sessionEventLabels.<key>) and process-labels.ts (ProcessLabel<Key> is
// processLabels.<key>, CompletedProcessLabels is completedProcessLabelKeys);
// scripts/audit-contract.mjs pins the two sides.
const (
	EventLabelUserMessage           = "User message"
	EventLabelSteeredIntoTurn       = "Steered into active turn"
	EventLabelSteerConsumed         = "Steered message read"
	EventLabelResponseStream        = "Response stream"
	EventLabelClaudeTurnEnd         = "Claude Agent SDK finished"
	EventLabelCodexTurnEnd          = "Codex finished"
	EventLabelProfileCommandTurnEnd = "Custom profile command finished"
	EventLabelClaudeProcessStarted  = "Started Claude Agent SDK"
	EventLabelToolFrame             = "Tool frame"
	EventLabelDeviceWait            = "Waiting for device"
	EventLabelWorkerUpdate          = "Worker update in progress"
	EventLabelNativeTranscript      = "Native transcript"
	EventLabelProfileTransition     = "Profile transition"
)

const (
	ProcessLabelSessionFailed          = "Session failed"
	ProcessLabelThinking               = "Thinking"
	ProcessLabelThought                = "Thought"
	ProcessLabelUsingTool              = "Using tool"
	ProcessLabelUsedTool               = "Used tool"
	ProcessLabelToolFailed             = "Tool failed"
	ProcessLabelRequestingModel        = "Requesting model"
	ProcessLabelCompactingContext      = "Compacting context"
	ProcessLabelModelRetry             = "Model request retry"
	ProcessLabelModelRequestUsage      = "Model request usage"
	ProcessLabelRateLimited            = "Rate limited, waiting to retry"
	ProcessLabelStartingSubtask        = "Starting subtask"
	ProcessLabelSubtaskRunning         = "Subtask running"
	ProcessLabelSubtaskCompleted       = "Subtask completed"
	ProcessLabelSubtaskFailed          = "Subtask failed"
	ProcessLabelPermissionDenied       = "Permission denied"
	ProcessLabelNotice                 = "Notice"
	ProcessLabelSearching              = "Searching"
	ProcessLabelSearched               = "Searched"
	ProcessLabelRunningCommand         = "Running command"
	ProcessLabelRanCommand             = "Ran command"
	ProcessLabelEditingFile            = "Editing file"
	ProcessLabelEditedFile             = "Edited file"
	ProcessLabelUpdatedPlan            = "Updated plan"
	ProcessLabelProcessingStep         = "Processing step"
	ProcessLabelProcessedStep          = "Processed step"
	ProcessLabelCommentary             = "Commentary"
	ProcessLabelWaitingBackgroundTasks = "Waiting for background tasks"
	ProcessLabelWaitingForSlot         = "Waiting for a slot"
	ProcessLabelWaitedForSlot          = "Waited for a slot"
	ProcessLabelTimerSync              = "Scheduled tasks updated"
	ProcessLabelTimerFire              = "Scheduled task fired"
	ProcessLabelBackgroundTurn         = "Background task continued"
	ProcessLabelBackgroundTasksSync    = "Background tasks updated"
	ProcessLabelLoadedWorkspace        = "Loaded workspace"
	ProcessLabelRecordedFile           = "Recorded file"
	ProcessLabelContextCompacted       = "The native session compacted its context."
	ProcessLabelTranscriptTailUnloaded = "This local session is large; only its beginning is loaded so far."
)

// CompletedProcessLabels maps an in-progress label to the label its step
// takes once done.
var CompletedProcessLabels = map[string]string{
	ProcessLabelThinking:       ProcessLabelThought,
	ProcessLabelUsingTool:      ProcessLabelUsedTool,
	ProcessLabelSearching:      ProcessLabelSearched,
	ProcessLabelRunningCommand: ProcessLabelRanCommand,
	ProcessLabelEditingFile:    ProcessLabelEditedFile,
	ProcessLabelProcessingStep: ProcessLabelProcessedStep,
	ProcessLabelWaitingForSlot: ProcessLabelWaitedForSlot,
}

// TranscriptHiddenProcessLabels are the labels of events the transcript
// never shows as steps (transcriptHiddenProcessLabelKeys).
var TranscriptHiddenProcessLabels = map[string]bool{
	ProcessLabelStartingSubtask:     true,
	ProcessLabelSubtaskRunning:      true,
	ProcessLabelSubtaskCompleted:    true,
	ProcessLabelSubtaskFailed:       true,
	ProcessLabelTimerSync:           true,
	ProcessLabelBackgroundTasksSync: true,
	ProcessLabelRecordedFile:        true,
	ProcessLabelModelRequestUsage:   true,
	ProcessLabelLoadedWorkspace:     true,
}

// HeartbeatProcessLabels are the status heartbeats the transcript shows
// once when one repeats the step before it (heartbeatProcessLabelKeys).
var HeartbeatProcessLabels = map[string]bool{
	ProcessLabelRequestingModel:   true,
	ProcessLabelCompactingContext: true,
}

// IsTurnEndLabel reports a turn-end event's label (isTurnEndLabel).
func IsTurnEndLabel(label string) bool {
	switch strings.TrimSpace(label) {
	case EventLabelClaudeTurnEnd, EventLabelCodexTurnEnd, EventLabelProfileCommandTurnEnd:
		return true
	}
	return false
}

const eventIDPrefix = "evt_"

// SessionInputEventID is the id of the event a session input writes; a
// message steered into a running turn records its event under the same id
// (sessionInputEventId).
func SessionInputEventID(inputID string) string {
	return eventIDPrefix + inputID
}

// SessionInputIDOfEvent is the input an input's event id names
// (sessionInputIdOfEvent); false for any other id.
func SessionInputIDOfEvent(eventID string) (string, bool) {
	inputID, ok := strings.CutPrefix(eventID, eventIDPrefix)
	return inputID, ok && inputID != ""
}
