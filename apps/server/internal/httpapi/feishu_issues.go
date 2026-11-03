package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/issues"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
	"github.com/foundry-dev/foundry/apps/server/internal/textcut"
)

// issueDesk is the Feishu bot's IssueDesk: a group thread starts, talks to
// and confirms an Issue through the Issue service, as the account the group
// is bound to, with that account's permissions. It only adapts: who the
// account is, and what the thread is told.
type issueDesk struct{ s *Server }

// viaFeishu marks what a person said in a Feishu thread.
const viaFeishu = "feishu"

// StartIssue creates an Issue from the goal with the workspace's own Agent.
// The message that asked for it keys it: a redelivered message starts it
// once, the same goal asked again starts another.
func (d issueDesk) StartIssue(ctx context.Context, workspaceID, userID, messageID, goal string) (store.Issue, bool, error) {
	runtime, err := d.s.issueRuntime(ctx, workspaceID)
	if err != nil {
		return store.Issue{}, false, err
	}
	created, err := d.s.issueService.Create(ctx, d.actor(ctx, userID, ""), store.CreateIssueInput{WorkspaceID: workspaceID, SourceInput: goal, Runtime: runtime},
		issues.CreateOptions{RequestID: "feishu-issue-" + messageID, InitializeGit: true})
	if err != nil {
		return store.Issue{}, false, err
	}
	if created.ClarifyError != nil {
		return created.Issue, created.GitInitialized, fmt.Errorf("the Issue was created, but clarification could not start: %w", created.ClarifyError)
	}
	return created.Issue, created.GitInitialized, nil
}

// IssueMessage hands a reply in the Issue's thread to the Issue.
func (d issueDesk) IssueMessage(ctx context.Context, issueID, userID, text string) (string, error) {
	issue, role, err := d.boundIssue(ctx, issueID, userID)
	if err != nil {
		return "", err
	}
	route, _, err := d.s.issueService.Message(ctx, d.actor(ctx, userID, role), issue.ID, issues.Message{
		Text: text, Key: "feishu-" + messageKey(issue.ID, text, issue.UpdatedLabel, len(issue.Messages)),
		ChangeReason: "飞书话题补充：" + textcut.Excerpt(text, 1000),
	})
	switch {
	case errors.Is(err, issues.ErrClosed):
		return "", errors.New("这个 Issue 已经结束，不再接受新的消息；需要的话请发起新的 /issue。")
	case errors.Is(err, issues.ErrExecuting):
		return "", errors.New("Agent 正在执行。等这一轮结束、出现结果或问题后再回复。")
	case errors.Is(err, issues.ErrMayNotDecide):
		return "", errors.New("只有 Issue 的发起人或 Workspace 维护者可以回答 Agent 的问题。")
	case err != nil:
		return "", err
	}
	switch route {
	case issues.RouteStatus:
		return "已在本话题回复当前进展。", nil
	case issues.RouteAnswer:
		return "已作为回答交给 Agent，它会在同一个候选里继续。", nil
	case issues.RouteClarify:
		return "已转给澄清 Agent，回复稍后出现在本话题。", nil
	default:
		return "已作为反馈交给 Agent，它会在同一个候选里继续修改。", nil
	}
}

// ConfirmIssue confirms the Issue's current draft criteria, as the web's
// "Confirm criteria and start" does.
func (d issueDesk) ConfirmIssue(ctx context.Context, issueID, userID string) (string, error) {
	issue, role, err := d.boundIssue(ctx, issueID, userID)
	if err != nil {
		return "", err
	}
	if !issues.MayDecide(issue, userID, role) {
		return "", errors.New("只有 Issue 的发起人或 Workspace 维护者可以确认完成标准。")
	}
	if issue.DraftContractRevision == nil {
		return "", errors.New("这个 Issue 没有待确认的完成标准草案。")
	}
	draft, err := d.s.store.ContractByRevision(ctx, issue.ID, *issue.DraftContractRevision)
	if err != nil {
		return "", err
	}
	if _, err := d.s.issueService.Confirm(ctx, d.actor(ctx, userID, role), issue.ID, draft.Revision, draft.ContentDigest,
		fmt.Sprintf("feishu-confirm-%s-%d", issue.ID, draft.Revision)); err != nil {
		return "", err
	}
	return fmt.Sprintf("已确认完成标准第 %d 版，开始实现。", draft.Revision), nil
}

// IssueURL is the Issue's page on the web.
func (d issueDesk) IssueURL(issue store.Issue) string {
	origin := strings.TrimRight(d.s.options.AllowedOrigin, "/")
	if origin == "" {
		return ""
	}
	return origin + "/issues/" + url.PathEscape(issue.ID) + "?workspace=" + url.QueryEscape(issue.WorkspaceID)
}

// boundIssue is the Issue with the bound account's role in its workspace,
// which must let it work there.
func (d issueDesk) boundIssue(ctx context.Context, issueID, userID string) (store.Issue, string, error) {
	issue, err := d.s.store.GetIssue(ctx, issueID)
	if err != nil {
		return store.Issue{}, "", err
	}
	roles, err := d.s.store.WorkspaceRolesForUser(ctx, userID)
	if err != nil {
		return store.Issue{}, "", err
	}
	role := roles[issue.WorkspaceID]
	if userID == "" || !roleAtLeast(role, store.WorkspaceRoleMember) {
		return store.Issue{}, "", errors.New("绑定这个群的账号已没有在此 Workspace 执行的权限。")
	}
	return issue, role, nil
}

// actor records a decision made in a group as the account the group is
// bound to, marked as coming from Feishu.
func (d issueDesk) actor(ctx context.Context, userID, role string) issues.Actor {
	name := userID
	if user, err := d.s.store.GetUser(ctx, userID); err == nil && user.DisplayName != "" {
		name = user.DisplayName
	}
	return issues.Actor{ActorRef: store.ActorRef{Kind: "user", ID: userID, DisplayName: name + " (via Feishu)"}, UserID: userID, Via: viaFeishu, Role: role}
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

// messageKey makes a resent Feishu event idempotent without merging two
// identical messages sent at different points of the conversation.
func messageKey(issueID, text, label string, turns int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%s\x00%d", issueID, text, label, turns)))
	return hex.EncodeToString(sum[:12])
}
