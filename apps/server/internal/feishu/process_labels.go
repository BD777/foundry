package feishu

import "github.com/foundry-dev/foundry/apps/server/internal/store"

// Worker process labels are English protocol values (see the protocol
// package's process-labels.ts); Feishu cards are Chinese, so the labels a
// card shows are translated here.
var chineseProcessLabels = map[string]string{
	store.ProcessLabelSessionFailed:          "执行失败",
	store.ProcessLabelThinking:               "正在思考",
	store.ProcessLabelThought:                "思考完成",
	store.ProcessLabelUsingTool:              "正在使用工具",
	store.ProcessLabelUsedTool:               "已使用工具",
	store.ProcessLabelToolFailed:             "工具执行失败",
	store.ProcessLabelRequestingModel:        "正在请求模型",
	store.ProcessLabelCompactingContext:      "正在压缩上下文",
	store.ProcessLabelModelRetry:             "模型请求重试",
	store.ProcessLabelModelRequestUsage:      "模型请求用量",
	store.ProcessLabelRateLimited:            "模型限流，等待重试",
	store.ProcessLabelStartingSubtask:        "正在启动子任务",
	store.ProcessLabelSubtaskRunning:         "子任务进行中",
	store.ProcessLabelSubtaskCompleted:       "子任务完成",
	store.ProcessLabelSubtaskFailed:          "子任务失败",
	store.ProcessLabelPermissionDenied:       "权限被拒绝",
	store.ProcessLabelNotice:                 "过程提示",
	store.ProcessLabelSearching:              "正在搜索",
	store.ProcessLabelSearched:               "已搜索",
	store.ProcessLabelRunningCommand:         "正在执行命令",
	store.ProcessLabelRanCommand:             "已执行命令",
	store.ProcessLabelEditingFile:            "正在编辑文件",
	store.ProcessLabelEditedFile:             "已编辑文件",
	store.ProcessLabelUpdatedPlan:            "更新计划",
	store.ProcessLabelProcessingStep:         "正在处理步骤",
	store.ProcessLabelProcessedStep:          "已处理步骤",
	store.ProcessLabelCommentary:             "过程",
	store.ProcessLabelWaitingBackgroundTasks: "等待后台任务",
	store.ProcessLabelWaitingForSlot:         "等待执行名额",
	store.ProcessLabelWaitedForSlot:          "已等到执行名额",
	store.ProcessLabelTimerSync:              "定时任务更新",
	store.ProcessLabelTimerFire:              "定时任务触发",
	store.ProcessLabelBackgroundTurn:         "后台任务继续",
	store.ProcessLabelBackgroundTasksSync:    "后台任务更新",
	store.ProcessLabelLoadedWorkspace:        "已加载工作区",
	store.ProcessLabelRecordedFile:           "已记录文件",
	store.ProcessLabelContextCompacted:       "原生会话已压缩上下文。",
	store.ProcessLabelTranscriptTailUnloaded: "本地会话较大，当前仅载入前段记录，后续内容尚未载入。",
}

// cardProcessLabel is a worker label as a Feishu card shows it.
func cardProcessLabel(label string) string {
	if chinese, ok := chineseProcessLabels[label]; ok {
		return chinese
	}
	return label
}

// isThinkingLabel reports whether a worker label marks model reasoning.
func isThinkingLabel(label string) bool {
	return label == store.ProcessLabelThinking || label == store.ProcessLabelThought
}
