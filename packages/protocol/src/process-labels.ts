/**
 * Labels a worker gives the events and process rows it records. They are
 * protocol values, stored with the transcript and compared by readers; the
 * web translates them for display. Workers before 0.5.2 wrote the Chinese
 * values in `legacyProcessLabels`, which readers still accept.
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
  timerSync: "Scheduled tasks updated",
  timerFire: "Scheduled task fired",
  backgroundTurn: "Background task continued",
  loadedWorkspace: "Loaded workspace",
  contextCompacted: "The native session compacted its context.",
  transcriptTailUnloaded:
    "This local session is large; only its beginning is loaded so far.",
} as const;

export type ProcessLabelKey = keyof typeof processLabels;

/** What workers before 0.5.2 wrote for the same labels. */
export const legacyProcessLabels: Partial<
  Record<ProcessLabelKey, readonly string[]>
> = {
  sessionFailed: ["执行失败"],
  thinking: ["正在思考"],
  thought: ["思考完成"],
  usingTool: ["正在使用工具"],
  usedTool: ["已使用工具"],
  toolFailed: ["工具执行失败"],
  requestingModel: ["正在请求模型"],
  compactingContext: ["正在压缩上下文"],
  modelRetry: ["模型请求重试"],
  rateLimited: ["模型限流，等待重试"],
  startingSubtask: ["正在启动子任务"],
  subtaskRunning: ["子任务进行中"],
  subtaskCompleted: ["子任务完成"],
  subtaskFailed: ["子任务失败"],
  permissionDenied: ["权限被拒绝"],
  notice: ["过程提示"],
  searching: ["正在搜索"],
  searched: ["已搜索"],
  runningCommand: ["正在执行命令"],
  ranCommand: ["已执行命令"],
  editingFile: ["正在编辑文件"],
  editedFile: ["已编辑文件"],
  updatedPlan: ["更新计划"],
  processingStep: ["正在处理步骤"],
  processedStep: ["已处理步骤"],
  commentary: ["过程"],
  waitingBackgroundTasks: ["等待后台任务"],
  timerSync: ["定时任务更新"],
  timerFire: ["定时任务触发"],
  backgroundTurn: ["后台任务继续"],
  loadedWorkspace: ["已加载工作区"],
  contextCompacted: ["原生会话已压缩上下文。"],
  transcriptTailUnloaded: [
    "本地会话较大，当前仅载入前段记录，后续内容尚未载入。",
  ],
};

const keyByLabel = new Map<string, ProcessLabelKey>();
for (const [key, label] of Object.entries(processLabels) as Array<
  [ProcessLabelKey, string]
>) {
  keyByLabel.set(label, key);
  for (const legacy of legacyProcessLabels[key] ?? [])
    keyByLabel.set(legacy, key);
}

/** The label's key, for current or legacy values; undefined for any other text. */
export function processLabelKey(
  label: string | undefined,
): ProcessLabelKey | undefined {
  return label === undefined ? undefined : keyByLabel.get(label.trim());
}

/** Whether a label is one of the given labels, current or legacy. */
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
};

/**
 * Fixed sentences a worker records as an event's detail. Like labels they
 * are protocol values the web translates; workers before 0.5.2 wrote the
 * Chinese values in `legacyProcessDetails`. Details with interpolated parts
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

export const legacyProcessDetails: Record<ProcessDetailKey, readonly string[]> =
  {
    claudeGenerating: ["Claude 正在生成响应。"],
    claudeCompacting: ["Claude 正在整理会话上下文。"],
    claudeProcessing: ["Claude 正在处理请求。"],
    claudeThinking: ["Claude 正在整理思路。"],
    modelProcessing: ["模型正在处理请求。"],
    modelThinking: ["模型正在整理思路。"],
  };

const keyByDetail = new Map<string, ProcessDetailKey>();
for (const [key, detail] of Object.entries(processDetails) as Array<
  [ProcessDetailKey, string]
>) {
  keyByDetail.set(detail, key);
  for (const legacy of legacyProcessDetails[key]) keyByDetail.set(legacy, key);
}

/** The detail's key when it is exactly a known fixed sentence. */
export function processDetailKey(
  detail: string | undefined,
): ProcessDetailKey | undefined {
  return detail === undefined ? undefined : keyByDetail.get(detail.trim());
}
