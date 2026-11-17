package personalagent

import (
	"net/url"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// SettingsPath is the assistant's settings page (§11).
const SettingsPath = "/assistant/settings"

// AssistantSettingsPath is one assistant's own settings page in the web
// (/assistants/{id}/settings); SettingsPath, the default's alias, without an id.
func AssistantSettingsPath(assistantID string) string {
	if assistantID == "" {
		return SettingsPath
	}
	return "/assistants/" + url.PathEscape(assistantID) + "/settings"
}

// WorkspacePath is a project's own page in the web, where its upkeep and
// suggested file changes are reviewed next to the files (DEV-256).
func WorkspacePath(workspaceID string) string {
	return "/workspace?workspace=" + url.QueryEscape(workspaceID)
}

// EffectiveLimits are the limits the server applies: a zero stuck notice
// is its default.
func EffectiveLimits(limits store.PersonalAgentLimits) store.PersonalAgentLimits {
	if limits.StuckAfterMinutes <= 0 {
		limits.StuckAfterMinutes = DefaultLimits.StuckAfterMinutes
	}
	return limits
}
