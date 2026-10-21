package personalagent

import (
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func TestDecideFollowsThePolicyAndDeniesUnknownActions(t *testing.T) {
	policy := store.PersonalAgentPolicy{store.PersonalAgentActionArchive: store.PersonalAgentAuto}
	if got := Decide(policy, store.PersonalAgentActionArchive); got != store.PersonalAgentAuto {
		t.Errorf("set action = %s", got)
	}
	if got := Decide(policy, store.PersonalAgentActionBindConnector); got != store.PersonalAgentAsk {
		t.Errorf("missing key = %s, want the default ask", got)
	}
	if got := Decide(store.PersonalAgentPolicy{"delete_workspace": store.PersonalAgentAuto}, "delete_workspace"); got != store.PersonalAgentDeny {
		t.Errorf("an action that is never allowed = %s", got)
	}
}

func TestRuleChangesTightenAtOnceAndLoosenByProposal(t *testing.T) {
	policy := DefaultPolicy()
	for _, tc := range []struct {
		action, decision string
		apply            bool
	}{
		{store.PersonalAgentActionRenameWorkspace, store.PersonalAgentAsk, true},
		{store.PersonalAgentActionRenameWorkspace, store.PersonalAgentDeny, true},
		{store.PersonalAgentActionArchive, store.PersonalAgentAuto, false},
		{store.PersonalAgentActionArchive, store.PersonalAgentAsk, true},
	} {
		plan, err := PlanRuleChange(policy, store.PersonalAgentRuleChange{Action: tc.action, Decision: tc.decision})
		if err != nil || plan.Apply != tc.apply || plan.Propose == tc.apply {
			t.Errorf("%s -> %s: %+v %v", tc.action, tc.decision, plan, err)
		}
	}
	if _, err := PlanRuleChange(policy, store.PersonalAgentRuleChange{Action: "share_workspace", Decision: "auto"}); err == nil {
		t.Error("sharing became a rule")
	}
}

func TestPresetsCoverEveryAction(t *testing.T) {
	for _, preset := range []string{PresetCautious, PresetDefault, PresetHandsOff} {
		policy, ok := PresetPolicy(preset)
		if !ok || len(policy) != len(store.PersonalAgentActions) {
			t.Errorf("%s = %v", preset, policy)
		}
	}
}

func TestNormalizeSettingsKeepsLimitsUnderTheirCaps(t *testing.T) {
	owned := []string{"dev_a", "dev_b"}
	settings, err := NormalizeSettings(store.PersonalAgentSettings{}, owned, "dev_a")
	if err != nil {
		t.Fatal(err)
	}
	if settings.Limits != DefaultLimits || len(settings.Policy) != len(store.PersonalAgentActions) || settings.SpeakingStyle != "auto" {
		t.Fatalf("empty settings filled to %+v", settings)
	}
	if len(settings.Devices) != 2 || !settings.Devices[0].AllowCreate || settings.Devices[1].AllowCreate || !settings.Devices[1].AllowWork {
		t.Fatalf("devices = %+v, want work everywhere and create only at home", settings.Devices)
	}
	for label, edit := range map[string]func(*store.PersonalAgentSettings){
		"over a cap": func(s *store.PersonalAgentSettings) { s.Limits.ConcurrentSessions = LimitCaps.ConcurrentSessions + 1 },
		"negative":   func(s *store.PersonalAgentSettings) { s.Limits.DailySessions = -1 },
		"someone's device": func(s *store.PersonalAgentSettings) {
			s.Devices = []store.PersonalAgentDeviceSettings{{DeviceID: "dev_x"}}
		},
		"unknown action": func(s *store.PersonalAgentSettings) { s.Policy = store.PersonalAgentPolicy{"delete_workspace": "auto"} },
		"bad clock":      func(s *store.PersonalAgentSettings) { s.ActiveHoursStart = "25:00" },
		"long instructions": func(s *store.PersonalAgentSettings) {
			s.ExtraInstructions = strings.Repeat("x", ExtraInstructionsMaxChars+1)
		},
		"unknown zone": func(s *store.PersonalAgentSettings) { s.Timezone = "Mars/Olympus" },
	} {
		bad := DefaultSettings()
		edit(&bad)
		if _, err := NormalizeSettings(bad, owned, "dev_a"); err == nil {
			t.Errorf("%s was accepted", label)
		}
	}
}

func TestLimitsRefusePastTheirValue(t *testing.T) {
	limits := DefaultLimits
	if err := CheckNewWorkspace(limits, store.PersonalAgentUsage{WorkspacesToday: 2}); err != nil {
		t.Errorf("below the daily limit: %v", err)
	}
	err := CheckNewWorkspace(limits, store.PersonalAgentUsage{WorkspacesToday: 3})
	if err == nil || !strings.Contains(err.Error(), SettingsPath) {
		t.Errorf("at the daily limit: %v", err)
	}
	if err := CheckNewWorkspace(limits, store.PersonalAgentUsage{WorkspacesThisWeek: 10}); err == nil {
		t.Error("the weekly limit passed")
	}
	if err := CheckDelegate(limits, store.PersonalAgentUsage{ActiveSessions: 4}); err == nil {
		t.Error("the concurrent limit passed")
	}
	if err := CheckDelegate(limits, store.PersonalAgentUsage{TokensThisMonth: 1 << 40}); err != nil {
		t.Errorf("no budget refused: %v", err)
	}
	limits.MonthlyTokenBudget = 1000
	if err := CheckDelegate(limits, store.PersonalAgentUsage{TokensThisMonth: 1000}); err == nil {
		t.Error("the budget passed")
	}
	if err := CheckTurn(store.PersonalAgentLimits{HourlyTurns: 500}, store.PersonalAgentUsage{TurnsThisHour: LimitCaps.HourlyTurns}); err == nil {
		t.Error("a stored limit above the cap was applied")
	}
}

func TestWindowsStartInThePersonsTimeZone(t *testing.T) {
	now := time.Date(2026, 10, 15, 1, 30, 0, 0, time.UTC) // Thursday 09:30 in Shanghai
	windows := Windows(now, Location(store.PersonalAgentSettings{Timezone: "Asia/Shanghai"}, ""))
	if windows.DayStart != "2026-10-14T16:00:00Z" || windows.WeekStart != "2026-10-11T16:00:00Z" ||
		windows.MonthStart != "2026-09-30T16:00:00Z" || windows.HourAgo != "2026-10-15T00:30:00Z" {
		t.Fatalf("windows = %+v", windows)
	}
}

func TestMemoryOriginComesFromThePersonsWords(t *testing.T) {
	for _, tc := range []struct {
		label    string
		input    store.SessionInput
		personal bool
	}{
		{"the person's words", store.SessionInput{Prompt: "I'm vegetarian"}, true},
		{"words with a file", store.SessionInput{Prompt: "I'm vegetarian [file: menu.pdf]", Attachments: []store.ChatAttachment{{ID: "a"}}}, true},
		{"a server notice", store.SessionInput{Prompt: Notice("a helper finished")}, false},
		{"a timer", store.SessionInput{Prompt: "remind", TimerFire: &store.AgentSessionTimerFire{}}, false},
		{"nothing", store.SessionInput{Prompt: "  "}, false},
	} {
		if _, ok := PersonWords(tc.input); ok != tc.personal {
			t.Errorf("%s: the person's words = %v", tc.label, ok)
		}
	}
	if MemoryOrigin(true, true) != store.PersonalAgentMemoryInferred || MemoryOrigin(false, true) != store.PersonalAgentMemoryStated ||
		MemoryOrigin(false, false) != store.PersonalAgentMemoryExternal {
		t.Error("origins do not follow the guess and the quote")
	}
	if MemoryStatus(store.PersonalAgentMemoryExternal) != store.PersonalAgentMemoryPending {
		t.Error("an external fact is active")
	}
}

func TestQuoteGroundedInThePersonsWords(t *testing.T) {
	said := []string{"Hi! I’m vegetarian, and I prefer calls in the MORNING.", "我不吃香菜，谢谢", "ok"}
	for _, tc := range []struct {
		quote string
		want  bool
	}{
		{"I'm vegetarian", true},
		{"  i’m   VEGETARIAN ", true},
		{"ｉ'ｍ ｖｅｇｅｔａｒｉａｎ", true},
		{"I'm vegetarian … calls in the morning", true},
		{"我不吃香菜", true},
		{"不吃香菜。", true},
		{"I am vegetarian", false},
		{"vegetarian and gluten-free", false},
		{"veg", false},
		{"ok", true},
		{"k", false},
		{"I'm vegetarian … always use tabs", false},
		{"…", false},
		{"", false},
	} {
		if got := QuoteGrounded(tc.quote, said); got != tc.want {
			t.Errorf("QuoteGrounded(%q) = %v, want %v", tc.quote, got, tc.want)
		}
	}
}

func TestChannelWordsMatchWholeMessages(t *testing.T) {
	for message, want := range map[string]bool{"停": true, " Stop! ": true, "暂停。": true, "stop the build": false, "停一下吧": false} {
		if IsStop(message) != want {
			t.Errorf("IsStop(%q) = %v", message, !want)
		}
	}
	if !IsResume("继续") || !IsAccept("OK") || !IsDecline("算了") || IsAccept("好的，不过先等等") ||
		!IsDecline("不用了") || !IsDecline("No thanks.") {
		t.Error("resume, accept or decline words")
	}
	if (!strings.Contains(StopReply("zh", 3), "确认停下了 3 项执行") || !strings.Contains(StopReply("zh", 3), "未收到回执")) || !strings.Contains(ProposalSummary("zh", store.PersonalAgentActionArchive, "旧博客"), "『旧博客』收起来") {
		t.Error("fixed replies")
	}
}

func TestReplyLanguage(t *testing.T) {
	for _, c := range []struct{ settings, locale, message, chosen, reply string }{
		{"", "", "停", "", "zh"},
		{"", "", " STOP ", "", "en"},
		{"", "", "123", "", "zh"},
		{"", "en-US", "停", "en", "en"},
		{"", "zh-CN", "stop", "zh", "zh"},
		{"en", "zh-CN", "停", "en", "en"},
		{"", "fr", "停", "en", "en"},
	} {
		chosen := ChosenLanguage(store.PersonalAgentSettings{Language: c.settings}, c.locale)
		if chosen != c.chosen || ReplyLanguage(chosen, c.message) != c.reply {
			t.Errorf("%+v: chosen %q, reply %q", c, chosen, ReplyLanguage(chosen, c.message))
		}
	}
	if LanguageOf(store.PersonalAgentSettings{}, "") != "zh" || LanguageOf(store.PersonalAgentSettings{}, "en") != "en" {
		t.Error("LanguageOf lost its fallback")
	}
}

// Resuming names what the stop cancelled, since none of it restarts.
func TestResumeReplyNamesTheStoppedWork(t *testing.T) {
	if got := ResumeReply("zh-CN", []string{"家庭记账", "云南之旅"}); !strings.Contains(got, "家庭记账、云南之旅") {
		t.Errorf("zh reply = %q", got)
	}
	if got := ResumeReply("en", []string{"Book club website"}); !strings.Contains(got, "Book club website") || !strings.Contains(got, "which ones") {
		t.Errorf("en reply = %q", got)
	}
	if got := ResumeReply("en", nil); strings.Contains(got, "which ones") {
		t.Errorf("nothing was stopped, yet the reply asks which: %q", got)
	}
}

func TestLocationFallsBackByLanguage(t *testing.T) {
	for _, tc := range []struct {
		label    string
		settings store.PersonalAgentSettings
		locale   string
		want     string
	}{
		{"the setting", store.PersonalAgentSettings{Timezone: "Europe/Paris", Language: "zh-CN"}, "zh-CN", "Europe/Paris"},
		{"a Chinese account", store.PersonalAgentSettings{}, "zh-CN", "Asia/Shanghai"},
		{"a Chinese assistant", store.PersonalAgentSettings{Language: "zh"}, "en", "Asia/Shanghai"},
		{"an English account", store.PersonalAgentSettings{}, "en", "UTC"},
		{"no language", store.PersonalAgentSettings{}, "", "UTC"},
		{"an unknown zone", store.PersonalAgentSettings{Timezone: "Mars/Olympus"}, "zh-CN", "Asia/Shanghai"},
	} {
		if got := Location(tc.settings, tc.locale).String(); got != tc.want {
			t.Errorf("%s: %s, want %s", tc.label, got, tc.want)
		}
	}
	if ValidTimezone(" Asia/Tokyo ") != "Asia/Tokyo" || ValidTimezone("Mars/Olympus") != "" || ValidTimezone("") != "" || ValidTimezone("Local") != "" {
		t.Error("ValidTimezone")
	}
}
