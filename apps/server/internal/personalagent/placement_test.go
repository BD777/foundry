package personalagent

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/foundry-dev/foundry/apps/server/internal/store"
)

func labels(texts ...string) []store.DeviceLabel {
	out := []store.DeviceLabel{}
	for _, text := range texts {
		label, err := ParseLabel(text)
		if err != nil {
			panic(err)
		}
		out = append(out, label)
	}
	return out
}

func TestLabelsAndNeedsAreNormalized(t *testing.T) {
	got, err := NormalizeLabels([]store.DeviceLabel{{Key: " Network ", Value: " Corp "}, {Key: "network", Value: "corp"}, {Key: "GPU"}})
	if err != nil || !reflect.DeepEqual(got, labels("network:corp", "gpu")) {
		t.Fatalf("NormalizeLabels = %v, %v", got, err)
	}
	for _, bad := range []store.DeviceLabel{{Key: ""}, {Key: "has space"}, {Key: "k", Value: "a:b"}, {Key: "k", Value: "this value is far longer than sixty characters and so it is refused here"}} {
		if _, err := NormalizeLabels([]store.DeviceLabel{bad}); err == nil {
			t.Fatalf("%+v was accepted", bad)
		}
	}
	needs, err := ParseNeeds([]string{"network: corp", "", "Toolchain:Go", "network:corp"})
	if err != nil || !reflect.DeepEqual(needs, labels("network:corp", "toolchain:go")) {
		t.Fatalf("ParseNeeds = %v, %v", needs, err)
	}
	many := make([]string, PlacementNeedsMax+1)
	for i := range many {
		many[i] = "k" + string(rune('a'+i))
	}
	if _, err := ParseNeeds(many); err == nil {
		t.Fatal("too many needs were accepted")
	}
}

// A need matches a label or a detected fact with the same key and value;
// a need without a value takes any value but a "no"; "yes" takes a bare
// label.
func TestNeedsMatchLabelsAndFacts(t *testing.T) {
	laptop := PlaceCandidate{
		Labels: labels("network:corp", "gpu", "files:no"),
		Facts:  []store.DeviceFact{{Key: "toolchain", Value: "go", Source: "toolchain"}, {Key: "os", Value: "macos", Source: "system"}},
	}
	for need, want := range map[string]bool{
		"network:corp": true, "network:home": false, "network": true,
		"toolchain:go": true, "toolchain:node": false, "toolchain": true, "os:macos": true,
		"gpu": true, "gpu:yes": true, "gpu:nvidia": false,
		"files": false, "always-on": false,
	} {
		if got := laptop.Has(labels(need)[0]); got != want {
			t.Errorf("Has(%s) = %v, want %v", need, got, want)
		}
	}
}

func TestPlaceFiltersByNeedsAndRanks(t *testing.T) {
	home := PlaceCandidate{DeviceID: "dev_home", Name: "Home Mac", Online: true, Allowed: true}
	laptop := PlaceCandidate{DeviceID: "dev_laptop", Name: "Work laptop", Online: true, Allowed: true, Labels: labels("network:corp", "toolchain:go")}
	server := PlaceCandidate{DeviceID: "dev_server", Name: "Office server", Online: true, Allowed: true,
		Labels: labels("network:corp"), Facts: []store.DeviceFact{{Key: "always-on", Source: "presence"}}}
	all := []PlaceCandidate{home, laptop, server}

	cases := []struct {
		name       string
		candidates []PlaceCandidate
		needs      []string
		defaultID  string
		want       string
	}{
		{"self-contained work goes to the default place", all, nil, "dev_home", "dev_home"},
		{"the default place may be any allowed computer", all, nil, "dev_laptop", "dev_laptop"},
		{"a need narrows to the computers that have it; always-on wins", all, []string{"network:corp"}, "dev_home", "dev_server"},
		{"every need must be there", all, []string{"network:corp", "toolchain:go"}, "dev_home", "dev_laptop"},
		{"self-contained work leaves an offline default place for an always-on one",
			[]PlaceCandidate{{DeviceID: "dev_home", Name: "Home", Allowed: true}, laptop, server}, nil, "dev_home", "dev_server"},
		{"an offline computer that alone fits is still chosen",
			[]PlaceCandidate{home, {DeviceID: "dev_laptop", Name: "Work laptop", Allowed: true, Labels: labels("network:corp")}}, []string{"network:corp"}, "dev_home", "dev_laptop"},
		{"among equals the more reliably connected one wins",
			[]PlaceCandidate{
				{DeviceID: "dev_a", Name: "A", Online: true, Allowed: true, OnlineShare: &store.DeviceOnlineShare{Ratio: 0.4, ObservedHours: 100}},
				{DeviceID: "dev_b", Name: "B", Online: true, Allowed: true, OnlineShare: &store.DeviceOnlineShare{Ratio: 0.7, ObservedHours: 100}},
			}, []string{}, "dev_home", "dev_b"},
		{"not allowed computers are never chosen",
			[]PlaceCandidate{home, {DeviceID: "dev_laptop", Name: "Work laptop", Online: true, Labels: labels("network:corp")},
				{DeviceID: "dev_shared", Name: "Shared", Online: true, Shared: "shared with Bob", Labels: labels("network:corp")},
				{DeviceID: "dev_vm", Name: "VM", Allowed: true, Labels: labels("network:corp")}},
			[]string{"network:corp"}, "dev_home", "dev_vm"},
		{"a shared computer the person allowed is used when it alone fits",
			[]PlaceCandidate{home, {DeviceID: "dev_shared", Name: "Lab box", Online: true, Allowed: true, Shared: "shared with Bob", Labels: labels("network:corp")}},
			[]string{"network:corp"}, "dev_home", "dev_shared"},
		{"among computers that fit, one nobody else shares wins over an always-on shared one",
			[]PlaceCandidate{home, {DeviceID: "dev_shared", Name: "Lab box", Online: true, Allowed: true, Shared: "shared with Bob",
				Labels: labels("network:corp", "always-on")}, {DeviceID: "dev_laptop", Name: "Work laptop", Allowed: true, Labels: labels("network:corp")}},
			[]string{"network:corp"}, "dev_home", "dev_laptop"},
		{"a shared computer the person made the default place keeps its place",
			[]PlaceCandidate{{DeviceID: "dev_home", Name: "Home Mac", Allowed: true, Labels: labels("always-on")},
				{DeviceID: "dev_shared", Name: "Lab box", Online: true, Allowed: true, Shared: "shared with Bob"}},
			nil, "dev_shared", "dev_shared"},
	}
	for _, tc := range cases {
		needs, err := ParseNeeds(tc.needs)
		if err != nil {
			t.Fatal(err)
		}
		place, err := Place(tc.candidates, needs, tc.defaultID)
		if err != nil || place.DeviceID != tc.want {
			t.Errorf("%s: Place = %+v, %v; want %s", tc.name, place, err, tc.want)
		}
	}
}

func TestNoPlaceSaysWhatIsMissing(t *testing.T) {
	candidates := []PlaceCandidate{
		{DeviceID: "dev_home", Name: "Home Mac", Online: true, Allowed: true, Labels: labels("network:home")},
		{DeviceID: "dev_office", Name: "Office desktop", Allowed: false, Labels: labels("network:corp")},
		{DeviceID: "dev_shared", Name: "Lab box", Shared: "its system account is shared with Bob", Labels: labels("network:corp")},
	}
	_, err := Place(candidates, labels("network:corp"), "dev_home")
	var none *NoPlace
	if !errors.As(err, &none) {
		t.Fatalf("Place = %v, want NoPlace", err)
	}
	if !reflect.DeepEqual(none.Missing, []string{"network:corp"}) || len(none.Computers) != 3 {
		t.Fatalf("NoPlace = %+v", none)
	}
	if gap := none.Computers[0]; gap.NotAllowed != "" || !reflect.DeepEqual(gap.Lacks, []string{"network:corp"}) {
		t.Fatalf("home gap = %+v", gap)
	}
	if gap := none.Computers[1]; gap.NotAllowed == "" || len(gap.Lacks) != 0 {
		t.Fatalf("office gap = %+v: it has the network but is not allowed", gap)
	}
	if gap := none.Computers[2]; !strings.Contains(gap.NotAllowed, "settings do not let you") || !strings.Contains(gap.NotAllowed, "shared with Bob, so only the person can choose it") {
		t.Fatalf("shared gap = %+v", gap)
	}

	// Each need is somewhere, but no one computer has both.
	_, err = Place([]PlaceCandidate{
		{DeviceID: "a", Allowed: true, Labels: labels("network:corp")},
		{DeviceID: "b", Allowed: true, Labels: labels("gpu")},
	}, labels("network:corp", "gpu"), "a")
	if !errors.As(err, &none) || !reflect.DeepEqual(none.Missing, []string{"network:corp", "gpu"}) {
		t.Fatalf("split needs: %v", err)
	}

	if _, err := Place([]PlaceCandidate{{DeviceID: "a"}}, nil, "a"); !errors.Is(err, ErrNoComputer) {
		t.Fatalf("no allowed computer: %v", err)
	}
}

func TestOnlineShare(t *testing.T) {
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	at := func(hoursAgo float64) time.Time { return now.Add(-time.Duration(hoursAgo * float64(time.Hour))) }
	interval := func(from, to float64) store.DevicePresenceInterval {
		return store.DevicePresenceInterval{DeviceID: "d", StartedAt: at(from), LastSeenAt: at(to)}
	}
	if OnlineShare(nil, true, now, OnlineShareWindow) != nil {
		t.Fatal("no history should have no share")
	}
	// Followed for 48 hours, connected 36 of them (overlaps count once).
	share := OnlineShare([]store.DevicePresenceInterval{interval(48, 24), interval(30, 20), interval(10, 0.1)}, true, now, OnlineShareWindow)
	if share == nil || share.ObservedHours != 48 || share.Ratio != 38.0/48 {
		t.Fatalf("share = %+v, want 38/48 of 48 hours", share)
	}
	// History older than the window is cut off; a device online now runs to now.
	share = OnlineShare([]store.DevicePresenceInterval{interval(400, 1)}, true, now, OnlineShareWindow)
	if share.ObservedHours != 168 || share.Ratio != 1 || !DetectedAlwaysOn(share) {
		t.Fatalf("share = %+v, want always on", share)
	}
	share = OnlineShare([]store.DevicePresenceInterval{interval(400, 1)}, false, now, OnlineShareWindow)
	if share.Ratio >= 1 || DetectedAlwaysOn(&store.DeviceOnlineShare{Ratio: 1, ObservedHours: 3}) {
		t.Fatalf("a short history is not always on: %+v", share)
	}
}
