package feishu

import (
	"context"
	"strings"

	"github.com/foundry-dev/foundry/apps/server/internal/accounts"
	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// HashPairingCode is the only form of a group pairing code that is stored.
// Codes are compared case-insensitively.
func HashPairingCode(code string) string {
	return accounts.HashToken(strings.ToUpper(strings.TrimSpace(code)))
}

// boundUser is the account a group acts as, re-checked on every message: it
// must still be active and at least a member of the workspace. A non-empty
// refusal is shown in the group instead of running anything.
func (m *WSManager) boundUser(ctx context.Context, workspaceID string) (string, string) {
	bot, err := m.store.GetWorkspaceFeishuBot(ctx, workspaceID)
	if err != nil || bot.BoundUserID == "" {
		return "", "这个群还没有绑定到 Foundry 账号。请有权限的成员在 Foundry 重新生成配对码并在群里 /pair。"
	}
	accountStore, accountsOK := m.store.(store.AccountStore)
	ownership, ownershipOK := m.store.(store.OwnershipStore)
	if !accountsOK || !ownershipOK {
		return "", "服务器不支持账号权限，无法执行。"
	}
	user, err := accountStore.GetUser(ctx, bot.BoundUserID)
	if err != nil || !user.Active() {
		return "", "绑定这个群的 Foundry 账号已停用。请有权限的成员重新配对。"
	}
	roles, err := ownership.WorkspaceRolesForUser(ctx, bot.BoundUserID)
	if err != nil {
		return "", "暂时无法确认权限，请稍后重试。"
	}
	switch roles[workspaceID] {
	case store.WorkspaceRoleMember, store.WorkspaceRoleMaintainer, store.WorkspaceRoleOwner:
		return bot.BoundUserID, ""
	}
	return "", "绑定这个群的账号（" + user.DisplayName + "）已没有在此 Workspace 执行的权限。请有权限的成员重新配对。"
}
