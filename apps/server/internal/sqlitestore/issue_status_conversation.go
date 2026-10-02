package sqlitestore

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// A status question appends dialogue only. It never dispatches, confirms or changes standards.
func (s *Store) RecordIssueStatusQuestion(ctx context.Context, issueID, message, requestID string) (store.Issue, error) {
	var result store.Issue
	if strings.TrimSpace(message) == "" || len(message) > 1000 {
		return result, fmt.Errorf("status_question_required")
	}
	err := s.evidenceRequest(ctx, issueID+"/status-question", requestID, message, func(tx *Store) (any, error) {
		issue, err := tx.GetIssue(ctx, issueID)
		if err != nil {
			return nil, err
		}
		answer := issueStatusAnswer(issue, writtenInChinese(message))
		now := evidenceNow()
		issue.Messages = append(issue.Messages,
			store.IssueConversationMessage{ID: evidenceID("status_question"), Role: "user", Text: message, CreatedAt: now},
			store.IssueConversationMessage{ID: evidenceID("status_answer"), Role: "assistant", Text: answer, CreatedAt: now})
		if err := tx.saveIssue(ctx, issue, time.Time{}, time.Now().UTC()); err != nil {
			return nil, err
		}
		return issue, nil
	}, &result)
	return result, err
}

// issueStatusAnswer describes where the Issue stands, in the language of the question.
func issueStatusAnswer(issue store.Issue, chinese bool) string {
	say := func(zh, en string) string {
		if chinese {
			return zh
		}
		return en
	}
	switch {
	case issue.Status == "accepted":
		return say("成果已接受并集成到 Workspace，可以查看当时的验收记录。",
			"The result was accepted and integrated into the Workspace; its acceptance record is available.")
	case issue.Status == "abandoned":
		return say("任务已放弃，对话和候选保留，不会继续执行或集成。",
			"The Issue was abandoned. The conversation and candidate are kept; nothing more runs or integrates.")
	case issue.ContractState != "confirmed":
		return say("正在明确目标与完成标准，还没有确认本次草案，因此不会开始新的实现。请在这里回答问题或调整要求；信息足够后使用“确认标准并开始”。",
			"The goal and completion criteria are still being worked out; this draft is not confirmed, so no implementation starts. Answer questions or adjust the request here, then use “Confirm criteria and start”.")
	case issue.Status == "in_progress":
		return say("Agent 正在候选工作区执行已确认的标准。可以提供执行反馈，但普通消息不会改写完成标准。",
			"The Agent is working on the confirmed criteria in the candidate workspace. You can give feedback; ordinary messages do not rewrite the criteria.")
	case issue.Status == "verifying":
		return say("实现已结束，正在等待验收。请查看实际材料与判断；缺少证据或标准未通过时不能接受。",
			"The implementation is finished and awaits acceptance. Review the actual material and judgments; it cannot be accepted while evidence is missing or a criterion has not passed.")
	case issue.Status == "blocked":
		answer := say("任务遇到阻碍，需要处理后继续。", "The Issue is blocked and needs attention before it continues.")
		if issue.BlockedReason != nil {
			answer += " " + issue.BlockedReason.Message
		}
		return answer
	}
	return say("标准已确认，正在等待设备和执行容量。", "The criteria are confirmed; waiting for a device and execution capacity.")
}
