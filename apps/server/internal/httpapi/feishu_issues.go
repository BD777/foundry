package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The Server is the IssueDesk of the Feishu bot: a group thread starts,
// clarifies, answers and continues an Issue through the same operations and
// permission rules as the web, as the account the group is bound to.

// viaFeishu marks what a person said in a Feishu thread.
const viaFeishu = "feishu"

// StartIssue creates an Issue from the goal and starts clarifying it with
// the workspace's own Agent.
func (s *Server) StartIssue(ctx context.Context, workspaceID, userID, goal string) (store.Issue, error) {
	st, ok := s.store.(store.EvidenceStore)
	if !ok {
		return store.Issue{}, errors.New("evidence store unavailable")
	}
	runtime, err := s.issueRuntime(ctx, workspaceID)
	if err != nil {
		return store.Issue{}, err
	}
	sum := sha256.Sum256([]byte(workspaceID + "\x00" + userID + "\x00" + goal))
	issue, err := st.CreateIssueIdempotent(ctx, store.CreateIssueInput{WorkspaceID: workspaceID, SourceInput: goal, Runtime: runtime, CreatedByUserID: userID},
		"feishu-"+hex.EncodeToString(sum[:12]))
	if err != nil {
		return store.Issue{}, err
	}
	s.events.Publish("issue_created", issue)
	draft, err := currentDraft(ctx, st, issue)
	if err != nil {
		return issue, err
	}
	updated, _, err := s.queueClarification(ctx, issue.ID, func(st store.EvidenceStore) (store.Issue, store.AgentSession, error) {
		return st.AskClarification(ctx, store.AskClarificationInput{
			IssueID: issue.ID, Revision: draft.Revision, ContentDigest: draft.ContentDigest,
			Message: goal, ChangeReason: "根据原始输入开始澄清，不授权执行。", Via: viaFeishu,
		}, s.feishuActor(ctx, userID), "feishu-start-"+issue.ID)
	})
	if err != nil {
		return issue, fmt.Errorf("the Issue was created, but clarification could not start: %w", err)
	}
	return updated, nil
}

// IssueMessage hands a reply in the Issue's thread to the Issue.
func (s *Server) IssueMessage(ctx context.Context, issueID, userID, text string) (string, error) {
	issue, err := s.issueInBoundWorkspace(ctx, issueID, userID)
	if err != nil {
		return "", err
	}
	key := "feishu-" + messageKey(issueID, text, issue.UpdatedLabel, len(issue.Messages))
	switch {
	case issue.Status == "accepted" || issue.Status == "abandoned":
		return "", errors.New("这个 Issue 已经结束，不再接受新的消息；需要的话请发起新的 /issue。")
	case issue.Question != nil && issue.Status == "blocked":
		if !s.mayDecide(ctx, issue, userID) {
			return "", errors.New("只有 Issue 的发起人或 Workspace 维护者可以回答 Agent 的问题。")
		}
		executions, ok := s.store.(store.IssueExecutionStore)
		if !ok {
			return "", errors.New("issue store unavailable")
		}
		unlock := s.lockIssueMutation(issue.ID)
		updated, err := executions.AnswerIssueQuestion(ctx, issue.ID, issue.Question.ID, text, viaFeishu)
		unlock()
		if err != nil {
			return "", err
		}
		s.events.Publish("issue_updated", updated)
		go s.hub.DispatchReady()
		return "已作为回答交给 Agent，它会在同一个候选里继续。", nil
	case issue.ContractState != "confirmed":
		st, _ := s.store.(store.EvidenceStore)
		draft, err := currentDraft(ctx, st, issue)
		if err != nil {
			return "", err
		}
		_, _, err = s.queueClarification(ctx, issue.ID, func(st store.EvidenceStore) (store.Issue, store.AgentSession, error) {
			return st.AskClarification(ctx, store.AskClarificationInput{
				IssueID: issue.ID, Revision: draft.Revision, ContentDigest: draft.ContentDigest,
				Message: text, ChangeReason: "飞书话题补充：" + truncateText(text, 1000), Via: viaFeishu,
			}, s.feishuActor(ctx, userID), key)
		})
		if err != nil {
			return "", err
		}
		return "已转给澄清 Agent，回复稍后出现在本话题。", nil
	case issue.Status == "in_progress":
		return "", errors.New("Agent 正在执行。等这一轮结束、出现结果或问题后再回复。")
	default:
		unlock := s.lockIssueMutation(issue.ID)
		updated, err := s.store.RequestIssueChanges(ctx, issue.ID, text, "", viaFeishu)
		unlock()
		if err != nil {
			return "", err
		}
		s.events.Publish("issue_updated", updated)
		go s.hub.DispatchReady()
		return "已作为反馈交给 Agent，它会在同一个候选里继续修改。", nil
	}
}

// ConfirmIssue confirms the Issue's current draft criteria, as the web's
// "Confirm criteria and start" does.
func (s *Server) ConfirmIssue(ctx context.Context, issueID, userID string) (string, error) {
	issue, err := s.issueInBoundWorkspace(ctx, issueID, userID)
	if err != nil {
		return "", err
	}
	if !s.mayDecide(ctx, issue, userID) {
		return "", errors.New("只有 Issue 的发起人或 Workspace 维护者可以确认完成标准。")
	}
	st, ok := s.store.(store.EvidenceStore)
	if !ok {
		return "", errors.New("evidence store unavailable")
	}
	draft, err := currentDraft(ctx, st, issue)
	if err != nil {
		return "", err
	}
	if issue.Clarification != nil && issue.Clarification.Status == "replying" {
		return "", errors.New("澄清 Agent 还在回复，等它回复后再确认。")
	}
	unlock := s.lockIssueMutation(issue.ID)
	_, err = st.ConfirmContract(ctx, issue.ID, draft.Revision, draft.ContentDigest, s.feishuActor(ctx, userID), fmt.Sprintf("feishu-confirm-%s-%d", issue.ID, draft.Revision))
	unlock()
	if err != nil {
		return "", err
	}
	if updated, err := s.store.GetIssue(ctx, issue.ID); err == nil {
		s.events.Publish("issue_updated", updated)
	}
	go s.hub.DispatchReady()
	return fmt.Sprintf("已确认完成标准第 %d 版，开始实现。", draft.Revision), nil
}

// IssueURL is the Issue's page on the web.
func (s *Server) IssueURL(issue store.Issue) string {
	origin := strings.TrimRight(s.options.AllowedOrigin, "/")
	if origin == "" {
		return ""
	}
	return origin + "/issues/" + url.PathEscape(issue.ID) + "?workspace=" + url.QueryEscape(issue.WorkspaceID)
}

func (s *Server) issueInBoundWorkspace(ctx context.Context, issueID, userID string) (store.Issue, error) {
	issue, err := s.store.GetIssue(ctx, issueID)
	if err != nil {
		return store.Issue{}, err
	}
	if !s.userHasRole(ctx, userID, issue.WorkspaceID, store.WorkspaceRoleMember) {
		return store.Issue{}, errors.New("绑定这个群的账号已没有在此 Workspace 执行的权限。")
	}
	return issue, nil
}

// mayDecide is the web's rule for confirming criteria and answering: the
// Issue's creator, or a maintainer of its workspace.
func (s *Server) mayDecide(ctx context.Context, issue store.Issue, userID string) bool {
	return userID != "" && userID == issue.CreatedByUserID || s.userHasRole(ctx, userID, issue.WorkspaceID, store.WorkspaceRoleMaintainer)
}

func (s *Server) userHasRole(ctx context.Context, userID, workspaceID, need string) bool {
	ownership, ok := s.store.(store.OwnershipStore)
	if !ok || userID == "" {
		return false
	}
	roles, err := ownership.WorkspaceRolesForUser(ctx, userID)
	return err == nil && roleAtLeast(roles[workspaceID], need)
}

// issueRuntime is the Agent an Issue started from a group uses: the
// workspace's own, Claude first.
func (s *Server) issueRuntime(ctx context.Context, workspaceID string) (string, error) {
	agents, err := s.store.ListAgents(ctx, workspaceID, "")
	if err != nil {
		return "", err
	}
	for _, provider := range []string{"claude", "codex"} {
		for _, agent := range agents {
			if agent.WorkspaceID == workspaceID && agent.Provider == provider && agent.Status != "unavailable" {
				return provider, nil
			}
		}
	}
	return "", errors.New("这个 Workspace 的设备上没有可用的 Claude 或 Codex。")
}

func currentDraft(ctx context.Context, st store.EvidenceStore, issue store.Issue) (store.IssueContract, error) {
	if st == nil || issue.DraftContractRevision == nil {
		return store.IssueContract{}, errors.New("这个 Issue 没有待确认的完成标准草案。")
	}
	records, err := st.ListEvidenceRecords(ctx, issue.ID, "contract")
	if err != nil {
		return store.IssueContract{}, err
	}
	for _, raw := range records {
		var contract store.IssueContract
		if json.Unmarshal(raw, &contract) == nil && contract.Revision == *issue.DraftContractRevision {
			return contract, nil
		}
	}
	return store.IssueContract{}, errors.New("找不到当前的完成标准草案。")
}

// feishuActor records a decision made in a group as the account the group is
// bound to, marked as coming from Feishu.
func (s *Server) feishuActor(ctx context.Context, userID string) store.ActorRef {
	name := userID
	if accounts, ok := s.store.(store.AccountStore); ok {
		if user, err := accounts.GetUser(ctx, userID); err == nil && user.DisplayName != "" {
			name = user.DisplayName
		}
	}
	return store.ActorRef{Kind: "user", ID: userID, DisplayName: name + " (via Feishu)"}
}

// messageKey makes a resent Feishu event idempotent without merging two
// identical messages sent at different points of the conversation.
func messageKey(issueID, text, label string, turns int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%s\x00%d", issueID, text, label, turns)))
	return hex.EncodeToString(sum[:12])
}

func truncateText(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}
