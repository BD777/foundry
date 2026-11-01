/**
 * Labels a worker gives the events and process rows it records. They are
 * protocol values, stored with the transcript and compared by readers; the
 * web translates them for display.
 */
export const processLabels = {
  sessionFailed: "Session failed",
  thinking: "Thinking",
  thought: "Thought",
  usingTool: "Using tool",
  usedTool: "Used tool",
  toolFailed: "Tool failed",
  requestingModel: "Requesting model",
  compactingContext: "Compacting context",
  modelRetry: "Model request retry",
  modelRequestUsage: "Model request usage",
  rateLimited: "Rate limited, waiting to retry",
  startingSubtask: "Starting subtask",
  subtaskRunning: "Subtask running",
  subtaskCompleted: "Subtask completed",
  subtaskFailed: "Subtask failed",
  permissionDenied: "Permission denied",
  notice: "Notice",
  searching: "Searching",
  searched: "Searched",
  runningCommand: "Running command",
  ranCommand: "Ran command",
  editingFile: "Editing file",
  editedFile: "Edited file",
  updatedPlan: "Updated plan",
  processingStep: "Processing step",
  processedStep: "Processed step",
  commentary: "Commentary",
  waitingBackgroundTasks: "Waiting for background tasks",
  waitingForSlot: "Waiting for a slot",
  waitedForSlot: "Waited for a slot",
  timerSync: "Scheduled tasks updated",
  timerFire: "Scheduled task fired",
  backgroundTurn: "Background task continued",
  backgroundTasksSync: "Background tasks updated",
  loadedWorkspace: "Loaded workspace",
  recordedFile: "Recorded file",
  contextCompacted: "The native session compacted its context.",
  transcriptTailUnloaded:
    "This local session is large; only its beginning is loaded so far.",
} as const;

export type ProcessLabelKey = keyof typeof processLabels;

/**
 * The event a worker records when it starts a Claude process for a session.
 * A process that resumes a session brings its timers back as fired then
 * (see claudeTimerNextFire).
 */
export const claudeProcessStartedLabel = "Started Claude Agent SDK";

const keyByLabel = new Map<string, ProcessLabelKey>(
  (Object.entries(processLabels) as Array<[ProcessLabelKey, string]>).map(
    ([key, label]) => [label, key],
  ),
);

/** The label's key; undefined for any other text. */
export function processLabelKey(
  label: string | undefined,
): ProcessLabelKey | undefined {
  return label === undefined ? undefined : keyByLabel.get(label.trim());
}

/** Whether a label is one of the given labels. */
export function isProcessLabel(
  label: string | undefined,
  ...keys: ProcessLabelKey[]
): boolean {
  const key = processLabelKey(label);
  return key !== undefined && keys.includes(key);
}

/** In-progress labels and the label each becomes once the step is done. */
export const completedProcessLabelKeys: Partial<
  Record<ProcessLabelKey, ProcessLabelKey>
> = {
  thinking: "thought",
  usingTool: "usedTool",
  searching: "searched",
  runningCommand: "ranCommand",
  editingFile: "editedFile",
  processingStep: "processedStep",
  waitingForSlot: "waitedForSlot",
};

/**
 * Fixed sentences a worker records as an event's detail. Like labels they
 * are protocol values the web translates. Details with interpolated parts
 * (retry attempts, open background tasks) are not in this set.
 */
export const processDetails = {
  claudeGenerating: "Claude is generating a response.",
  claudeCompacting: "Claude is compacting the conversation context.",
  claudeProcessing: "Claude is processing the request.",
  claudeThinking: "Claude is thinking.",
  modelProcessing: "The model is processing the request.",
  modelThinking: "The model is thinking.",
} as const;

export type ProcessDetailKey = keyof typeof processDetails;

const keyByDetail = new Map<string, ProcessDetailKey>(
  (Object.entries(processDetails) as Array<[ProcessDetailKey, string]>).map(
    ([key, detail]) => [detail, key],
  ),
);

/** The detail's key when it is exactly a known fixed sentence. */
export function processDetailKey(
  detail: string | undefined,
): ProcessDetailKey | undefined {
  return detail === undefined ? undefined : keyByDetail.get(detail.trim());
}
