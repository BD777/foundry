package externalaccounts

// The scopes a Foundry Feishu login asks for. Agents reach Feishu through
// feishu-cli and the workspace's feishu-cli-* skills (docs, data, storage,
// messaging, mail, meetings, work, visual, platform), which together cover
// every feishu-cli domain; so the preset is what feishu-cli itself asks for
// with `auth login --recommend` (every domain, recommended scopes only).
//
// Source: feishu-cli v1.41.0 (riba2534/feishu-cli 745592c), embedded scope
// registry: registry.CollectDomainScopes(KnownDomainNames(), true) with
// FEISHU_CLI_REMOTE_META=off. "Recommended" there is the set its registry
// marks auto-approve (scope_priorities.json recommend=true plus
// scope_overrides.json allow). Regenerate when feishu-cli is upgraded.
// This is feishu-cli's list, not a Feishu catalogue of every scope.

// FeishuPresetName names the preset in the API and the UI.
const FeishuPresetName = "feishu-cli-recommended"

// FeishuPresetSource says where the preset comes from.
const FeishuPresetSource = "feishu-cli v1.41.0 auth login --recommend (all domains), plus scopes the feishu-cli-* skills request by name"

// feishuRecommendedScopes: feishu-cli v1.41.0 `auth login --recommend`.
var feishuRecommendedScopes = []string{
	"approval:approval:read", "approval:instance:read", "approval:instance:write", "approval:task:read",
	"approval:task:write", "base:app:copy", "base:app:create", "base:app:read", "base:app:update",
	"base:dashboard:create", "base:dashboard:delete", "base:dashboard:read", "base:dashboard:update",
	"base:field:create", "base:field:delete", "base:field:read", "base:field:update", "base:form:create",
	"base:form:delete", "base:form:read", "base:form:update", "base:history:read", "base:record:create",
	"base:record:delete", "base:record:read", "base:record:update", "base:role:create", "base:role:delete",
	"base:role:read", "base:role:update", "base:table:create", "base:table:delete", "base:table:read",
	"base:table:update", "base:view:read", "base:view:write_only", "base:workflow:create", "base:workflow:read",
	"base:workflow:update", "board:whiteboard:node:create", "board:whiteboard:node:delete",
	"board:whiteboard:node:read", "calendar:calendar.event:create", "calendar:calendar.event:delete",
	"calendar:calendar.event:read", "calendar:calendar.event:update", "calendar:calendar.free_busy:read",
	"calendar:calendar:create", "calendar:calendar:delete", "calendar:calendar:read",
	"calendar:calendar:update", "contact:user.base:readonly", "contact:user.basic_profile:readonly",
	"contact:user:search", "docs:document.comment:create", "docs:document.comment:delete",
	"docs:document.comment:read", "docs:document.comment:update", "docs:document.comment:write_only",
	"docs:document.content:read", "docs:document.media:download", "docs:document.media:upload",
	"docs:document:copy", "docs:document:export", "docs:document:import", "docs:event:subscribe",
	"docs:permission.member:auth", "docs:permission.member:create", "docs:permission.member:transfer",
	"docx:document:create", "docx:document:readonly", "docx:document:write_only",
	"drive:drive.metadata:readonly", "drive:file:download", "drive:file:upload",
	"drive:file:view_record:readonly", "im:chat.members:bot_access", "im:chat.members:read",
	"im:chat.members:write_only", "im:chat:read", "im:chat:update", "im:message",
	"im:message.group_msg:get_as_user", "im:message.p2p_msg:get_as_user", "im:message.p2p_msg:readonly",
	"im:message.pins:read", "im:message.pins:write_only", "im:message.reactions:read",
	"im:message.reactions:write_only", "im:message:readonly", "mail:event", "mail:user_mailbox.folder:read",
	"mail:user_mailbox.mail_contact:read", "mail:user_mailbox.mail_contact:write",
	"mail:user_mailbox.message.address:read", "mail:user_mailbox.message.body:read",
	"mail:user_mailbox.message.subject:read", "mail:user_mailbox.message:modify",
	"mail:user_mailbox.message:readonly", "mail:user_mailbox.message:send", "mail:user_mailbox:readonly",
	"minutes:minute:download", "minutes:minutes.artifacts:read", "minutes:minutes.basic:read",
	"minutes:minutes.media:export", "minutes:minutes.search:read", "minutes:minutes.transcript:export",
	"minutes:minutes:readonly", "search:docs:read", "search:message", "sheets:spreadsheet.meta:read",
	"sheets:spreadsheet.meta:write_only", "sheets:spreadsheet:create", "sheets:spreadsheet:read",
	"sheets:spreadsheet:write_only", "slides:presentation:create", "slides:presentation:read",
	"slides:presentation:update", "slides:presentation:write_only", "space:document:delete",
	"space:document:move", "space:folder:create", "task:comment:write", "task:task:read", "task:task:write",
	"task:tasklist:read", "task:tasklist:write", "vc:meeting", "vc:meeting.meetingevent:read",
	"vc:meeting.search:read", "vc:note:read", "vc:record:readonly", "wiki:member:create",
	"wiki:member:retrieve", "wiki:member:update", "wiki:node:copy", "wiki:node:create", "wiki:node:move",
	"wiki:node:read", "wiki:node:retrieve", "wiki:node:update", "wiki:space:read", "wiki:space:retrieve",
}

// feishuSkillScopes are named by the feishu-cli-* skills (`auth login
// --scope …`) and sit in feishu-cli's auto-approve set, but outside the
// recommended list above.
var feishuSkillScopes = []string{"im:chat:create"}

// feishuApprovalScopes are named by the feishu-cli-* skills but are
// outside feishu-cli's auto-approve set: a tenant administrator may have to
// approve them, so a login asks for them only when the person opts in.
var feishuApprovalScopes = []string{
	"attendance:task:readonly", "calendar:calendar.event:reply", "mail:user_mailbox.rule:read",
	"mail:user_mailbox.rule:write", "mindnote:node:create", "mindnote:node:read", "search:app",
	"spark:app:read", "spark:app:write",
}

// FeishuPresetScopes is what a login asks for when the person names no
// scopes (offline_access and auth:user.id:read are added on top).
func FeishuPresetScopes(includeApproval bool) []string {
	scopes := append(append([]string(nil), feishuRecommendedScopes...), feishuSkillScopes...)
	if includeApproval {
		scopes = append(scopes, feishuApprovalScopes...)
	}
	return scopes
}
