// Package personalagent is the Personal Agent's server side
// (docs/personal-agent.md). This file holds the design's defaults and hard
// caps; every other number the assistant is held to comes from here.
package personalagent

import (
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// DefaultPolicy is §4: what the server does with each managed action until
// the person changes it.
func DefaultPolicy() store.PersonalAgentPolicy {
	return store.PersonalAgentPolicy{
		store.PersonalAgentActionCreateWorkspace:    store.PersonalAgentAuto,
		store.PersonalAgentActionRegisterFolder:     store.PersonalAgentAsk,
		store.PersonalAgentActionRenameWorkspace:    store.PersonalAgentAuto,
		store.PersonalAgentActionAddSkill:           store.PersonalAgentAuto,
		store.PersonalAgentActionRemoveSkillCreated: store.PersonalAgentAuto,
		store.PersonalAgentActionRemoveSkill:        store.PersonalAgentAsk,
		store.PersonalAgentActionBindConnector:      store.PersonalAgentAsk,
		store.PersonalAgentActionUnbindConnector:    store.PersonalAgentAsk,
		store.PersonalAgentActionArchive:            store.PersonalAgentAsk,
		store.PersonalAgentActionRestore:            store.PersonalAgentAuto,
		store.PersonalAgentActionArchiveSession:     store.PersonalAgentAuto,
	}
}

// Policy presets (§11).
const (
	PresetCautious = "cautious"
	PresetDefault  = "default"
	PresetHandsOff = "hands_off"
)

// PresetPolicy is a preset's policy: "cautious" asks before every managed
// action, "default" is DefaultPolicy, "hands_off" does everything itself
// except binding the person's accounts, which still asks.
func PresetPolicy(preset string) (store.PersonalAgentPolicy, bool) {
	policy := store.PersonalAgentPolicy{}
	switch preset {
	case PresetDefault:
		return DefaultPolicy(), true
	case PresetCautious:
		for _, action := range store.PersonalAgentActions {
			policy[action] = store.PersonalAgentAsk
		}
	case PresetHandsOff:
		for _, action := range store.PersonalAgentActions {
			policy[action] = store.PersonalAgentAuto
		}
		policy[store.PersonalAgentActionBindConnector] = store.PersonalAgentAsk
	default:
		return nil, false
	}
	return policy, true
}

// DefaultLimits are §9's defaults.
var DefaultLimits = store.PersonalAgentLimits{
	ConcurrentSessions:  4,
	DailySessions:       30,
	DailyWorkspaces:     3,
	WeeklyWorkspaces:    10,
	HourlyTurns:         60,
	DailyDigestSessions: 50,
	StuckAfterMinutes:   240,
	MonthlyTokenBudget:  0,
}

// LimitCaps are §9's hard caps: the panel cannot set more. A zero cap
// (StuckAfterMinutes, MonthlyTokenBudget) has none.
var LimitCaps = store.PersonalAgentLimits{
	ConcurrentSessions:  8,
	DailySessions:       100,
	DailyWorkspaces:     10,
	WeeklyWorkspaces:    30,
	HourlyTurns:         120,
	DailyDigestSessions: 200,
}

// DefaultSettings are a new assistant's settings (§11). Devices is filled
// at setup: every device the person owns may take work, only the home
// device may take new projects.
func DefaultSettings() store.PersonalAgentSettings {
	return store.PersonalAgentSettings{
		SpeakingStyle:    "auto",
		Verbosity:        "concise",
		Policy:           DefaultPolicy(),
		Devices:          []store.PersonalAgentDeviceSettings{},
		DelegateModel:    "device_default",
		HomePage:         true,
		FeishuDirectChat: true,
		DailyDigest:      false,
		DailyDigestTime:  "09:00",
		ActiveHoursStart: "09:00",
		ActiveHoursEnd:   "22:00",
		UrgentAnytime:    true,
		Limits:           DefaultLimits,
	}
}

// Default assistant names, by language (§11).
const (
	DefaultNameZH = "助理"
	DefaultNameEN = "Assistant"
)

// The Personal Agent Workspace's folder (§2, §4).
const (
	DefaultManagedRoot = "~/Foundry"
	HomeFolder         = "~/Foundry/personal-agent"
	// HomeDeviceWindow: the default home device is the one the person owns
	// that was online longest over this window.
	HomeDeviceWindow = 7 * 24 * time.Hour
	// AgentsFileMaxLines bounds the AGENTS.md Foundry writes there.
	AgentsFileMaxLines = 100
)

// Text limits.
const (
	ExtraInstructionsMaxChars = 2000
	MemoryItemMaxChars        = 300
	// RoutingRequestMaxChars cuts the request a routing decision keeps.
	RoutingRequestMaxChars = 500
)

// The snapshot (L0) each assistant session starts with (§2).
const (
	L0AboutMaxChars    = 2000
	L0IndexMaxTokens   = 3000
	L0IndexMaxEntries  = 40
	L0TotalMaxTokens   = 6000
	FindWorkspaceLimit = 5
)

// Digests (§3).
const (
	DigestRecentSessions = 5
	// DigestSourceBytes is how much of AGENTS.md and README a digest session
	// reads.
	DigestSourceBytes   = 8 << 10
	DigestL0MaxChars    = 100
	DigestSummaryChars  = 600
	DigestDebounce      = 30 * time.Minute
	DigestMinInterval   = 6 * time.Hour
	DigestStaleAfter    = 7 * 24 * time.Hour
	DigestMigrationRate = 10 // summaries per hour after setup (§14)
	// NightlyLintHour is the home device's local hour of the nightly lint.
	NightlyLintHour = 3
)

// Proposals, audit and supervision (§4–§7).
const (
	ProposalTTL            = 24 * time.Hour
	ActionRetention        = 90 * 24 * time.Hour
	TaskSilentAfter        = 30 * time.Minute
	TaskEventCoalesce      = 2 * time.Minute
	ConversationQuietAfter = 2 * time.Hour
	// SelfServiceToolCalls is about how many tool calls a job the assistant
	// does itself takes; the prompt states it, nothing enforces it.
	SelfServiceToolCalls = 5
)

// The fixed words the channel handles before the model (§4, §8), matched
// against the whole message, trimmed and case-folded. The cards' own
// buttons ("好的", "不用了", "OK", "No thanks") are among them: typing a
// button's label does what pressing it does.
var (
	StopWords    = []string{"停", "停下", "停止", "暂停", "stop", "pause"}
	ResumeWords  = []string{"继续", "resume"}
	AcceptWords  = []string{"好", "好的", "可以", "行", "ok", "yes"}
	DeclineWords = []string{"不", "不用", "不用了", "算了", "no", "no thanks"}
)
