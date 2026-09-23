package feishu

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

type CardConfig struct {
	WideScreenMode bool `json:"wide_screen_mode,omitempty"`
	UpdateMulti    bool `json:"update_multi,omitempty"`
}

type CardTitle struct {
	Tag     string `json:"tag"`
	Content string `json:"content"`
}

type CardHeader struct {
	Title    CardTitle `json:"title"`
	Template string    `json:"template"`
}

type CardBody struct {
	Elements []CardElement `json:"elements"`
}

type CardElement interface{}

type MarkdownElement struct {
	Tag     string `json:"tag"`
	Content string `json:"content"`
}

type HrElement struct {
	Tag string `json:"tag"`
}

type FeishuCard struct {
	Schema string     `json:"schema"` // "2.0"
	Config CardConfig `json:"config"`
	Header CardHeader `json:"header"`
	Body   CardBody   `json:"body"`
}

var headingFixRegex = regexp.MustCompile(`^(#{1,6})([^#\s].*)$`)

// NormalizeFeishuMarkdown optimizes Markdown syntax for Feishu Card 2.0 rendering.
// It ensures proper paragraph breaks before/after tables and headings so they render cleanly.
func NormalizeFeishuMarkdown(content string) string {
	if content == "" {
		return ""
	}
	lines := strings.Split(content, "\n")
	var result []string
	inCodeBlock := false
	inTable := false

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		if strings.HasPrefix(trimmed, "```") {
			inCodeBlock = !inCodeBlock
			inTable = false
			result = append(result, line)
			continue
		}

		if inCodeBlock {
			result = append(result, line)
			continue
		}

		// Normalize "#heading" -> "# heading" if missing space
		if matches := headingFixRegex.FindStringSubmatch(trimmed); len(matches) == 3 {
			trimmed = matches[1] + " " + matches[2]
			line = trimmed
		}

		isTableLine := strings.HasPrefix(trimmed, "|") && strings.HasSuffix(trimmed, "|")
		isHeading := strings.HasPrefix(trimmed, "# ") ||
			strings.HasPrefix(trimmed, "## ") ||
			strings.HasPrefix(trimmed, "### ") ||
			strings.HasPrefix(trimmed, "#### ") ||
			strings.HasPrefix(trimmed, "##### ") ||
			strings.HasPrefix(trimmed, "###### ")

		// Table start: ensure blank line before
		if isTableLine && !inTable {
			if len(result) > 0 && strings.TrimSpace(result[len(result)-1]) != "" {
				result = append(result, "")
			}
			inTable = true
		} else if !isTableLine && inTable {
			// Table end: ensure blank line after
			if trimmed != "" && len(result) > 0 && strings.TrimSpace(result[len(result)-1]) != "" {
				result = append(result, "")
			}
			inTable = false
		}

		// Heading: ensure blank line before
		if isHeading {
			if len(result) > 0 && strings.TrimSpace(result[len(result)-1]) != "" {
				result = append(result, "")
			}
		}

		result = append(result, line)
	}

	return strings.Join(result, "\n")
}

func BuildRunningCard(title, markdownContent, statusTip string) string {
	if title == "" {
		title = "Foundry Agent"
	}
	if markdownContent == "" {
		markdownContent = "正在理解任务并生成回答..."
	}
	if statusTip == "" {
		statusTip = "处理中..."
	}

	card := FeishuCard{
		Schema: "2.0",
		Config: CardConfig{WideScreenMode: true, UpdateMulti: true},
		Header: CardHeader{
			Title:    CardTitle{Tag: "plain_text", Content: fmt.Sprintf("%s · %s", title, statusTip)},
			Template: "blue",
		},
		Body: CardBody{
			Elements: []CardElement{
				MarkdownElement{Tag: "markdown", Content: NormalizeFeishuMarkdown(markdownContent)},
				HrElement{Tag: "hr"},
				MarkdownElement{
					Tag:     "markdown",
					Content: fmt.Sprintf("<font color='grey'>⚡ Foundry 智能体正在执行 · %s</font>", statusTip),
				},
			},
		},
	}
	data, _ := json.Marshal(card)
	return string(data)
}

func BuildCompletedCard(title, markdownContent string, duration time.Duration) string {
	if title == "" {
		title = "Foundry Agent"
	}
	if markdownContent == "" {
		markdownContent = "(任务已完成，无额外输出)"
	}

	durationStr := duration.Round(time.Millisecond * 100).String()
	card := FeishuCard{
		Schema: "2.0",
		Config: CardConfig{WideScreenMode: true, UpdateMulti: true},
		Header: CardHeader{
			Title:    CardTitle{Tag: "plain_text", Content: fmt.Sprintf("%s · 已完成", title)},
			Template: "turquoise",
		},
		Body: CardBody{
			Elements: []CardElement{
				MarkdownElement{Tag: "markdown", Content: NormalizeFeishuMarkdown(markdownContent)},
				HrElement{Tag: "hr"},
				MarkdownElement{
					Tag:     "markdown",
					Content: fmt.Sprintf("<font color='grey'>✅ 执行完毕 · 耗时 %s · 回复本话题可直接继续追问（无需再次 @）</font>", durationStr),
				},
			},
		},
	}
	data, _ := json.Marshal(card)
	return string(data)
}

func BuildFailedCard(title, markdownContent, errorMsg string) string {
	if title == "" {
		title = "Foundry Agent"
	}
	if markdownContent == "" {
		markdownContent = "智能体执行出现异常。"
	}

	card := FeishuCard{
		Schema: "2.0",
		Config: CardConfig{WideScreenMode: true, UpdateMulti: true},
		Header: CardHeader{
			Title:    CardTitle{Tag: "plain_text", Content: fmt.Sprintf("%s · 执行失败", title)},
			Template: "red",
		},
		Body: CardBody{
			Elements: []CardElement{
				MarkdownElement{Tag: "markdown", Content: NormalizeFeishuMarkdown(markdownContent)},
				HrElement{Tag: "hr"},
				MarkdownElement{
					Tag:     "markdown",
					Content: fmt.Sprintf("<font color='red'>❌ 错误信息: %s</font>", errorMsg),
				},
			},
		},
	}
	data, _ := json.Marshal(card)
	return string(data)
}

func BuildPairingSuccessCard(workspaceName string) string {
	card := FeishuCard{
		Schema: "2.0",
		Config: CardConfig{WideScreenMode: true, UpdateMulti: true},
		Header: CardHeader{
			Title:    CardTitle{Tag: "plain_text", Content: "🎉 关联成功"},
			Template: "green",
		},
		Body: CardBody{
			Elements: []CardElement{
				MarkdownElement{
					Tag:     "markdown",
					Content: fmt.Sprintf("**本飞书群已成功绑定至工作区**：`%s`\n\n- 💡 **发起新任务**：在群内 `@机器人 <你的需求或问题>`，机器人将在该话题（Thread）中启动对应的 Agent 会话；\n- 💬 **多轮连续对话**：在已创建的话题（Thread）中直接回复即可继续追问，**无需再次 @ 机器人**。", workspaceName),
				},
			},
		},
	}
	data, _ := json.Marshal(card)
	return string(data)
}
