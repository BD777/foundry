package feishu

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A group thread can follow an Issue: "/issue <goal>" starts one, replies in
// the thread talk to it, "/confirm" confirms the draft criteria shown, and the
// thread is told what happens. Foundry decides what a reply means; this file
// only translates between the thread and the IssueDesk.

// IssueDesk is the Issue workflow as a group thread may use it, always as the
// account the group is bound to and with that account's permissions.
type IssueDesk interface {
	// StartIssue creates an Issue from the goal and starts clarifying it.
	StartIssue(ctx context.Context, workspaceID, userID, goal string) (store.Issue, error)
	// IssueMessage hands a reply in the thread to the Issue: to its
	// clarification, as the answer to its question, or as feedback. It says
	// what happened, for the thread.
	IssueMessage(ctx context.Context, issueID, userID, text string) (string, error)
	// ConfirmIssue confirms the Issue's current draft criteria.
	ConfirmIssue(ctx context.Context, issueID, userID string) (string, error)
	// IssueURL is where the Issue is reviewed on the web.
	IssueURL(issue store.Issue) string
}

const issueCommand = "/issue"

func (m *WSManager) issueDesk() IssueDesk {
	desk, _ := m.dispatcher.(IssueDesk)
	return desk
}

func (m *WSManager) handleNewIssue(ctx context.Context, workspaceID string, client botClient, messageID, chatID, goal string) error {
	desk := m.issueDesk()
	if desk == nil {
		return nil
	}
	userID, refusal := m.boundUser(ctx, workspaceID)
	if refusal != "" {
		_, err := client.ReplyCard(ctx, messageID, BuildIssueCard("无法创建 Issue", refusal, "red"))
		return err
	}
	if strings.TrimSpace(goal) == "" {
		_, err := client.ReplyCard(ctx, messageID, BuildIssueCard("Foundry Issue", "在 /issue 后面写下你想做成的事，例如：/issue 给 README 加上用法说明。", "blue"))
		return err
	}
	issue, err := desk.StartIssue(ctx, workspaceID, userID, goal)
	if err != nil {
		_, replyErr := client.ReplyCard(ctx, messageID, BuildIssueCard("无法创建 Issue", err.Error(), "red"))
		return replyErr
	}
	if _, err := client.ReplyCard(ctx, messageID, BuildIssueCard(
		fmt.Sprintf("%s · %s", issue.ShortID, issue.Title),
		fmt.Sprintf("已创建 Issue，Agent 正在阅读项目、理解目标。之后直接在本话题回复即可（无需再 @）。\n\n[在 Foundry 中查看](%s)", desk.IssueURL(issue)),
		"blue")); err != nil {
		log.Printf("[feishu] failed to reply issue card: %v", err)
	}
	_, marker := issueUpdates(issue, "", "")
	return m.store.SaveFeishuChatThread(ctx, store.FeishuChatThread{
		RootMessageID: messageID, WorkspaceID: workspaceID, ChatID: chatID, IssueID: issue.ID, Reported: marker,
	})
}

func (m *WSManager) handleIssueReply(ctx context.Context, workspaceID string, client botClient, messageID string, thread store.FeishuChatThread, text string) error {
	desk := m.issueDesk()
	if desk == nil {
		return nil
	}
	userID, refusal := m.boundUser(ctx, workspaceID)
	if refusal != "" {
		_, err := client.ReplyCard(ctx, messageID, BuildIssueCard("无法继续", refusal, "red"))
		return err
	}
	var (
		receipt string
		err     error
	)
	if strings.TrimSpace(text) == "/confirm" {
		receipt, err = desk.ConfirmIssue(ctx, thread.IssueID, userID)
	} else {
		receipt, err = desk.IssueMessage(ctx, thread.IssueID, userID, text)
	}
	if err != nil {
		_, replyErr := client.ReplyCard(ctx, messageID, BuildIssueCard("没有转给 Issue", err.Error(), "red"))
		return replyErr
	}
	_, replyErr := client.ReplyCard(ctx, messageID, BuildIssueCard("已收到", receipt, "grey"))
	return replyErr
}

// reportIssue tells the Issue's thread what changed since it was last told,
// reading the Issue as it is now so a late event never rolls the thread back.
func (m *WSManager) reportIssue(ctx context.Context, issueID string) {
	threads, ok := m.store.(store.FeishuIssueThreads)
	desk := m.issueDesk()
	if !ok || desk == nil {
		return
	}
	thread, err := threads.FeishuThreadForIssue(ctx, issueID)
	if err != nil {
		return
	}
	issue, err := m.store.GetIssue(ctx, issueID)
	if err != nil {
		return
	}
	m.mu.RLock()
	bot, active := m.activeBots[thread.WorkspaceID]
	m.mu.RUnlock()
	if !active {
		return
	}
	cards, marker := issueUpdates(issue, thread.Reported, desk.IssueURL(issue))
	if marker == thread.Reported {
		return
	}
	for _, card := range cards {
		if _, err := bot.client.ReplyCard(ctx, thread.RootMessageID, card); err != nil {
			log.Printf("[feishu] failed to report issue %s: %v", issue.ID, err)
			return
		}
	}
	thread.Reported = marker
	if err := m.store.SaveFeishuChatThread(ctx, thread); err != nil {
		log.Printf("[feishu] failed to save issue thread %s: %v", thread.RootMessageID, err)
	}
}

// issueReport is what a thread was last told about its Issue.
type issueReport struct {
	Message string `json:"m,omitempty"`
	Status  string `json:"s,omitempty"`
	Draft   int    `json:"d,omitempty"`
}

// issueUpdates are the cards that bring a thread from what it was last told
// (reported) to the Issue as it is now, and the new marker.
func issueUpdates(issue store.Issue, reported string, url string) ([]string, string) {
	var last issueReport
	_ = json.Unmarshal([]byte(reported), &last)
	next := issueReport{Status: issue.Status}
	if issue.DraftContractRevision != nil && issue.ContractState != "confirmed" {
		next.Draft = *issue.DraftContractRevision
	}
	link := ""
	if url != "" {
		link = fmt.Sprintf("\n\n[在 Foundry 中查看](%s)", url)
	}
	cards := []string{}
	seen := last.Message == ""
	for _, message := range issue.Messages {
		next.Message = message.ID
		if !seen {
			seen = message.ID == last.Message
			continue
		}
		if message.Role != "assistant" || reported == "" {
			continue
		}
		switch {
		case strings.HasPrefix(message.ID, "question_"):
			title, hint := "Agent 需要你决定", "在本话题回复即可回答，Agent 会在同一个候选里继续。"
			body := message.Text
			if question := issue.Question; question != nil && question.ID == message.ID {
				if question.Kind == "permission" {
					title, hint = "Agent 请求你的许可", "回复“同意”或“拒绝”（也可以写下你的条件），Agent 会在同一个候选里继续。"
				}
				for _, option := range question.Options {
					body += "\n- " + option
				}
			}
			cards = append(cards, BuildIssueCard(title, body+"\n\n"+hint, "orange"))
		case strings.HasPrefix(message.ID, "clarify_"):
			cards = append(cards, BuildIssueCard("Agent 回复", message.Text, "blue"))
		default:
			cards = append(cards, BuildIssueCard("执行结果", message.Text, "turquoise"))
		}
	}
	if reported == "" {
		raw, _ := json.Marshal(next)
		return nil, string(raw)
	}
	if next.Draft != 0 && next.Draft != last.Draft {
		cards = append(cards, BuildIssueCard("完成标准草案已更新", fmt.Sprintf("草案第 %d 版已保存。在本话题回复 /confirm 即确认这一版并开始实现；想调整就直接回复。完整内容在 Web 上查看。%s", next.Draft, link), "blue"))
	}
	if next.Status != last.Status {
		switch next.Status {
		case "in_progress":
			cards = append(cards, BuildIssueCard("开始执行", "按已确认的标准在独立的候选里实现。完成后会在这里告诉你。", "blue"))
		case "verifying":
			cards = append(cards, BuildIssueCard("实现完成，等待验收", "请到 Web 检查实际证据和判断，确认后接受。"+link, "turquoise"))
		case "accepted":
			cards = append(cards, BuildIssueCard("已接受", "结果已合入 Workspace。", "green"))
		case "abandoned":
			cards = append(cards, BuildIssueCard("已放弃", "候选与对话保留，不会合入 Workspace。", "grey"))
		case "blocked":
			if reason := issue.BlockedReason; reason != nil && reason.Kind == "system_error" {
				cards = append(cards, BuildIssueCard("执行遇到问题", reason.Message+"\n\n候选文件已保留。在本话题回复即可在同一个候选里重试。", "red"))
			}
		}
	}
	raw, _ := json.Marshal(next)
	return cards, string(raw)
}

// BuildIssueCard is one update about an Issue in its thread.
func BuildIssueCard(title, markdownContent, template string) string {
	card := FeishuCard{
		Schema: "2.0",
		Config: CardConfig{WideScreenMode: true, UpdateMulti: true},
		Header: CardHeader{Title: CardTitle{Tag: "plain_text", Content: title}, Template: template},
		Body: CardBody{Elements: []CardElement{
			MarkdownElement{Tag: "markdown", Content: NormalizeFeishuMarkdown(truncateRunes(markdownContent, 3000))},
		}},
	}
	data, _ := json.Marshal(card)
	return string(data)
}

func truncateRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}
