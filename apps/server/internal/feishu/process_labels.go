package feishu

// Worker process labels are English protocol values (see the protocol
// package's process-labels.ts); Feishu cards are Chinese, so the labels a
// card shows are translated here. Older workers already wrote Chinese.
var chineseProcessLabels = map[string]string{
	"Session failed":                 "执行失败",
	"Thinking":                       "正在思考",
	"Thought":                        "思考完成",
	"Using tool":                     "正在使用工具",
	"Used tool":                      "已使用工具",
	"Tool failed":                    "工具执行失败",
	"Requesting model":               "正在请求模型",
	"Compacting context":             "正在压缩上下文",
	"Model request retry":            "模型请求重试",
	"Model request usage":            "模型请求用量",
	"Rate limited, waiting to retry": "模型限流，等待重试",
	"Starting subtask":               "正在启动子任务",
	"Subtask running":                "子任务进行中",
	"Subtask completed":              "子任务完成",
	"Subtask failed":                 "子任务失败",
	"Permission denied":              "权限被拒绝",
	"Notice":                         "过程提示",
	"Searching":                      "正在搜索",
	"Searched":                       "已搜索",
	"Running command":                "正在执行命令",
	"Ran command":                    "已执行命令",
	"Editing file":                   "正在编辑文件",
	"Edited file":                    "已编辑文件",
	"Updated plan":                   "更新计划",
	"Processing step":                "正在处理步骤",
	"Processed step":                 "已处理步骤",
	"Commentary":                     "过程",
	"Waiting for background tasks":   "等待后台任务",
	"Scheduled tasks updated":        "定时任务更新",
	"Scheduled task fired":           "定时任务触发",
	"Background task continued":      "后台任务继续",
	"Background tasks updated":       "后台任务更新",
	"Loaded workspace":               "已加载工作区",
	"Recorded file":                  "已记录文件",
	"The native session compacted its context.":                         "原生会话已压缩上下文。",
	"This local session is large; only its beginning is loaded so far.": "本地会话较大，当前仅载入前段记录，后续内容尚未载入。",
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
	switch cardProcessLabel(label) {
	case "正在思考", "思考完成":
		return true
	}
	return false
}
