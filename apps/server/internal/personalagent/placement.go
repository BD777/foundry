package personalagent

import (
	"cmp"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

// Where a new project goes (docs/personal-agent.md §4): no product
// reliably works out by itself that a task needs, say, the company
// network (docs/research/personal-agent-placement.md R3, R7), so the
// owner states it with labels, Foundry adds what it detected, the
// assistant says what the work needs in the same words, and the server
// picks among the computers the person allows. When nothing fits, the
// assistant asks one plain question.

// Label and need limits.
const (
	DeviceLabelsMax   = 24
	PlacementNeedsMax = 8
	labelValueMaxLen  = 60
)

// AlwaysOnShare and AlwaysOnObservedHours: a device connected at least
// this share of at least this many hours counts as always on.
const (
	AlwaysOnShare         = 0.9
	AlwaysOnObservedHours = 24
	// OnlineShareWindow is how far back the online share looks.
	OnlineShareWindow = 7 * 24 * time.Hour
)

var labelKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,39}$`)

// ParseLabel reads "key", "key:value" or "key: value", lower-cased.
func ParseLabel(text string) (store.DeviceLabel, error) {
	key, value, _ := strings.Cut(text, ":")
	return NormalizeLabel(store.DeviceLabel{Key: key, Value: value})
}

// NormalizeLabel trims and lower-cases a label and checks its shape: a key
// of letters, digits, '.', '_' or '-' (at most 40), a value of at most 60
// characters on one line.
func NormalizeLabel(label store.DeviceLabel) (store.DeviceLabel, error) {
	label.Key = strings.ToLower(strings.TrimSpace(label.Key))
	label.Value = strings.ToLower(strings.Join(strings.Fields(label.Value), " "))
	if !labelKeyPattern.MatchString(label.Key) {
		return label, fmt.Errorf("%q is not a label name: use letters, digits, '.', '_' or '-' (at most 40)", label.Key)
	}
	if utf8.RuneCountInString(label.Value) > labelValueMaxLen || strings.ContainsAny(label.Value, ":\r\n\t") {
		return label, fmt.Errorf("the value of %q is at most %d characters on one line, without ':'", label.Key, labelValueMaxLen)
	}
	return label, nil
}

// NormalizeLabels checks the labels an owner saves and drops repeats.
func NormalizeLabels(labels []store.DeviceLabel) ([]store.DeviceLabel, error) {
	out := []store.DeviceLabel{}
	for _, label := range labels {
		normal, err := NormalizeLabel(label)
		if err != nil {
			return nil, err
		}
		if !slices.Contains(out, normal) {
			out = append(out, normal)
		}
	}
	if len(out) > DeviceLabelsMax {
		return nil, fmt.Errorf("at most %d labels per computer", DeviceLabelsMax)
	}
	return out, nil
}

// ParseNeeds reads what create_workspace says the work needs.
func ParseNeeds(texts []string) ([]store.DeviceLabel, error) {
	needs := []store.DeviceLabel{}
	for _, text := range texts {
		if strings.TrimSpace(text) == "" {
			continue
		}
		need, err := ParseLabel(text)
		if err != nil {
			return nil, err
		}
		if !slices.Contains(needs, need) {
			needs = append(needs, need)
		}
	}
	if len(needs) > PlacementNeedsMax {
		return nil, fmt.Errorf("at most %d needs", PlacementNeedsMax)
	}
	return needs, nil
}

// LabelText is a label as the assistant reads and writes it: "key" or
// "key:value".
func LabelText(label store.DeviceLabel) string {
	if label.Value == "" {
		return label.Key
	}
	return label.Key + ":" + label.Value
}

func negative(value string) bool {
	switch value {
	case "no", "false", "off", "none", "0":
		return true
	}
	return false
}

func affirmative(value string) bool {
	switch value {
	case "", "yes", "true", "on", "1":
		return true
	}
	return false
}

// meets reports whether a label or fact (key, value) gives need: the same
// key and value; a need without a value takes any value but a "no"; a
// "yes" need takes a label without a value.
func meets(key, value string, need store.DeviceLabel) bool {
	if key != need.Key {
		return false
	}
	switch {
	case need.Value == "":
		return !negative(value)
	case value == need.Value:
		return true
	}
	return affirmative(need.Value) && affirmative(value)
}

// PlaceCandidate is one of the person's computers as placement sees it.
type PlaceCandidate struct {
	DeviceID string
	Name     string
	Online   bool
	// Allowed: the person's settings let the assistant create here.
	Allowed bool
	// Shared, when set, says who else uses its system account. Such a
	// computer is used only as the person chose it: allowed in their
	// settings (by default only the home, picked at setup) and, among
	// computers that fit as well, only as their default place.
	Shared      string
	Labels      []store.DeviceLabel
	Facts       []store.DeviceFact
	OnlineShare *store.DeviceOnlineShare
}

// Has reports whether the computer gives need, from a label or a fact.
func (c PlaceCandidate) Has(need store.DeviceLabel) bool {
	for _, label := range c.Labels {
		if meets(label.Key, label.Value, need) {
			return true
		}
	}
	for _, fact := range c.Facts {
		if meets(fact.Key, fact.Value, need) {
			return true
		}
	}
	return false
}

// Lacks is what of needs the computer does not give.
func (c PlaceCandidate) Lacks(needs []store.DeviceLabel) []string {
	lacks := []string{}
	for _, need := range needs {
		if !c.Has(need) {
			lacks = append(lacks, LabelText(need))
		}
	}
	return lacks
}

// AlwaysOn: its owner says so, or it was connected nearly all the time.
func (c PlaceCandidate) AlwaysOn() bool {
	return c.Has(store.DeviceLabel{Key: "always-on"})
}

func (c PlaceCandidate) share() float64 {
	if c.OnlineShare == nil {
		return 0
	}
	return c.OnlineShare.Ratio
}

// Placement is where a new project goes and why, in words for the
// assistant.
type Placement struct {
	DeviceID string
	Reason   string
}

// PlaceGap is a computer that does not fit: what it lacks, or why the
// assistant may not use it.
type PlaceGap struct {
	DeviceID string
	Name     string
	Online   bool
	Lacks    []string
	// NotAllowed is set when it has what is needed but the assistant may
	// not create projects there.
	NotAllowed string
}

// NoPlace is why no computer fits: the needs none of the allowed
// computers gives, and each computer's gap.
type NoPlace struct {
	Missing   []string
	Computers []PlaceGap
}

func (n *NoPlace) Error() string {
	return "no computer fits: missing " + strings.Join(n.Missing, ", ")
}

// ErrNoComputer: the person has no computer the assistant may create on.
var ErrNoComputer = errors.New("no computer of the person's allows new projects")

// Place picks the computer for a new project (§4): among the allowed
// candidates, online or not, those that give every need; for
// self-contained work (no needs) the default place first while it is
// online; then those nobody else shares (or the default place), always-on
// ones, online ones, the most reliably connected, the default place, by
// name. With no allowed candidate it answers ErrNoComputer; with
// candidates but none fitting, a *NoPlace.
func Place(candidates []PlaceCandidate, needs []store.DeviceLabel, defaultID string) (Placement, error) {
	fits, allowed := []PlaceCandidate{}, 0
	for _, candidate := range candidates {
		if !candidate.Allowed {
			continue
		}
		allowed++
		if len(candidate.Lacks(needs)) == 0 {
			fits = append(fits, candidate)
		}
	}
	if allowed == 0 && len(needs) == 0 {
		return Placement{}, ErrNoComputer
	}
	if len(fits) == 0 {
		return Placement{}, noPlace(candidates, needs)
	}
	selfContained := len(needs) == 0
	sort.SliceStable(fits, func(i, j int) bool {
		a, b := fits[i], fits[j]
		keys := []struct{ a, b bool }{
			{selfContained && a.DeviceID == defaultID && a.Online, selfContained && b.DeviceID == defaultID && b.Online},
			{a.Shared == "" || a.DeviceID == defaultID, b.Shared == "" || b.DeviceID == defaultID},
			{a.AlwaysOn(), b.AlwaysOn()},
			{a.Online, b.Online},
		}
		for _, key := range keys {
			if key.a != key.b {
				return key.a
			}
		}
		if a.share() != b.share() {
			return a.share() > b.share()
		}
		if (a.DeviceID == defaultID) != (b.DeviceID == defaultID) {
			return a.DeviceID == defaultID
		}
		return cmp.Less(a.Name, b.Name)
	})
	chosen := fits[0]
	return Placement{DeviceID: chosen.DeviceID, Reason: placeReason(chosen, needs, defaultID, len(fits))}, nil
}

func placeReason(chosen PlaceCandidate, needs []store.DeviceLabel, defaultID string, fitting int) string {
	parts := []string{}
	if len(needs) == 0 {
		if chosen.DeviceID == defaultID {
			parts = append(parts, "self-contained work goes to the person's default place")
		} else {
			parts = append(parts, "self-contained work; the default place is offline or not allowed")
		}
	} else {
		texts := make([]string, len(needs))
		for i, need := range needs {
			texts[i] = LabelText(need)
		}
		parts = append(parts, fmt.Sprintf("it has %s", strings.Join(texts, ", ")))
	}
	if fitting > 1 {
		switch {
		case chosen.AlwaysOn():
			parts = append(parts, "it is always on")
		case chosen.Online:
			parts = append(parts, "it is online")
		}
	}
	if !chosen.Online {
		parts = append(parts, "it is offline right now")
	}
	if chosen.Shared != "" {
		parts = append(parts, chosen.Shared+", which the person chose to allow: tell them")
	}
	return strings.Join(parts, "; ")
}

func noPlace(candidates []PlaceCandidate, needs []store.DeviceLabel) *NoPlace {
	result := &NoPlace{Missing: []string{}, Computers: []PlaceGap{}}
	for _, need := range needs {
		given := false
		for _, candidate := range candidates {
			if candidate.Allowed && candidate.Has(need) {
				given = true
				break
			}
		}
		if !given {
			result.Missing = append(result.Missing, LabelText(need))
		}
	}
	if len(result.Missing) == 0 {
		// Every need is somewhere, but no single computer has them all.
		for _, need := range needs {
			result.Missing = append(result.Missing, LabelText(need))
		}
	}
	for _, candidate := range candidates {
		gap := PlaceGap{DeviceID: candidate.DeviceID, Name: candidate.Name, Online: candidate.Online, Lacks: candidate.Lacks(needs)}
		if !candidate.Allowed {
			gap.NotAllowed = "the person's settings do not let you create projects there"
			if candidate.Shared != "" {
				gap.NotAllowed += "; " + candidate.Shared + ", so only the person can choose it"
			}
		}
		result.Computers = append(result.Computers, gap)
	}
	return result
}

// OnlineShare is how much of the window before now the intervals cover,
// over the time since the first of them began (at most window: pass the
// intervals from before it too, so a device followed for longer counts the
// whole window). A device
// online now counts as connected up to now. Nil without any interval.
func OnlineShare(intervals []store.DevicePresenceInterval, onlineNow bool, now time.Time, window time.Duration) *store.DeviceOnlineShare {
	if len(intervals) == 0 {
		return nil
	}
	from := now.Add(-window)
	spans := make([][2]time.Time, 0, len(intervals))
	first := now
	for _, interval := range intervals {
		start, end := interval.StartedAt, interval.LastSeenAt
		if start.Before(first) {
			first = start
		}
		spans = append(spans, [2]time.Time{start, end})
	}
	if onlineNow {
		last := &spans[0]
		for i := range spans {
			if spans[i][0].After(last[0]) {
				last = &spans[i]
			}
		}
		last[1] = now
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i][0].Before(spans[j][0]) })
	if first.Before(from) {
		first = from
	}
	var covered time.Duration
	var reach time.Time
	for _, span := range spans {
		start, end := span[0], span[1]
		if start.Before(first) {
			start = first
		}
		if end.After(now) {
			end = now
		}
		if start.Before(reach) {
			start = reach
		}
		if end.After(start) {
			covered += end.Sub(start)
			reach = end
		}
	}
	observed := now.Sub(first)
	if observed <= 0 {
		return nil
	}
	ratio := float64(covered) / float64(observed)
	return &store.DeviceOnlineShare{Ratio: min(1, ratio), ObservedHours: observed.Hours()}
}

// DetectedAlwaysOn reports whether an online share says always on.
func DetectedAlwaysOn(share *store.DeviceOnlineShare) bool {
	return share != nil && share.ObservedHours >= AlwaysOnObservedHours && share.Ratio >= AlwaysOnShare
}
