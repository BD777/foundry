package personalagent

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// AssistantNameMaxChars bounds the assistant's name.
const AssistantNameMaxChars = 40

var clockPattern = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)

// NormalizeSettings checks what the panel saves (§11) and fills what it
// left empty: the policy gets every action, zero limits their defaults,
// every device the person owns an entry. ownedDevices are the person's
// devices; home is the assistant's home device. A limit above its hard cap
// is an error, never silently lowered.
func NormalizeSettings(in store.PersonalAgentSettings, ownedDevices []string, home string) (store.PersonalAgentSettings, error) {
	out := in
	if in.RunDefault != nil {
		if err := ValidateRunPreference(*in.RunDefault); err != nil {
			return in, err
		}
		if in.RunDefault.DeviceID != "" && !contains(ownedDevices, in.RunDefault.DeviceID) {
			return in, fmt.Errorf("default execution computer must belong to the person")
		}
	}
	for role, preference := range in.RoleOverrides {
		if !contains(RunRoles, role) {
			return in, fmt.Errorf("unknown assistant role %q", role)
		}
		if err := ValidateRunPreference(preference); err != nil {
			return in, err
		}
		if preference.DeviceID != "" && !contains(ownedDevices, preference.DeviceID) {
			return in, fmt.Errorf("role execution computer must belong to the person")
		}
	}
	out.AssistantName = strings.TrimSpace(in.AssistantName)
	if utf8.RuneCountInString(out.AssistantName) > AssistantNameMaxChars || strings.ContainsAny(out.AssistantName, "\r\n\t") {
		return in, fmt.Errorf("the assistant's name is at most %d characters on one line", AssistantNameMaxChars)
	}
	out.Language = strings.TrimSpace(in.Language)
	if len(out.Language) > 35 || strings.ContainsAny(out.Language, " \r\n\t") {
		return in, errors.New("language is a language tag such as zh-CN or en")
	}
	out.Timezone = strings.TrimSpace(in.Timezone)
	if out.Timezone != "" {
		if _, err := time.LoadLocation(out.Timezone); err != nil {
			return in, fmt.Errorf("unknown time zone %q", out.Timezone)
		}
	}
	if err := oneOf("speakingStyle", &out.SpeakingStyle, "auto", "plain", "technical"); err != nil {
		return in, err
	}
	if err := oneOf("verbosity", &out.Verbosity, "concise", "detailed"); err != nil {
		return in, err
	}
	if err := oneOf("delegateModel", &out.DelegateModel, "device_default", "same_as_assistant"); err != nil {
		return in, err
	}
	out.ExtraInstructions = strings.TrimSpace(in.ExtraInstructions)
	if utf8.RuneCountInString(out.ExtraInstructions) > ExtraInstructionsMaxChars {
		return in, fmt.Errorf("the extra requests are at most %d characters", ExtraInstructionsMaxChars)
	}
	policy, err := CompletePolicy(in.Policy)
	if err != nil {
		return in, err
	}
	out.Policy = policy
	devices, err := normalizeDevices(in.Devices, ownedDevices, home)
	if err != nil {
		return in, err
	}
	out.Devices = devices
	out.PreferredDeviceID = strings.TrimSpace(in.PreferredDeviceID)
	if out.PreferredDeviceID != "" && !contains(ownedDevices, out.PreferredDeviceID) {
		return in, errors.New("the preferred computer must be one of the person's own")
	}
	defaults := DefaultSettings()
	for _, clock := range []struct {
		name     string
		value    *string
		fallback string
	}{
		{"dailyDigestTime", &out.DailyDigestTime, defaults.DailyDigestTime},
		{"activeHoursStart", &out.ActiveHoursStart, defaults.ActiveHoursStart},
		{"activeHoursEnd", &out.ActiveHoursEnd, defaults.ActiveHoursEnd},
	} {
		if *clock.value = strings.TrimSpace(*clock.value); *clock.value == "" {
			*clock.value = clock.fallback
		}
		if !clockPattern.MatchString(*clock.value) {
			return in, fmt.Errorf("%s is a time of day, HH:MM", clock.name)
		}
	}
	out.Limits, err = NormalizeLimits(in.Limits)
	if err != nil {
		return in, err
	}
	return out, nil
}

func oneOf(name string, value *string, allowed ...string) error {
	if *value = strings.TrimSpace(*value); *value == "" {
		*value = allowed[0]
	}
	if !contains(allowed, *value) {
		return fmt.Errorf("%s must be one of %s", name, strings.Join(allowed, ", "))
	}
	return nil
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

// normalizeDevices keeps one entry per owned device: those sent as sent,
// the others as DeviceSettings decides for a device nobody configured.
func normalizeDevices(sent []store.PersonalAgentDeviceSettings, owned []string, home string) ([]store.PersonalAgentDeviceSettings, error) {
	byID := map[string]store.PersonalAgentDeviceSettings{}
	for _, device := range sent {
		if !contains(owned, device.DeviceID) {
			return nil, fmt.Errorf("%q is not one of the person's computers", device.DeviceID)
		}
		byID[device.DeviceID] = device
	}
	devices := make([]store.PersonalAgentDeviceSettings, 0, len(owned))
	for _, id := range owned {
		device, ok := byID[id]
		if !ok {
			device = DeviceSettings(nil, id, home)
		}
		devices = append(devices, device)
	}
	return devices, nil
}

// DeviceSettings is what the assistant may do on one device: its entry, or
// for a device without one, work everywhere and create only at home.
func DeviceSettings(devices []store.PersonalAgentDeviceSettings, deviceID, home string) store.PersonalAgentDeviceSettings {
	for _, device := range devices {
		if device.DeviceID == deviceID {
			return device
		}
	}
	return store.PersonalAgentDeviceSettings{DeviceID: deviceID, AllowWork: true, AllowCreate: deviceID == home}
}

// NormalizeLimits fills zero limits with their defaults and refuses
// negative ones and those above their hard caps (§9).
func NormalizeLimits(in store.PersonalAgentLimits) (store.PersonalAgentLimits, error) {
	out := in
	fields := []struct {
		name          string
		value         *int
		fallback, cap int
	}{
		{"concurrentSessions", &out.ConcurrentSessions, DefaultLimits.ConcurrentSessions, LimitCaps.ConcurrentSessions},
		{"dailySessions", &out.DailySessions, DefaultLimits.DailySessions, LimitCaps.DailySessions},
		{"dailyWorkspaces", &out.DailyWorkspaces, DefaultLimits.DailyWorkspaces, LimitCaps.DailyWorkspaces},
		{"weeklyWorkspaces", &out.WeeklyWorkspaces, DefaultLimits.WeeklyWorkspaces, LimitCaps.WeeklyWorkspaces},
		{"hourlyTurns", &out.HourlyTurns, DefaultLimits.HourlyTurns, LimitCaps.HourlyTurns},
		{"dailyDigestSessions", &out.DailyDigestSessions, DefaultLimits.DailyDigestSessions, LimitCaps.DailyDigestSessions},
		{"stuckAfterMinutes", &out.StuckAfterMinutes, DefaultLimits.StuckAfterMinutes, LimitCaps.StuckAfterMinutes},
	}
	for _, field := range fields {
		switch {
		case *field.value < 0:
			return in, fmt.Errorf("%s cannot be negative", field.name)
		case *field.value == 0:
			*field.value = field.fallback
		case field.cap > 0 && *field.value > field.cap:
			return in, fmt.Errorf("%s is at most %d", field.name, field.cap)
		}
	}
	if out.MonthlyTokenBudget < 0 {
		return in, errors.New("monthlyTokenBudget cannot be negative; 0 means no budget")
	}
	return out, nil
}

// LanguageOf is the language the assistant speaks to the person: its
// setting, else the account's; "zh" or "en".
func LanguageOf(settings store.PersonalAgentSettings, accountLocale string) string {
	return ReplyLanguage(ChosenLanguage(settings, accountLocale), "")
}

// ChosenLanguage is the language the person chose, in the assistant's
// settings or else their account: "zh" or "en", "" when they chose none.
func ChosenLanguage(settings store.PersonalAgentSettings, accountLocale string) string {
	tag := strings.ToLower(settings.Language)
	if tag == "" {
		tag = strings.ToLower(accountLocale)
	}
	switch {
	case tag == "":
		return ""
	case strings.HasPrefix(tag, "zh"):
		return "zh"
	}
	return "en"
}

// ReplyLanguage is the language to answer a message in where there is no
// browser to ask (Feishu): the chosen one (ChosenLanguage), else the one
// the message is written in, else Chinese.
func ReplyLanguage(chosen, message string) string {
	if chosen != "" {
		return chosen
	}
	if written := WrittenLanguage(message); written != "" {
		return written
	}
	return "zh"
}

// WrittenLanguage is the language text is written in: "zh" when it has any
// Chinese characters, "en" when it has Latin letters and none, else "".
func WrittenLanguage(text string) string {
	latin := false
	for _, r := range text {
		if unicode.Is(unicode.Han, r) {
			return "zh"
		}
		if unicode.In(r, unicode.Latin) {
			latin = true
		}
	}
	if latin {
		return "en"
	}
	return ""
}
