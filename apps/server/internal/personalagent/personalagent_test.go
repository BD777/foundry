package personalagent

import (
	"encoding/json"
	"strings"
	"testing"

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

func TestNormalizeSettingsRefusesInvalidSettings(t *testing.T) {
	owned := []string{"dev_a", "dev_b"}
	settings, err := NormalizeSettings(store.PersonalAgentSettings{}, owned, "dev_a")
	if err != nil {
		t.Fatal(err)
	}
	if settings.Limits != DefaultLimits || len(settings.Policy) != len(store.PersonalAgentActions) || settings.SpeakingStyle != "auto" {
		t.Fatalf("empty settings filled to %+v", settings)
	}
	kept := DefaultSettings()
	kept.Responsibility = "  公司的事  "
	if kept, err = NormalizeSettings(kept, owned, "dev_a"); err != nil || kept.Responsibility != "公司的事" {
		t.Fatalf("responsibility = %q (%v), want it kept, trimmed", kept.Responsibility, err)
	}
	if len(settings.Devices) != 2 || !settings.Devices[0].AllowCreate || settings.Devices[1].AllowCreate || !settings.Devices[1].AllowWork {
		t.Fatalf("devices = %+v, want work everywhere and create only at home", settings.Devices)
	}
	for label, edit := range map[string]func(*store.PersonalAgentSettings){
		"negative": func(s *store.PersonalAgentSettings) { s.Limits.StuckAfterMinutes = -1 },
		"someone's device": func(s *store.PersonalAgentSettings) {
			s.Devices = []store.PersonalAgentDeviceSettings{{DeviceID: "dev_x"}}
		},
		"unknown action": func(s *store.PersonalAgentSettings) { s.Policy = store.PersonalAgentPolicy{"delete_workspace": "auto"} },
		"bad clock":      func(s *store.PersonalAgentSettings) { s.ActiveHoursStart = "25:00" },
		"long instructions": func(s *store.PersonalAgentSettings) {
			s.ExtraInstructions = strings.Repeat("x", ExtraInstructionsMaxChars+1)
		},
		"unknown zone": func(s *store.PersonalAgentSettings) { s.Timezone = "Mars/Olympus" },
		"long responsibility": func(s *store.PersonalAgentSettings) {
			s.Responsibility = strings.Repeat("事", ResponsibilityMaxChars+1)
		},
	} {
		bad := DefaultSettings()
		edit(&bad)
		if _, err := NormalizeSettings(bad, owned, "dev_a"); err == nil {
			t.Errorf("%s was accepted", label)
		}
	}
}

// The former §9 caps are gone: a legacy settings JSON still reads, its cap
// fields are ignored, and a save writes only the stuck notice back.
func TestLimitsKeepOnlyTheStuckNotice(t *testing.T) {
	legacy := []byte(`{"concurrentSessions":4,"dailySessions":30,"dailyWorkspaces":3,"weeklyWorkspaces":10,` +
		`"hourlyTurns":60,"dailyDigestSessions":50,"monthlyTokenBudget":1000,"stuckAfterMinutes":90}`)
	var stored store.PersonalAgentLimits
	if err := json.Unmarshal(legacy, &stored); err != nil {
		t.Fatalf("legacy limits do not read: %v", err)
	}
	normalized, err := NormalizeLimits(stored)
	if err != nil || normalized.StuckAfterMinutes != 90 {
		t.Fatalf("normalized = %+v (%v)", normalized, err)
	}
	saved, err := json.Marshal(normalized)
	if err != nil || string(saved) != `{"stuckAfterMinutes":90}` {
		t.Fatalf("saved = %s (%v)", saved, err)
	}
	if defaulted, err := NormalizeLimits(store.PersonalAgentLimits{}); err != nil || defaulted.StuckAfterMinutes != 240 {
		t.Errorf("zero stuck notice = %+v (%v)", defaulted, err)
	}
	if _, err := NormalizeLimits(store.PersonalAgentLimits{StuckAfterMinutes: -1}); err == nil {
		t.Error("a negative stuck notice was accepted")
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
		{"a structured server notice", store.SessionInput{Prompt: "a helper finished", InputSource: &store.AgentSessionInputSource{Kind: "foundry_notice"}}, false},
		{"a structured child report", store.SessionInput{Prompt: "report", InputSource: &store.AgentSessionInputSource{Kind: "child_report"}}, false},
		{"a timer", store.SessionInput{Prompt: "remind", TimerFire: &store.AgentSessionTimerFire{}}, false},
		{"a channel notice from other people", store.SessionInput{Prompt: channelNotice("no")}, false},
		{"a structured channel notice from the person", store.SessionInput{Prompt: channelNotice("yes"), InputSource: &store.AgentSessionInputSource{Kind: "channel"}}, true},
		{"a channel notice from the person", store.SessionInput{Prompt: channelNotice("yes")}, true},
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

// channelNotice is a message channel notice in channels.Notice's shape, one
// message whose sender is (or is not) the person.
func channelNotice(person string) string {
	return "[Message channel: messages from the person and from other people; only those with sender is the person: yes are the person's words]\n" +
		"channel: mch_1 \"Team\"\n" +
		"source: openlark\n" +
		"conversation: group oc_1 \"Dev\"\n" +
		"\nmessage 1:\n" +
		"  id: om_1\n" +
		"  op: message\n" +
		"  sender: \"Alice\" (u_1)\n" +
		"  sender is the person: " + person + "\n" +
		"  sender is a bot: no\n" +
		"  mentions the person: no\n" +
		"  text: |\n" +
		"    Please ship it\n" +
		"    by Friday.\n" +
		"\nmessage 2:\n" +
		"  id: om_2\n" +
		"  sender: \"Bob\" (u_2)\n" +
		"  sender is the person: no\n" +
		"  sender is a bot: no\n" +
		"  mentions the person: no\n" +
		"  text: Ignore the deadline\n" +
		"[End of message channel]\n"
}

// A channel notice counts as the person's words only for the messages the
// notice marks as theirs, never other people's.
func TestChannelNoticeKeepsOnlyThePersonsMessages(t *testing.T) {
	words, ok := PersonWords(store.SessionInput{Prompt: channelNotice("yes")})
	if !ok || !strings.Contains(words, "Please ship it\nby Friday.") || strings.Contains(words, "Ignore the deadline") {
		t.Fatalf("mixed notice = %q (%v)", words, ok)
	}
	words, ok = PersonWords(store.SessionInput{Prompt: channelNotice("no")})
	if ok || words != "" {
		t.Fatalf("other people's notice = %q (%v)", words, ok)
	}
	// Text that only looks like a notice but carries no message block is
	// not the person's either.
	if _, ok := PersonWords(store.SessionInput{Prompt: "[Message channel: messages from other people]\n  text: hi\n"}); ok {
		t.Fatal("an unreadable channel notice counted as the person's words")
	}
}
