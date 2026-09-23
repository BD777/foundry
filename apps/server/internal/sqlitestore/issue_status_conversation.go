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
		answer := "标准已确认，正在等待设备和执行容量。"
		switch {
		case issue.Status == "accepted":
			answer = "成果已接受并集成到 Workspace，可以查看当时的验收记录。"
		case issue.Status == "abandoned":
			answer = "任务已放弃，对话和候选保留，不会继续执行或集成。"
		case issue.ContractState != "confirmed":
			answer = "正在明确目标与完成标准，还没有确认本次草案，因此不会开始新的实现。请在这里回答问题或调整要求；信息足够后使用“确认标准并开始”。"
		case issue.Status == "in_progress":
			answer = "Agent 正在候选工作区执行已确认的标准。可以提供执行反馈，但普通消息不会改写完成标准。"
		case issue.Status == "verifying":
			answer = "实现已结束，正在等待验收。请查看实际材料与判断；缺少证据或标准未通过时不能接受。"
		case issue.Status == "blocked":
			answer = "任务遇到阻碍，需要处理后继续。"
			if issue.BlockedReason != nil {
				answer += " " + issue.BlockedReason.Message
			}
		}
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
