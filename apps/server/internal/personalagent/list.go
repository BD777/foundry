package personalagent

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// The person's list (store.PersonalAgentListItem): what the server checks
// of an item, whoever writes it.

// Bounds on one list item.
const (
	ListItemMaxChars = 200
	ListWhenMaxChars = 60
	// ListContextMax bounds the open items each turn's context shows; the
	// rest are one read_list away.
	ListContextMax = 20
)

// ListItemText checks an item's text: one short line.
func ListItemText(text string) (string, error) {
	text = strings.Join(strings.Fields(text), " ")
	if text == "" {
		return "", fmt.Errorf("item.text is required")
	}
	if utf8.RuneCountInString(text) > ListItemMaxChars {
		return "", fmt.Errorf("item.text is at most %d characters: one short line per thing", ListItemMaxChars)
	}
	return text, nil
}

// ListItemWhen checks when the person said it happens, in their words.
func ListItemWhen(when string) (string, error) {
	when = strings.Join(strings.Fields(when), " ")
	if utf8.RuneCountInString(when) > ListWhenMaxChars {
		return "", fmt.Errorf("item.when is at most %d characters: the person's few words for when", ListWhenMaxChars)
	}
	return when, nil
}

// ListItemStatus checks a status.
func ListItemStatus(status string) error {
	switch status {
	case store.PersonalAgentItemOpen, store.PersonalAgentItemDone, store.PersonalAgentItemDropped:
		return nil
	}
	return fmt.Errorf("item.status must be open, done or dropped")
}

// listLocalLayouts are the clock times an item's at may be written in,
// read in the person's time zone.
var listLocalLayouts = []string{"2006-01-02 15:04", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02T15:04:05"}

// ListItemAt reads an item's time: RFC 3339, or a date and clock time in
// location. "" is no time. It answers the time in UTC as stored.
func ListItemAt(value string, location *time.Location) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	if at, err := time.Parse(time.RFC3339, value); err == nil {
		return at.UTC().Format(time.RFC3339), nil
	}
	for _, layout := range listLocalLayouts {
		if at, err := time.ParseInLocation(layout, value, location); err == nil {
			return at.UTC().Format(time.RFC3339), nil
		}
	}
	return "", fmt.Errorf("item.at must be a time such as 2026-10-15T18:30:00+08:00, or 2026-10-15 18:30 in the person's time zone")
}

// DefaultTimezoneZH is the time zone of a person whose assistant has none
// and whose account speaks Chinese.
const DefaultTimezoneZH = "Asia/Shanghai"

// Location is the person's time zone, for every time the server reads or
// writes for them (reminders, digests, limits, the prompt): the
// assistant's setting; else Asia/Shanghai when the assistant's or the
// account's language is Chinese; else UTC. Accounts carry no time zone of
// their own; the web fills the setting from the browser (FillTimezone).
func Location(settings store.PersonalAgentSettings, accountLocale string) *time.Location {
	if location, ok := loadTimezone(settings.Timezone); ok {
		return location
	}
	if ChosenLanguage(settings, accountLocale) == "zh" {
		if location, ok := loadTimezone(DefaultTimezoneZH); ok {
			return location
		}
	}
	return time.UTC
}

// ValidTimezone is zone trimmed when it is a known IANA time zone, "" when
// it is not.
func ValidTimezone(zone string) string {
	zone = strings.TrimSpace(zone)
	if _, ok := loadTimezone(zone); !ok {
		return ""
	}
	return zone
}

func loadTimezone(zone string) (*time.Location, bool) {
	if zone == "" || zone == "Local" {
		return nil, false
	}
	location, err := time.LoadLocation(zone)
	return location, err == nil
}
